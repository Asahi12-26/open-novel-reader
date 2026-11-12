# 阅见 · Open Novel Reader

免费、开源、Local-first 的跨平台小说阅读器。React + TypeScript + Vite PWA，共享 Tauri 2 桌面与移动端外壳。AGPL-3.0-only。

**立即阅读：[打开公开 Web / PWA](https://asahi12-26.github.io/open-novel-reader/)**。导入自己的 TXT / EPUB 即可离线阅读，无需注册。云同步已连接本人测试项目；AI 为可选功能，使用自己的会话密钥并逐次授权。

## 当前版本与下载

**当前版本为 0.4.0-beta.2，Android versionCode 4002。** 阅读页的「章节人物识别 → 整书分析」支持一次授权、按章节自动推进、固定累计预算和断点恢复。原有的逐章识别继续可用。操作见 [整书分析指南](docs/BOOK_ANALYSIS.md)。

当前使用 Supabase 内置团队测试邮件，正式公网注册和完整密码找回暂不开放。已有测试账号可在三个平台登录；自建与配置步骤见 [云服务配置](docs/CLOUD_SETUP.md)。

| 平台 | 本轮状态 | 使用入口 |
| --- | --- | --- |
| Web / PWA | 在线版 | [在线使用](https://asahi12-26.github.io/open-novel-reader/) |
| Windows x64 | 安装包未配置发布者签名 | [下载 EXE](https://github.com/Asahi12-26/open-novel-reader/releases/download/v0.4.0-beta.2/Open-Novel-Reader_0.4.0-beta.2_windows-x64-setup.exe) |
| Android ARM64 | 复用固定发布证书 | [下载 APK](https://github.com/Asahi12-26/open-novel-reader/releases/download/v0.4.0-beta.2/Open-Novel-Reader_0.4.0-beta.2_android-arm64.apk) |
| iOS | 保留共享架构，尚无 IPA 构建 | 需要 macOS 和签名条件 |

发布附件含校验文件和第三方许可。Android 0.2 起沿用固定发布证书，可覆盖安装。仍在使用 Android 0.1 开发签名版的用户，先在旧版导出书库，再安装新版并恢复。安装步骤和版本详情见 [使用指南](docs/USAGE.md)与 [V0.4 Beta 2 发布页](https://github.com/Asahi12-26/open-novel-reader/releases/tag/v0.4.0-beta.2)。

## 现在可以用什么

- 本地导入中文 / 英文 TXT（UTF-8、GB18030、带 BOM 的 UTF-16）和无 DRM 的 EPUB；自动目录、封面、内容指纹去重。
- 动态书海首页：统一相位波浪、距离衰减涟漪、悬停 / 键盘浮起、封面共享展开与反向返回。手机单击进入，支持浅色 / 暖色 / 深色与减少动态效果。
- 段落及字符锚点续读、字号 / 字体 / 行距 / 页宽、目录、书签、离线 PWA、备份导出与验证恢复。
- 书名 / 作者 / 封面编辑、分类、搜索、排序、最近阅读、逐本云端上传选择。
- Supabase 邮箱确认 / 登录、逐书上传、原文件 / 书架 / 进度 / 书签 / 设置同步、断网恢复与账号隔离；本人测试项目已部署，也支持自己的云服务。
- DeepSeek 逐章选择、对白识别、人物归属和结果保存流程；预算估计、每次授权、分片暂停 / 取消 / 断点重试、未知人物、人工纠正、人物新建 / 改名 / 合并。代理已部署，原创短文真实推理及人工确认保存通过，复杂人物质量仍待扩展验证。
- 整书分析支持已读范围和全书范围。任务与预算保存在本机，重启后重新授权即可从检查点继续。阅读页默认隐藏未来身份，人工纠错始终优先。V0.4 的真实整书模型质量待独立评估。 [质量样本与验证](docs/AI_QUALITY.md)

原创短章 Flash 真实推理最小验证通过：完成 1/1 分片，3 句对白全部归属到 2 名人物，0 未知，1 处人工确认重新打开后仍保存。测试结束已清除会话内存密钥；整本书与复杂人物的识别准确率仍待扩展验证，后续收费调用需另行授权。 正式 SMTP 与 Leaked Password Protection 留待开放公网注册前配置；后者当前仅 Pro 及以上套餐支持，本项目保持免费套餐。EPUB 当前按文本阅读，暂不呈现插图、富文本强调或出版商 CSS；不支持 DRM、漫画和固定版式 EPUB。

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

DeepSeek Key **仅保存在本次会话内存**。Web 与原生版经 Supabase Edge Function 转发，刷新、退出或切换账号后需重新输入。「检查代理」无需密钥且不访问 DeepSeek，「测试连接」只查询模型。收费分析须选择单章或整书范围、确认预算并点击授权启动。失败或取消的请求可能计费，软件保留已预留额度，重试须重新授权。预算根据公开价格估算。 [整书分析指南](docs/BOOK_ANALYSIS.md)

## 构建与发布

当前通过 GitHub Releases 手动更新安装包。 [平台构建](docs/BUILD.md) · [版本发布](https://github.com/Asahi12-26/open-novel-reader/releases)

## 代码布局

`src/core`：解析、版本化 IndexedDB、备份；`src/ui`：书架与阅读器交互；`src/services`：独立的同步与 AI；`supabase`：数据库、隔离测试和代理；`src-tauri`：平台外壳；`e2e`：浏览器冒烟测试。

第三方依赖见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，`npm run licenses` 生成依赖许可清单。请勿提交 `.env`、API Key、小说原文、导出的私人备份或签名文件。
