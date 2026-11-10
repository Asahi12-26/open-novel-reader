# PROJECT_STATUS

更新：2026-11-09 · V0.3 Beta 已发布

## V0.3 本轮进展

- 源码版本 `0.3.0-beta.1`，Android versionCode `3001`；沿用 app id、HTTPS WebView origin、固定发布签名和 Dexie v1 数据库，不重新初始化书库。
- 复用对白定位、稳定人物 ID、人工纠错与任务检查点，补齐章节选择、进度、错误、结果摘要和正文纠正入口。未知人物保留为未知，人工纠错优先；分片结果与检查点在同一事务保存。
- Key 仅保存在会话 RAM；刷新、退出、账号或云项目切换会清除 Key / 停止原任务，旧响应不能落入新账号视图。单章重复任务受锁保护，失败和取消保留已用额度，续跑必须重新明确授权，不自动重试收费请求。
- 已在原有免费 Supabase 项目部署 `deepseek-proxy`，启用平台 JWT 验证和服务端 `getUser` 验证。精确来源白名单、固定上游 / 模型 / 系统提示、请求与响应大小、输出 token 和单请求估算费用边界已验证。
- 真实登录 JWT 的 `status` 检查返回成功且不访问 DeepSeek；匿名、无效 JWT、外部来源、非法参数及未授权分析被拒绝。临时测试账号与数据已清理，不涉及私人小说。
- 主线候选 `41a8647` 的 95 项单元 / 离线测试、11 项浏览器流程及 Windows / Android CI 构建全部通过。Windows 隔离书库 0.2 → 0.3 覆盖安装返回 0，保留 1 本测试书、第三章 41%、1 个书签与暖笺主题。候选 Android APK 真机覆盖升级保留原登录、书库和第三章 88%，书签、冷重启、完全断网正文、恢复联网同步和非收费代理检查均通过，网络已原样恢复。
- 原创短章 Flash 真实推理最小验证通过：完成 1/1 分片，3 句对白全部归属到 2 名人物，0 未知，1 处人工确认重新打开后仍保存。测试结束已清除会话内存密钥；整本书与复杂人物的识别准确率仍待扩展验证，后续收费调用需另行授权。
- Android 顶部安全区修复已在真机确认，原来被状态栏遮挡的返回、目录与书签按钮现在可点击；没有卸载、清库或替换固定发布钥匙。
- Supabase 的 Leaked Password Protection 官方文档标明仅 Pro 及以上套餐支持；保持免费套餐，不自动升级。它与正式 SMTP 一并列为开放公网注册前待办，邮箱确认仍开启。
- [v0.3.0-beta.1](https://github.com/Asahi12-26/open-novel-reader/releases/tag/v0.3.0-beta.1)已发布，标签提交 `37455962d3cef1c888a860c725b09e53f76cd69e`。[标签原生构建](https://github.com/Asahi12-26/open-novel-reader/actions/runs/42361969367)、[标签 Web 检查](https://github.com/Asahi12-26/open-novel-reader/actions/runs/42361969469)及 [Pages 部署](https://github.com/Asahi12-26/open-novel-reader/actions/runs/42361941854)全部成功。四项公开附件已实际下载，文件名、GitHub 摘要与 SHA256SUMS 一致；APK 固定证书、3001、ARM64、非调试、禁止明文 HTTP 和 7 项内置许可检查通过。正式标签 APK 已完成实机覆盖安装与冷重启复核，登录、第 3 章 88% 和原 1 个书签均保留，手动同步成功；上述完整真机 QA 属于候选 `41a8647`。V0.2 交付历史如下。

- 正式标签 Windows EXE 已在隔离测试目录实际安装并启动，恢复原测试书第三章 41% 与暖笺主题；没有访问真实用户书库。

- 正式标签 APK 已在同一手机用 install-r 覆盖安装，设备内 base.apk 的 SHA256 与发布附件一致；冷重启后登录、第三章 88%、正文与原书签均保留，手动同步成功。本次未改网络、未卸载清库、未调用模型。

## V0.2 本轮交付范围

- 候选源码版本 0.2.0-beta.1，Android versionCode 2001；保留动态书海和原有本地数据库。
- 补齐邮箱注册 / 确认 / 登录、当前设备退出、找回密码、Web 自动密码恢复表单。原生确认与重置邮件回公开 Web，再用新密码登录原生应用。
- 复用原同步引擎，增加云项目 + 账号的本地快照隔离、离线分类 / 偏好切换；明确导入后才能把同指纹书变为另一账号自己的独立副本。
- 阻止晚到下载 / 授权跨账号落库，撤销上传许可后阻止后续保存；缺失原文件可修复；恢复后的文件采用新代际路径，旧墓碑不再删除新恢复文件。
- 67 项本地测试、TypeScript、生产构建及 10 项浏览器冒烟通过；真实双账号 / 三浏览器、本人确认邮件、Windows 安装升级与 Android 固定证书验签通过。Android 真机及本人账号的原生跨设备使用检查仍待完成。
- 已连接免费专用项目 open-novel-reader（rqyhreuolusdwsqpfsxr），四份应用迁移已部署，另启用 pgTAP 测试支持。两表 RLS、私有文件桶、版本触发器正常，数据库安全检查当前零告警。
- 用户已完成独立、可移机的加密备份；脚本实际恢复核验通过，回执、容器 SHA256 与固定证书一致。随后按授权保存三项 Actions Secrets；私钥和签名密码未输出或提交。目录及文件仅当前用户和 SYSTEM 可访问，建议另存加密容器至离线介质。
- 修复继承 PowerShell 7 模块路径导致 Windows PowerShell 5.1 加载失败、Set-Acl 额外权限依赖及输入口令前缺少预检的问题。PS5.1 / PS7 完整测试备份及恢复均通过，测试回执不能授权 Secrets。
- V0.2 已合入 main，采用真实云配置的[本人测试 Web 已部署](https://github.com/Asahi12-26/open-novel-reader/actions/runs/41955978410)。已实际更新旧 Web，现有测试书籍和 17% 阅读位置保留；账号页已显示团队测试邮件范围。
- [正式签名主线构建](https://github.com/Asahi12-26/open-novel-reader/actions/runs/41990522943)全部成功。APK 通过 Google apksig 独立验签，证书等于固定 pin；应用标识、0.2.0-beta.1 / 2001、ARM64、非调试、禁止明文 HTTP 均通过。Windows 版本与下载摘要通过，未配置 Authenticode。
- Windows 在独立 WebView2 测试数据目录完成 0.1 → 0.2 实际安装覆盖、启动续读、第三章 41% 进度、书签与暖笺主题保留；动态书海及已配置账号页正常。未访问或清空真实用户书库。
- 本人已在电脑网页选择测试书上传，并在手机浏览器使用同一账号同步，确认可以接续阅读。该结果为本人实际设备验证，Android APK 原生使用仍待安装后检查。

- 正式标签 `v0.2.0-beta.1` 指向提交 `85a74039ec7bfa742682b76d7a12c4332b4f11b0`；[标签原生构建与上传](https://github.com/Asahi12-26/open-novel-reader/actions/runs/41992594440)和[标签 Web 检查](https://github.com/Asahi12-26/open-novel-reader/actions/runs/41992594539)全部成功。[Beta 发布页](https://github.com/Asahi12-26/open-novel-reader/releases/tag/v0.2.0-beta.1)四项附件均已从公开入口实际下载，文件名、GitHub 摘要和 SHA256SUMS 一致；APK 证书、清单和内置许可再次独立核验通过。

V0.2 发布时剩余 Android 原生账号互通与后续版本覆盖升级，正式 SMTP 留待开放公网注册前配置，不阻塞本人测试。V0.3 进展与未验证部分见本页开头；部署入口见 [CLOUD_SETUP.md](docs/CLOUD_SETUP.md)。

## 真实云端验收（2026-11-04）

- 数据库隔离、CAS、版本与恢复时序断言26/26通过，全部回滚，无用户数据残留。
- 使用实际Web应用与syncLibrary，在两个临时账号、三个独立浏览器环境通过原文件 / 进度 / 书签同步、离线回传、同指纹账号独立副本、跨账号读写删除拒绝、单设备退出不影响另一设备。
- 临时账号、身份、书籍记录、偏好和Storage文件均已清理，五类残留计数为0；不涉及私人小说，没有trace/HAR/录屏/密码或token落盘。
- GitHub已保存公开云构建变量及team-test邮件提示；Supabase Site URL及两条精确邮件回调地址已配置并回读确认。
- 按用户选择使用内置团队测试邮件，邮箱确认开启；本人已完成确认邮件，服务端只读验证有一个已确认并登录的账号。正式公网邮件暂缓。控制台临时登录已退出。原生签名 Secrets 已在独立备份验证成功后保存。

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
- Supabase / DeepSeek 接口、逐书上传许可、冲突合并、任务预算与人工纠正已实现；V0.2 云服务已实际部署并验证，未调用收费模型。

## V0.1 历史验证与交付

- 源码标签 v0.1.0-beta.1，提交 56e47a0c9b12cde96ede25ed85835faef8def3bf。
- [公开 Web / PWA](https://asahi12-26.github.io/open-novel-reader/) 已更新。
- 同一提交的 [40 项测试 + 4 项浏览器检查](https://github.com/Asahi12-26/open-novel-reader/actions/runs/41714755279)、[Windows / Android 主构建](https://github.com/Asahi12-26/open-novel-reader/actions/runs/41714754998)、[Web 部署](https://github.com/Asahi12-26/open-novel-reader/actions/runs/41714755045)均通过。
- [Beta 发布页](https://github.com/Asahi12-26/open-novel-reader/releases/tag/v0.1.0-beta.1)已提供 EXE、APK、许可附件与规范 SHA256SUMS.txt；[标签构建 41715962013](https://github.com/Asahi12-26/open-novel-reader/actions/runs/41715962013)全部成功。最终 Windows 包已覆盖安装、启动并恢复原章节；APK 验签与内置许可内容检查通过。
- [Windows EXE（约 1.91 MiB）](https://github.com/Asahi12-26/open-novel-reader/releases/download/v0.1.0-beta.1/Open.Novel.Reader_0.1.0-beta.1_x64-setup.exe) · [Android APK（约 26.8 MiB）](https://github.com/Asahi12-26/open-novel-reader/releases/download/v0.1.0-beta.1/app-universal-debug.apk)。校验文件已从公开入口下载确认，文件名与附件一致；原构建记录保留为 SHA256SUMS.build-log.txt。
- 同步集成测试用两台独立 Dexie 数据库与真实同步代码，仅替换云传输，不等于真实 Supabase / RLS 联调。
- npm 34 个运行时依赖、Cargo.lock 406 个版本已收集许可声明。清单包含构建和其他平台依赖，不冒充最终链接闭包或法律保证。

## 已知限制

- Android 为 ARM64 固定发布签名包，最低 Android 8；候选 `41a8647` 的 0.2 → 0.3 真机覆盖升级、登录保持、同步、书签、重启与离线阅读均通过，正式标签 APK 已完成实机覆盖安装与冷重启复核，登录、第 3 章 88% 和原 1 个书签均保留，手动同步成功。旧 0.1 开发证书不同，须先在旧版导出书库再迁移。0.3 versionCode 为 3001。Windows 未做发布者签名，无二进制自动更新器。
- EPUB 暂不呈现内嵌插图和出版商排版：[Issue #1](https://github.com/Asahi12-26/open-novel-reader/issues/1)。
- 恢复备份上限 256 MiB，尚无大书库分卷导出，应保留小说原文件：[Issue #2](https://github.com/Asahi12-26/open-novel-reader/issues/2)。
- 书库为设备级，共用设备请用独立浏览器配置或系统账号；Web / 原生书库分别存储。
- 云端双账号隔离、本人确认邮件及电脑 / 手机网页同步续读已验证；正式 SMTP 与 Pro 及以上套餐的泄露密码保护待开放注册前处理。代理鉴权、AI 离线工作流、原创短文真实推理及人工确认保存已通过，整本书和复杂人物准确率仍待扩展验证。AI Key 仅在会话内存，没有原生钥匙串持久化；iOS 仍需 macOS 与签名。
- 备用 Sites 更新遇 Cloudflare Sandbox 平台请求故障；交付采用正常的 GitHub Pages 入口。

## 下一步

1. 扩展复杂人物与整本书准确率验证；任何后续生成须另获明确授权，不自动追加收费请求。
2. 正式开放注册前配置 SMTP，并处理 Leaked Password Protection 的套餐条件；不自动升级。EPUB 排版与大书库备份保留为后续工作。
