# 阅见 · Open Novel Reader

免费、开源、Local-first 的跨平台小说阅读器。React + TypeScript + Vite PWA，共享 Tauri 2 桌面与移动端外壳。AGPL-3.0-only。

导入 TXT 或无 DRM 的 EPUB 即可开始本地阅读。AI 使用你自己的 DeepSeek API Key。开发者私人云通过服务端白名单授权。 [打开 Web / PWA](https://asahi12-26.github.io/open-novel-reader/)

## 当前版本与下载

**V0.6.1-beta.2** 修复剧情分析因引文位置偏差停住的问题。Android versionCode 为 6012。 [新版安装、备份与 AI 指南](docs/V061_LOCAL_FIRST.md)

| 平台 | 本轮状态 | 使用入口 |
| --- | --- | --- |
| Web / PWA | 在线版 | [在线使用](https://asahi12-26.github.io/open-novel-reader/) |
| Windows x64 | 安装包未配置发布者签名 | [下载 EXE](https://github.com/Asahi12-26/open-novel-reader/releases/download/v0.6.1-beta.2/Open-Novel-Reader_0.6.1-beta.2_windows-x64-setup.exe) |
| Android ARM64 | 复用固定发布证书 | [下载 APK](https://github.com/Asahi12-26/open-novel-reader/releases/download/v0.6.1-beta.2/Open-Novel-Reader_0.6.1-beta.2_android-arm64.apk) |
| iOS | 保留共享架构，尚无 IPA 构建 | 需要 macOS 和签名条件 |

发布附件含校验文件和第三方许可。Android 0.2 起沿用固定发布证书，可覆盖安装。仍在使用 Android 0.1 开发签名版的用户，先在旧版导出书库，再安装新版并恢复。 [使用指南](docs/USAGE.md) · [V0.6.1 Beta 2 发布页](https://github.com/Asahi12-26/open-novel-reader/releases/tag/v0.6.1-beta.2)

## 现在可以用什么

- 本地导入中文 / 英文 TXT（UTF-8、GB18030、带 BOM 的 UTF-16）和无 DRM 的 EPUB；自动目录、封面、内容指纹去重。
- 动态书海首页：统一相位波浪、距离衰减涟漪、悬停 / 键盘浮起、封面共享展开与反向返回。手机单击进入，支持浅色 / 暖色 / 深色与减少动态效果。
- 段落及字符锚点续读、字号 / 字体 / 行距 / 页宽、目录、书签、离线 PWA、备份导出与验证恢复。
- 书名 / 作者 / 封面编辑、分类、搜索、排序、最近阅读、逐本云端上传选择。
- 开发者私人云按 Auth UID 授权，支持逐书云同步、版本冲突处理及离线恢复。自建维护者可配置自己的项目。
- DeepSeek 使用读者的会话 Key 直连，支持逐章和整书、预算估算、分片暂停 / 取消 / 续跑、人物及剧情证据、人工纠正。
- 整书分析支持已读范围和全书范围。任务与预算保存在本机，重启后重新授权即可从检查点继续。阅读页默认隐藏未来身份，人工纠错始终优先。V0.4 的真实整书模型质量待独立评估。 [质量样本与验证](docs/AI_QUALITY.md)
- 阅读页「人物管理」可上传及裁剪本地头像，查看别名、出场位置、身份历史和相关对白。 [人物头像使用指南](docs/CHARACTER_AVATARS.md)

EPUB 当前按文本阅读，暂不呈现插图、富文本强调或出版商 CSS；不支持 DRM、漫画和固定版式 EPUB。 [历史验收记录](PROJECT_STATUS.md)

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

本地模式无需配置 Supabase。私人云自建维护者可使用 `.env.example` 或设置页配置 HTTPS 项目 URL 和 anon / publishable 公钥，然后应用迁移并登记可信 UID。 [私人云部署](docs/CLOUD_SETUP.md)

只会上传用户逐本选择的小说。退出账号不删除本机书库；同一台设备供多人使用时，请使用各自独立的浏览器配置或系统账号。

Windows、Android 与 Web 使用自己的 DeepSeek API Key 直接连接服务商，Key 仅保存在当前会话内存。测试连接只查询模型。选择分析范围、确认预算并明确授权后才发送需要的小说片段。失败、取消和重试沿用既有预算记录。 [整书分析指南](docs/BOOK_ANALYSIS.md)

## 构建与发布

当前通过 GitHub Releases 手动更新安装包。 [平台构建](docs/BUILD.md) · [版本发布](https://github.com/Asahi12-26/open-novel-reader/releases)

## 代码布局

`src/core`：解析、版本化 IndexedDB、备份；`src/ui`：书架与阅读器交互；`src/services`：独立的同步与 AI；`supabase`：数据库、隔离测试和代理；`src-tauri`：平台外壳；`e2e`：浏览器冒烟测试。

第三方依赖见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，`npm run licenses` 生成依赖许可清单。请勿提交 `.env`、API Key、小说原文、导出的私人备份或签名文件。
