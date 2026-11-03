# 阅见 · Open Novel Reader

免费、开源、Local-first 的跨平台小说阅读器。React + TypeScript + Vite PWA，共享 Tauri 2 桌面与移动端外壳。AGPL-3.0-only。

**立即阅读：[打开公开 Web / PWA](https://asahi12-26.github.io/open-novel-reader/)**。导入自己的 TXT / EPUB 即可使用，无需注册。云同步与 AI 是可选功能，需自行配置服务。

## 当前版本与下载

当前版本为 **0.1.0-beta.1**。

| 平台 | 已验证状态 | 使用入口 |
| --- | --- | --- |
| Web / PWA | 已公开部署；桌面和手机浏览器冒烟、离线重开通过 | [在线使用](https://asahi12-26.github.io/open-novel-reader/) |
| Windows x64 | NSIS 安装、文件导入、关闭重启续读及本轮覆盖升级保留书籍 / 位置 / 书签已验证 | [成功构建的安装包产物](https://github.com/Asahi12-26/open-novel-reader/actions/runs/41422399968)中的 `windows-x64-installer` |
| Android ARM64 | 已成功生成开发签名 APK；尚未完成真机安装验证 | [成功构建的 APK 产物](https://github.com/Asahi12-26/open-novel-reader/actions/runs/41422399968)中的 `android-arm64-debug-apk` |
| iOS | 保留共享架构，尚无 IPA 构建 | 需要 macOS 和签名条件 |

Actions 产物下载后需先解压；GitHub 可能要求登录。版本发布入口为 [Releases](https://github.com/Asahi12-26/open-novel-reader/releases)。Windows 安装包尚未做 Authenticode 签名；Android 当前是 ARM64 开发签名包，尚未用于应用商店分发。安装、阅读与备份步骤见 [使用指南](docs/USAGE.md)。

最近一轮远端检查已通过 **26 项单元测试、4 项生产浏览器冒烟测试、TypeScript 检查、生产构建与运行时依赖许可检查**。对应提交、验证记录与剩余工作见 [PROJECT_STATUS.md](PROJECT_STATUS.md)。

## 现在可以用什么

- 本地导入中文 / 英文 TXT（UTF-8、GB18030、带 BOM 的 UTF-16）和无 DRM 的 EPUB；自动目录、封面、内容指纹去重。
- 文学馆风格书架，封面共享元素展开与返回，浅色 / 暖色 / 深色，适配手机底部导航，尊重减少动画设置。
- 段落及字符锚点续读、字号 / 字体 / 行距 / 页宽、目录、书签、离线 PWA、备份导出与验证恢复。
- 书名 / 作者 / 封面编辑、分类、搜索、排序、最近阅读、逐本云端上传选择。
- Supabase 邮箱账号与同步实现、RLS 和私有 Storage 迁移；需部署自己的云项目后启用。
- 真实 DeepSeek 章节对白识别接口、预算估计、每次授权、分片暂停 / 取消 / 重试、未知人物、人工纠正、人物新建 / 改名 / 合并。需自己的 API Key 与已部署代理。

Supabase 的真实双账号 / 多设备同步尚未联调；DeepSeek 的真实收费分析尚未执行，开发没有产生 AI 费用。EPUB 当前按文本阅读，保留章节和段落，暂不呈现插图、富文本强调或出版商 CSS；不支持 DRM、漫画和固定版式 EPUB。

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

生产版使用 service worker 缓存应用。首次联网打开并完成缓存后，可离线再次打开；个人小说存于 IndexedDB。浏览器和原生 App 的书库各自独立，清除网站 / 应用数据会移除本地书库，建议定期导出备份。离线缓存测试针对生产版；`npm run dev` 不提供完整 PWA 离线体验。

## 云同步与 AI

复制 `.env.example` 为 `.env.local`，或在应用「设置与云同步」中填写 Supabase URL 和 anon / publishable 公钥。应用拒绝 service-role 密钥。执行迁移、部署 `deepseek-proxy`，参见 [同步与 AI 部署](docs/SYNC_AI.md)。未配置时本地阅读完整可用。

只会上传用户逐本选择的小说。退出账号不删除本机书库；同一台设备供多人使用时，请使用各自独立的浏览器配置或系统账号。

DeepSeek Key **仅保存在本次会话内存**。Web / 原生目前统一经自己的 Supabase Edge Function 转发，不保存密钥。刷新后需重新输入。连接测试只查询模型，收费分析必须在章节面板勾选授权并点击启动。供应商可能对已发送但失败 / 取消的请求收费，软件不自动重试 AI。预算为基于公开价格的保守预检，不能控制供应商改价。

## 构建与发布

参见 [平台构建](docs/BUILD.md)。CI 已实际生成 Windows NSIS 和 Android ARM64 开发签名 APK，公开 PWA 由 GitHub Pages 部署。main 更新自动执行检查和平台构建，打 `v*` tag 后由工作流创建预发布。未设置自动二进制更新：当前从 Releases 手动获取新版，更新前先备份；本轮 Windows 覆盖升级已验证，Android 真机升级仍待检查。

## 代码布局

`src/core`：解析、版本化 IndexedDB、备份；`src/ui`：书架与阅读器交互；`src/services`：独立的同步与 AI；`supabase`：数据库、隔离测试和代理；`src-tauri`：平台外壳；`e2e`：浏览器冒烟测试。

第三方依赖见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，`npm run licenses` 生成依赖许可清单。请勿提交 `.env`、API Key、小说原文、导出的私人备份或签名文件。
