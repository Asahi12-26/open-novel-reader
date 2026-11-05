# 阅见 · Open Novel Reader

免费、开源、Local-first 的跨平台小说阅读器。React + TypeScript + Vite PWA，共享 Tauri 2 桌面与移动端外壳。AGPL-3.0-only。

**立即阅读：[打开公开 Web / PWA](https://asahi12-26.github.io/open-novel-reader/)**。导入自己的 TXT / EPUB 即可离线阅读，无需注册。云同步已连接本人测试项目；AI 仍为可选、自行配置功能。

## 当前版本与下载

**0.2.0-beta.1 已发布。** Web、Windows 和 Android 使用同一真实 Supabase 项目，保留动态书海与离线书库。双账号隔离、三浏览器同步、断网恢复、本人确认邮件及电脑 / 手机网页同步续读已通过；Windows 0.1 → 0.2 覆盖升级保留测试书、第三章 41% 进度、书签和主题；Android 已通过固定证书验签，尚待真机使用验证。

当前使用 Supabase 内置团队测试邮件，正式公网注册和完整密码找回暂不开放。已有测试账号可在三个平台登录；自建与配置步骤见 [云服务配置](docs/CLOUD_SETUP.md)。

| 平台 | 已验证状态 | 使用入口 |
| --- | --- | --- |
| Web / PWA | 已公开部署；桌面和手机浏览器冒烟、离线重开通过 | [在线使用](https://asahi12-26.github.io/open-novel-reader/) |
| Windows x64 | 已实测覆盖升级、续读、书签和主题保留 | [下载安装 EXE（约 1.92 MiB）](https://github.com/Asahi12-26/open-novel-reader/releases/download/v0.2.0-beta.1/Open-Novel-Reader_0.2.0-beta.1_windows-x64-setup.exe) |
| Android ARM64 | 固定发布签名、清单与 ABI 检查通过，尚未真机验证 | [下载 APK（约 6.85 MiB）](https://github.com/Asahi12-26/open-novel-reader/releases/download/v0.2.0-beta.1/Open-Novel-Reader_0.2.0-beta.1_android-arm64.apk) |
| iOS | 保留共享架构，尚无 IPA 构建 | 需要 macOS 和签名条件 |

[v0.2.0-beta.1 发布页](https://github.com/Asahi12-26/open-novel-reader/releases/tag/v0.2.0-beta.1)提供安装文件、许可附件与 [SHA256 校验值](https://github.com/Asahi12-26/open-novel-reader/releases/download/v0.2.0-beta.1/SHA256SUMS.txt)。Windows 未做发布者签名。**旧 Android 0.1 开发签名与新发布证书不同，不能直接覆盖安装；先在旧版导出书库，再迁移。** 0.2 起后续版本复用同一发布钥匙并递增 versionCode。安装步骤见 [使用指南](docs/USAGE.md)。

本轮已通过 **67 项测试、10 项生产浏览器检查、TypeScript、生产构建、依赖许可检查、26 项真实数据库断言及双账号云端验证**。原生签名构建和 Windows 升级检查已通过，验证范围与剩余工作见 [PROJECT_STATUS.md](PROJECT_STATUS.md)。

## 现在可以用什么

- 本地导入中文 / 英文 TXT（UTF-8、GB18030、带 BOM 的 UTF-16）和无 DRM 的 EPUB；自动目录、封面、内容指纹去重。
- 动态书海首页：统一相位波浪、距离衰减涟漪、悬停 / 键盘浮起、封面共享展开与反向返回。手机单击进入，支持浅色 / 暖色 / 深色与减少动态效果。
- 段落及字符锚点续读、字号 / 字体 / 行距 / 页宽、目录、书签、离线 PWA、备份导出与验证恢复。
- 书名 / 作者 / 封面编辑、分类、搜索、排序、最近阅读、逐本云端上传选择。
- Supabase 邮箱确认 / 登录、逐书上传、原文件 / 书架 / 进度 / 书签 / 设置同步、断网恢复与账号隔离；本人测试项目已部署，也支持自己的云服务。
- 真实 DeepSeek 章节对白识别接口、预算估计、每次授权、分片暂停 / 取消 / 重试、未知人物、人工纠正、人物新建 / 改名 / 合并。需自己的 API Key 与已部署代理。

Android 真机安装与本人账号的原生跨设备使用检查仍待完成，正式 SMTP 留待开放公网注册前配置。DeepSeek 的真实收费分析尚未执行，开发没有产生 AI 费用。EPUB 当前按文本阅读，保留章节和段落，暂不呈现插图、富文本强调或出版商 CSS；不支持 DRM、漫画和固定版式 EPUB。

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

DeepSeek Key **仅保存在本次会话内存**。Web / 原生目前统一经自己的 Supabase Edge Function 转发，不保存密钥。刷新后需重新输入。连接测试只查询模型，收费分析必须在章节面板勾选授权并点击启动。供应商可能对已发送但失败 / 取消的请求收费，软件不自动重试 AI。预算为基于公开价格的保守预检，不能控制供应商改价。

## 构建与发布

参见 [平台构建](docs/BUILD.md)。CI 已实际生成 Windows NSIS 和 Android ARM64 固定发布签名 APK，公开 PWA 由 GitHub Pages 部署。main 更新自动执行检查和平台构建，打 `v*` tag 后由工作流上传预发布安装包。未设置自动二进制更新：当前从 Releases 手动获取新版，更新前先备份；本轮 Windows 覆盖升级已验证，Android 真机升级仍待检查。

## 代码布局

`src/core`：解析、版本化 IndexedDB、备份；`src/ui`：书架与阅读器交互；`src/services`：独立的同步与 AI；`supabase`：数据库、隔离测试和代理；`src-tauri`：平台外壳；`e2e`：浏览器冒烟测试。

第三方依赖见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，`npm run licenses` 生成依赖许可清单。请勿提交 `.env`、API Key、小说原文、导出的私人备份或签名文件。
