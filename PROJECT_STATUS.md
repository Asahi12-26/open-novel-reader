# PROJECT_STATUS

更新：2026-11-04 · main 动态书海 UI · Beta 安装包仍为 v0.1.0-beta.1，云服务后续配置

## 本轮动态书海

- 独立 BookOcean，稳定响应式位置、统一时间与相邻相位波浪、鼠标距离衰减涟漪。
- 固定交互槽、悬停 / 聚焦锁定波浪位置，弹簧浮起，显示书名、作者及进度；手机单击浮出进入，保留原生纵向滚动。
- 保留共享封面进入 / 翻开 / 正文接替及反向返回；进入前冻结顺序、书架位置，直到转场退出才解锁。非可见封面来源采用淡入，避免离屏飞入。
- 近视口分区渲染、后台暂停、减少动态效果；没有新增依赖、修改数据库结构或重新初始化书库。
- 本轮只更新 UI、动画状态及必要浏览器检查；40 项单元 / 集成测试、TypeScript、生产构建及 8 项浏览器检查通过。覆盖 TXT / EPUB、续读、书签、离线重开，另验证波浪 / 锁相浮起、键盘深滚动进出与位置还原、手机真实滑动 / 单击 / 实时减少动态效果、240 本书分区与打开失败恢复。
- 悬停中心实际上浮 82.64px，固定书位位移 0；临时测试库前后书籍、章节及原文件相同。没有读取或清空真实用户书库。
- 运行入口沿用 [公开 Web / PWA](https://asahi12-26.github.io/open-novel-reader/)，已有 PWA 用户可在更新提示出现后更新应用。

## 已完成

- 全新独立开源仓库，旧项目与用户数据未修改。AGPL-3.0，依赖许可与原始版权声明随应用分发。
- TXT（UTF-8 / GB18030 / BOM UTF-16）、无 DRM EPUB 导入、目录、封面和内容指纹去重。
- 桌面 / 手机书架：搜索、分类、元数据与封面编辑、最近阅读。封面放大后进入阅读，返回反向过渡，支持减少动画（本轮 main 已升级为动态书海）。
- 离线 IndexedDB、稳定段落 / 字符位置续读、排版与主题、书签、备份验证恢复。
- Windows 已验证安装、TXT / EPUB 导入阅读、关闭重启，以及本轮覆盖升级保留书籍、章节位置和书签。
- 原生壳直接使用安装包资源，跳过 PWA service worker；Web 保留离线缓存与更新提示。
- Supabase / DeepSeek 接口、两份迁移、逐书上传许可、冲突合并、任务预算与人工纠正已实现；暂不配置云服务，未调用收费模型。

## 验证与交付

- 源码标签 v0.1.0-beta.1，提交 56e47a0c9b12cde96ede25ed85835faef8def3bf。
- [公开 Web / PWA](https://asahi12-26.github.io/open-novel-reader/) 已更新。
- 同一提交的 [40 项测试 + 4 项浏览器检查](https://github.com/Asahi12-26/open-novel-reader/actions/runs/41714755279)、[Windows / Android 主构建](https://github.com/Asahi12-26/open-novel-reader/actions/runs/41714754998)、[Web 部署](https://github.com/Asahi12-26/open-novel-reader/actions/runs/41714755045)均通过。
- [Beta 发布页](https://github.com/Asahi12-26/open-novel-reader/releases/tag/v0.1.0-beta.1)已提供 EXE、APK、许可附件与规范 SHA256SUMS.txt；[标签构建 41715962013](https://github.com/Asahi12-26/open-novel-reader/actions/runs/41715962013)全部成功。最终 Windows 包已覆盖安装、启动并恢复原章节；APK 验签与内置许可内容检查通过。
- [Windows EXE（约 1.91 MiB）](https://github.com/Asahi12-26/open-novel-reader/releases/download/v0.1.0-beta.1/Open.Novel.Reader_0.1.0-beta.1_x64-setup.exe) · [Android APK（约 26.8 MiB）](https://github.com/Asahi12-26/open-novel-reader/releases/download/v0.1.0-beta.1/app-universal-debug.apk)。校验文件已从公开入口下载确认，文件名与附件一致；原构建记录保留为 SHA256SUMS.build-log.txt。
- 同步集成测试用两台独立 Dexie 数据库与真实同步代码，仅替换云传输，不等于真实 Supabase / RLS 联调。
- npm 34 个运行时依赖、Cargo.lock 406 个版本已收集许可声明。清单包含构建和其他平台依赖，不冒充最终链接闭包或法律保证。

## 已知限制

- Android 为 ARM64 开发签名包，最低 Android 8，尚未真机验证；不同 CI 证书已发生变化，旧包用户须先备份，固定签名见 [Issue #3](https://github.com/Asahi12-26/open-novel-reader/issues/3)。Windows 未签名，无二进制自动更新器。
- EPUB 暂不呈现内嵌插图和出版商排版：[Issue #1](https://github.com/Asahi12-26/open-novel-reader/issues/1)。
- 恢复备份上限 256 MiB，尚无大书库分卷导出，应保留小说原文件：[Issue #2](https://github.com/Asahi12-26/open-novel-reader/issues/2)。
- 书库为设备级，共用设备请用独立浏览器配置或系统账号；Web / 原生书库分别存储。
- 云端双账号隔离与收费 AI 尚未联调；密钥仅在会话内存，没有原生钥匙串持久化；iOS 仍需 macOS 与签名。
- 备用 Sites 更新遇 Cloudflare Sandbox 平台请求故障；交付采用正常的 GitHub Pages 入口。

## 下一步

1. Android 固定发布签名，真机验证导入、阅读、重启、离线与升级；修正后续工作流的附件名校验生成（[Issue #4](https://github.com/Asahi12-26/open-novel-reader/issues/4)）。
2. 继续 EPUB 排版和大书库备份，不改变既有阅读锚点与数据。
3. 用户决定启用云服务时再部署 Supabase，运行真实两账号及跨设备检查；只有明确授权具体费用后才调用收费 AI。
