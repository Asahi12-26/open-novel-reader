# PROJECT_STATUS

更新：2026-11-03 · 0.1.0-beta.1 · Web 已公开，Windows 安装与续读 / 覆盖升级通过，Android 真机待验证

## 已完成且已验证

- 独立新仓库与 React / TypeScript / Vite PWA；旧项目未修改。
- TXT / EPUB 真实解析、章节与封面、内容指纹去重、版本化 IndexedDB、本地删除标记。
- 备份与恢复验证、旧备份合并保护、人工纠正优先保留。
- 响应式文学馆书架、共享封面展开与返回、搜索 / 排序 / 分类、元数据与封面编辑。
- 稳定段落及字符锚点续读、字体 / 行距 / 页宽 / 主题、书签、PWA 离线、重启恢复。
- **26 项单元测试、4 项生产浏览器冒烟测试、TypeScript、生产构建和运行时依赖许可检查通过**。浏览器检查覆盖真实 TXT / EPUB 导入、续读、字号调整、书签、离线重开，以及手机触摸目录和减少动画设置。
- 公开 Web / PWA 已部署：[https://asahi12-26.github.io/open-novel-reader/](https://asahi12-26.github.io/open-novel-reader/)。
- Windows x64 NSIS 安装程序已由 CI 实际生成；本机安装、文件选择导入、阅读及关闭重启后书库保留已验证。本轮旧包覆盖安装为新包成功，升级后恢复「第二章 来信」及既有书签。
- Android ARM64 开发签名 APK 已由 CI 实际生成；**尚未完成 Android 真机安装及阅读验证**。

最近通过的远端验证均针对提交 `e0631fd`：

| 检查 | 结果 |
| --- | --- |
| [Web checks · 41422399930](https://github.com/Asahi12-26/open-novel-reader/actions/runs/41422399930) | 26 项单元测试与 4 项浏览器冒烟、构建等检查通过 |
| [Windows and Android builds · 41422399968](https://github.com/Asahi12-26/open-novel-reader/actions/runs/41422399968) | Windows NSIS 与 Android ARM64 APK 构建及产物上传成功 |
| [Publish Web PWA · 41422400575](https://github.com/Asahi12-26/open-novel-reader/actions/runs/41422400575) | GitHub Pages 部署成功 |

当前可从原生构建运行页下载 `windows-x64-installer` 和 `android-arm64-debug-apk`，解压后获得安装文件；[Releases](https://github.com/Asahi12-26/open-novel-reader/releases) 是后续版本发布与更新入口。安装说明见 [使用指南](docs/USAGE.md)。

当前工作区另加入删除后主动重新导入的显式恢复标记及备份校验，避免普通元数据改动复活已删除书籍；本地库 7 项回归及 TypeScript 检查通过。该修复需与配套云合并修改一起完成下一轮远端构建后再列入发布产物。

## 已实现，待真实服务联调

- Supabase 邮箱 Auth、逐本选择同步、版本冲突合并、跨账号归属限制、离线重试；迁移与 RLS 测试已写。
- DeepSeek 真实代理调用、用量预估与预算、逐次授权、任务暂停取消重试、人物纠错与合并；未调用收费接口。
- 上述单元测试通过不等于真实 Supabase 双账号隔离或 DeepSeek 收费调用已验证；本轮未作该完成声明。

## 尚未完成 / 外部条件

- 完成 Android 真机安装、导入、阅读、重启与离线检查。
- 整理 Releases 安装文件与校验值，补充明确的版本下载链接；当前真实构建产物已可从 Actions 获取。
- Supabase 缺少用户项目 URL / 公钥与部署权限，尚无真实双账号同步 / RLS 联调结果。
- 真实 AI 需要用户自己的 DeepSeek Key 与明确的本次费用授权；开发不擅自消费。
- iOS 需要 macOS 和签名，当前不阻塞其他平台。

## 已知限制

- EPUB 目前文本优先，不呈现内嵌插图、强调 / 链接样式和出版商 CSS，不支持 DRM 与固定版式漫画。
- 本地书库为设备级；多人共享设备请用独立浏览器配置。云端已实现账号隔离策略，真实部署仍待验证。
- AI Key 只放会话内存，未实现原生钥匙串持久化；刷新后需输入。价格预检依赖供应商公开价格。
- Windows 未签名、Android 开发签名；尚无二进制自动更新。Windows 已验证本轮旧包到新包的覆盖安装，后续数据库迁移仍需随版本检查；Android 跨版本真机升级未验证。

## 下一步（连续推进）

1. 将成功生成的 Windows / Android 安装文件与校验值整理到预发布，补充直接下载链接。
2. 在 Android ARM64 真机检查文件选择、TXT / EPUB 导入、退出续读与离线阅读。
3. 保持 Web / Windows / Android CI 可用，继续补全 EPUB 排版与首轮使用中发现的问题。
4. 用户部署自己的 Supabase 后执行两账号隔离与多设备同步测试；有明确费用授权后做一次真实 AI 分析。
