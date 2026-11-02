# 云同步与真实 AI 部署

本地阅读无需账号。云端和 AI 必须由部署者配置，界面不会伪装成已联网成功。首次发布未提供任何 API Key，也没有在开发时调用收费模型。

## Supabase

1. 创建你自己的 Supabase 项目，在 SQL 编辑器执行 `supabase/migrations/202611020001_reader.sql`，或使用 Supabase CLI `supabase link --project-ref <ref>` 和 `supabase db push`。
2. 在 Auth 中启用邮箱登录，配置正式站点 URL、允许的重定向 URL、SMTP 和邮箱确认策略。首次注册后可能需要先点确认邮件。
3. 在阅读器设置中填写项目 HTTPS URL 和 **publishable / anon 公钥**；也可构建时设置 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`。绝不能把 service-role/secret key 放进前端。
4. 在两台设备登录同一个账号，在书籍详情明确勾选云同步，再执行同步。第一次会上传原文件、章节文本及这本书的元数据。没有选择的书不会被上传。

`reader_records` 保存版本化书籍包，包含章节、阅读位置、书签、人物、对白、纠错和任务检查点。原文件位于私有 `novel-files/<用户ID>/<书ID>/original.<格式>`；数据库和 Storage 均实施 RLS。`reader_profiles` 只保存阅读偏好与分类。原文、AI 输出、人工纠错分别存于包中不同字段、本地不同表。表与备份都有 schema 版本，可在后续迁移。

同步以本地为主：未联网修改保留在 IndexedDB；手动同步、联网/聚焦后的延迟重试及每分钟在线检查时上传。每个云端书籍包有服务端 revision，写入通过 compare-and-swap RPC 拒绝过期版本；三方合并结合上次快照，保留不同设备新增记录，已有记录的删除优先。书籍 tombstone 永久保留并清除云端正文、对白与书签，防止旧设备误恢复删除项。阅读位置和同项纠错采用修改时间选择；依赖设备时钟一致，复杂并发偏好冲突暂用最后一次写入。失败不会清空本地库。

每个同步操作固定到开始时的用户 JWT，账号/项目切换后停止本次同步，避免在上传中途把前一账号数据写入新账号。下载包严格校验 ID、类型、章节引用、文字范围及来源信息；原文件下载后重新计算 SHA256、重新解析章节，与云端包原文匹配后才原子写入。本地正在阅读或修改书签时产生的新改动不会被在途下载覆盖。进入另一账号会恢复其自己的分类/偏好快照或默认配置，前一账号的本地配置保留在独立快照中，不自动上传给新账号。

关闭某本书同步只阻止后续上传，已经上传的副本仍保留；在仍启用同步时删除书籍并再次同步，才能传播删除与删除原文件。云端书籍与首次选择上传的账号关联，切换账号后不会自动把该账号的小说上传到另一账号。本机离线书库会保留，退出登录不会清除本地文件；共用设备请使用独立系统/浏览器配置。备份 ZIP/JSON 包可能含完整私人小说，应由使用者自行保管。

## DeepSeek 代理

Web 使用已登录的 Supabase Edge Function。客户端 API Key **仅在内存中**，不会写入 IndexedDB、localStorage、备份、同步字段或日志；重新启动需要重新输入。原生版本也采用相同的会话内存策略，当前未实现“记住密钥”的系统钥匙串功能。

运行：

```sh
supabase secrets set ALLOWED_ORIGINS="https://你的站点,http://localhost:1420,http://127.0.0.1:1420,http://tauri.localhost,tauri://localhost"
supabase functions deploy deepseek-proxy
```

函数启用平台 JWT 验证，并额外使用 Supabase `getUser` 验证登录。允许来源为精确白名单；根据 Android WebView 的实际 origin 添加对应项。不要设置通配来源。函数只允许固定 `https://api.deepseek.com/models` 与 `/chat/completions`，拒绝任意代理地址，限制请求体、输出 tokens、模型和单请求保守费用预算。

密钥会随明确操作通过 TLS 发送到**你配置的 Supabase 服务端**，然后作为 Authorization 发送到 DeepSeek。函数只在本次调用内使用、不持久化也不打印。部署者仍须确保反向代理/观测系统不记录请求体；客户端内存策略不能阻止用户安装的不可信扩展或受感染终端读取内存。

“测试连接”只查询 `/models`，不生成文本。点击“授权并分析”才会调用收费生成接口，发送所选章节对白及邻近上下文。不要在用户尚未授权时自动分析或重试；当前实现没有自动收费重试。暂停在当前片段完成后生效，取消会中止本地 fetch；上游已经处理的请求仍可能产生费用。

截至 2026-11-02 官方可用模型为 `deepseek-flash` 与 `deepseek-v4-pro`。程序以峰时缓存未命中价格估计：每百万 input/output tokens 分别 $0.30/$1.20 与 $1.32/$3.96，另加 10% 裕量；使用 UTF-8 字节数保守估输入，输出每片段最多 4096 tokens。每次请求发送前先保留费用额度，即使网络超时也不自动退回预算。达到预算停止，不增加新的请求。服务商未来调价仍需更新两端价表，费用提示不是账单保证；使用者应同时在服务商账户限制充值/支出。报价依据：[DeepSeek 官方价格](https://api-docs.deepseek.com/quick_start/pricing/)。

对白由确定性扫描器创建段落索引和字符范围，模型只能回填已知候选 ID；无法确认或置信度低于 0.75 一律未知。跨章用书籍 ID+规范化名称生成稳定人物 ID；人工纠错单独保留且覆盖未来 AI 结果。可修改人物名称、别名合并和对白归属。当前分析范围为单章；长单条引文（>1800 字符）会跳过，避免不可控任务规模。任务检查点支持在应用内暂停/恢复，失败后需再次授权重试。

## 少量必要验证

`npm test` 包含无需网络的对白定位、低置信度、授权边界、人工纠错与合并冲突测试。`supabase test db` 运行 `supabase/tests/isolation.test.sql`，验证两个账号之间书籍、偏好、文件隔离及过期写入拒绝。

真正的双设备端到端同步与部署环境 RLS 冒烟需要配置真实 Supabase 实例后执行。没有配置时不得把这些检查描述为已经通过。真实收费模型测试需要使用者授权，不会为测试而自动发起。

参考：[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)、[Storage 访问控制](https://supabase.com/docs/guides/storage/security/access-control)、[Edge Function 认证](https://supabase.com/docs/guides/functions/auth)。
