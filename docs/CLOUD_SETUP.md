# V0.3 云服务与 AI 连接

本地阅读始终可用。V0.2 的真实 Supabase 云同步、26 项 SQL 隔离检查、双账号 / 三浏览器、本人确认邮件及电脑 / 手机网页续读结果保留。V0.3 已部署 `deepseek-proxy` 并通过真实登录鉴权与不访问 DeepSeek 的状态检查；95 项单元 / 离线测试通过，真实收费推理尚未执行、尚未验证。Android 0.2 本人登录通过，原生同步、重启与离线检查进行中。[V0.3 目标发布页](https://github.com/Asahi12-26/open-novel-reader/releases/tag/v0.3.0-beta.1)不表示安装包已生成，当前状态见 [项目状态](../PROJECT_STATUS.md)。

## 账号维护者需要操作的部分

1. 本人的专用免费项目已连接并内置到三个平台，无需重复填写公钥。自建用户先连接或创建自己的 Supabase 项目。不要在聊天发送数据库密码、service-role、secret key 或个人访问令牌。
2. 当前按维护者选择使用 Supabase 内置测试邮件，邮箱确认保持开启。请用 Supabase 项目组织成员邮箱在阅读器注册，查收确认邮件后登录；避免反复发送触发限额。正式公网注册与完整密码找回尚不开放，开放前再在 Authentication → Email / SMTP 配置邮件服务。密码和 SMTP 凭据只在供应商或 Supabase 页面填写，不得自动升级套餐。没有正式 SMTP 不影响当前本人账号同步测试。
3. 签名加密备份口令只在本机备份窗口输入，保留该口令和生成的备份文件；不要贴入聊天。建议再将加密备份文件复制到自己的离线介质。
4. AI 无需在 Supabase 保存维护者的 DeepSeek Key：在阅读器登录后先点「检查代理（不调用模型）」，再按需自行载入会话密钥。选择章节并明确授权才分析；不要在聊天发送 Key。目前仅获一次 Flash 原创短文、最多 US$0.02 的测试授权，尚未执行；不会扩大范围或自动重试。

Leaked Password Protection 的控制台告警已检查：[官方文档](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)标明它仅适用于 Pro 及以上套餐。当前免费项目不支持启用，保持免费套餐和邮箱确认；正式开放注册前再决定套餐条件并接入正式 SMTP，不擅自升级。

## 自动配置范围

- 先检查目标项目现状，保留其他表与既有数据；按名称顺序应用 `supabase/migrations/` 中全部四份迁移。数据库与 Storage 都通过 `auth.uid()` 限制为自己的行 / 文件。
- 私有桶 `novel-files`，文件上限 50 MiB；云数据包上限 30 MiB。小说只有明确选择上传后才进入云端。
- Site URL：`https://asahi12-26.github.io/open-novel-reader/`。
- 邮件回调白名单：同一根地址的 `?auth=confirmation` 和 `?auth=recovery`。邮件模板保留默认 `{{ .ConfirmationURL }}`，不要使用 GitHub Pages 不存在的 `/auth/confirm` 路由。
- 三个平台的公开构建参数：`VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`（publishable / anon 公钥）、`VITE_PUBLIC_APP_URL`。当前 `VITE_AUTH_EMAIL_MODE=team-test` 会显示内置邮件测试范围；自行配置正式 SMTP 后可留空。服务端私钥不得打包进前端。
- GitHub 签名只保存为 Actions 加密 Secrets：`ANDROID_KEY_BASE64`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`。脚本在缺失凭据或证书与固定指纹不同的情况下拒绝发布。
- `deepseek-proxy` 已部署且 `verify_jwt=true`，再用 `getUser` 验证非匿名登录用户；精确来源白名单、固定 DeepSeek 地址 / 模型 / 提示、输入输出与估算费用限制均启用。`status` 不需要 AI Key、不向 DeepSeek 发请求。自行部署步骤见 [同步与 AI](SYNC_AI.md)。

## 必要真实验证

在同一账号的独立设备上导入原创测试书，选择上传，再检查另一设备的原文件、分类、章节位置、书签、阅读设置；断网修改后恢复连接，确认合并与续读。在另一账号检查无法读取、修改或下载前一账号的书籍。SQL 的两个账号隔离测试需在真实项目执行，并回滚测试数据；不拿用户私人小说做测试。

Windows 和 Android 最终包必须实际构建。Android 0.1 旧开发签名与新的固定发布签名不同，不能直接覆盖；先在旧版导出书库，保留可恢复备份，再迁移到新版。0.3 沿用 0.2 的发布签名并将 versionCode 从 2001 升至 3001；符合签名与版本升级条件，但覆盖升级仍须用最终包实测。

参考：[Supabase 邮箱密码](https://supabase.com/docs/guides/auth/passwords)、[邮件服务限制](https://supabase.com/docs/guides/auth/auth-smtp)、[回调地址配置](https://supabase.com/docs/guides/auth/redirect-urls)。
