# 阅见 · Open Novel Reader

免费、开源、Local-first 的跨平台小说阅读器。React + TypeScript + Vite PWA，共享 Tauri 2 桌面与移动端外壳。AGPL-3.0-only。

**立即阅读：[打开公开 Web / PWA](https://asahi12-26.github.io/open-novel-reader/)**。导入自己的 TXT / EPUB 即可离线阅读，无需注册。云同步已连接本人测试项目；AI 为可选功能，使用自己的会话密钥并逐次授权。

## 当前版本与下载

**本轮候选版本：0.3.0-beta.1，Android versionCode 3001。** 保留动态书海、阅读器、本地数据库、云同步与固定 Android 签名，完善逐章 AI 识别。真实 `deepseek-proxy` 已部署，登录鉴权和不访问 DeepSeek 的状态检查通过；真实收费推理尚未执行、尚未验证。

当前使用 Supabase 内置团队测试邮件，正式公网注册和完整密码找回暂不开放。已有测试账号可在三个平台登录；自建与配置步骤见 [云服务配置](docs/CLOUD_SETUP.md)。

| 平台 | 本轮状态 | 使用入口 |
| --- | --- | --- |
| Web / PWA | 沿用公开入口，V0.3 部署后更新 | [在线使用](https://asahi12-26.github.io/open-novel-reader/) |
| Windows x64 | V0.3 待本轮构建与发布；0.1 → 0.2 覆盖保留数据已验证 | [V0.3 目标发布页](https://github.com/Asahi12-26/open-novel-reader/releases/tag/v0.3.0-beta.1) |
| Android ARM64 | V0.3 沿用 0.2 固定签名；本人登录通过，原生同步、重启与离线检查进行中 | [V0.3 目标发布页](https://github.com/Asahi12-26/open-novel-reader/releases/tag/v0.3.0-beta.1) |
| iOS | 保留共享架构，尚无 IPA 构建 | 需要 macOS 和签名条件 |

V0.3 链接是发布目标，安装包以发布页实际附件和 `SHA256SUMS.txt` 为准；此处不表示附件已生成。已发布的 [V0.2 Beta](https://github.com/Asahi12-26/open-novel-reader/releases/tag/v0.2.0-beta.1)保留供查阅。Windows 未做发布者签名。**旧 Android 0.1 开发签名与新发布证书不同，不能直接覆盖安装；先在旧版导出书库，再迁移。** 0.2 起后续版本复用同一发布钥匙并递增 versionCode；0.2 → 0.3 真机覆盖升级仍待检查。安装步骤见 [使用指南](docs/USAGE.md)。

本轮已通过 **95 项单元 / 离线测试及 1 项新增 AI 生产浏览器流程**，包括模拟 AI 输出、人工纠错、失败续跑、费用保留和账号切换边界。V0.2 的真实云同步、签名及升级验证历史保留在 [PROJECT_STATUS.md](PROJECT_STATUS.md)；这些结果不代替真实 DeepSeek 推理或本轮原生安装验证。

## 现在可以用什么

- 本地导入中文 / 英文 TXT（UTF-8、GB18030、带 BOM 的 UTF-16）和无 DRM 的 EPUB；自动目录、封面、内容指纹去重。
- 动态书海首页：统一相位波浪、距离衰减涟漪、悬停 / 键盘浮起、封面共享展开与反向返回。手机单击进入，支持浅色 / 暖色 / 深色与减少动态效果。
- 段落及字符锚点续读、字号 / 字体 / 行距 / 页宽、目录、书签、离线 PWA、备份导出与验证恢复。
- 书名 / 作者 / 封面编辑、分类、搜索、排序、最近阅读、逐本云端上传选择。
- Supabase 邮箱确认 / 登录、逐书上传、原文件 / 书架 / 进度 / 书签 / 设置同步、断网恢复与账号隔离；本人测试项目已部署，也支持自己的云服务。
- DeepSeek 逐章选择、对白识别、人物归属和结果保存流程；预算估计、每次授权、分片暂停 / 取消 / 断点重试、未知人物、人工纠正、人物新建 / 改名 / 合并。代理已部署，收费推理质量仍待验证。

Android 本人登录通过，原生同步、重启与离线检查进行中。正式 SMTP 与 Leaked Password Protection 留待开放公网注册前配置；后者当前仅 Pro 及以上套餐支持，本项目保持免费套餐。DeepSeek 的真实收费分析尚未执行，开发没有产生 AI 推理费用。EPUB 当前按文本阅读，保留章节和段落，暂不呈现插图、富文本强调或出版商 CSS；不支持 DRM、漫画和固定版式 EPUB。

## 本地运行

需要 Node.js 22.12+：

```sh
npm ci
npm run dev
```

打开终端显示的 `http://127.0.0.1:1420`。点击「导入书籍」，或拖入自己的 TXT / EPUB。无需登录。空书架可以点击原创示例短篇试读。

```sh
npm test
npm run build
npm run preview -- --port 4173
```

Web 生产版通过 service worker 缓存应用，首次联网缓存后可离线再次打开；原生壳使用安装包资源。个人小说均存于本机 IndexedDB，各平台书库独立。清除网站 / 应用数据会移除书库，建议保留原文件并定期导出备份；当前恢复上限为 256 MiB，分卷导出尚未实现。`npm run dev` 不提供完整 PWA 离线体验。

## 云同步与 AI

复制 `.env.example` 为 `.env.local`，或在应用「设置与云同步」中填写 Supabase URL 和 anon / publishable 公钥。应用拒绝 service-role 密钥。执行迁移、部署 `deepseek-proxy`，参见 [同步与 AI 部署](docs/SYNC_AI.md)。未配置时本地阅读完整可用。

只会上传用户逐本选择的小说。退出账号不删除本机书库；同一台设备供多人使用时，请使用各自独立的浏览器配置或系统账号。

DeepSeek Key **仅保存在本次会话内存**。Web / 原生统一经已配置的 Supabase Edge Function 转发，刷新、退出或切换账号后需重新输入。「检查代理」无需密钥且不访问 DeepSeek；「测试连接」只查询模型。收费分析必须选择章节、勾选授权并点击启动。供应商可能对已发送但失败 / 取消的请求收费，保留的任务额度不会自动退回；软件不自动重试 AI。预算为基于公开价格的保守预检，不能控制供应商改价。

## 构建与发布

参见 [平台构建](docs/BUILD.md)。CI 在 main 更新时执行检查和平台构建，打 `v*` tag 后上传预发布安装包；公开 PWA 由 GitHub Pages 部署。未设置自动二进制更新，当前从 Releases 手动获取新版，更新前先备份。0.2 原生签名构建与 Windows 升级已验证，V0.3 成品状态以本轮 Actions / Release 为准。

## 代码布局

`src/core`：解析、版本化 IndexedDB、备份；`src/ui`：书架与阅读器交互；`src/services`：独立的同步与 AI；`supabase`：数据库、隔离测试和代理；`src-tauri`：平台外壳；`e2e`：浏览器冒烟测试。

第三方依赖见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，`npm run licenses` 生成依赖许可清单。请勿提交 `.env`、API Key、小说原文、导出的私人备份或签名文件。
