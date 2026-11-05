# 构建、安装与更新

## 0.2 已验证产物（2026-11-05）

[正式签名主线构建](https://github.com/Asahi12-26/open-novel-reader/actions/runs/41990522943)通过。Windows 0.1 → 0.2 在独立测试书库实际覆盖安装，第三章 41% 进度、书签及暖笺主题保留，账号页面已连接同一云项目。Android release APK 已通过 CI 与本地 Google apksig 双重验签，固定证书一致；版本 0.2.0-beta.1 / 2001、ARM64、非调试、禁止明文 HTTP。Android 真机验证仍待完成。

独立加密签名备份已由用户实际输入口令并自动恢复核验，随后按授权保存三项 Actions Secrets。固定钥匙未替换。最终附件及校验值以 [0.2 Beta 发布页](https://github.com/Asahi12-26/open-novel-reader/releases/tag/v0.2.0-beta.1)为准。

## 历史 0.1 产物（2026-11-03）

标签 `v0.1.0-beta.1`、提交 `56e47a0` 的 [最终构建与发布](https://github.com/Asahi12-26/open-novel-reader/actions/runs/41715962013)成功。安装文件与校验值见 [Releases](https://github.com/Asahi12-26/open-novel-reader/releases/tag/v0.1.0-beta.1)。最终 Windows EXE 已实际覆盖安装、启动并恢复原 EPUB 章节；之前的 TXT/EPUB 导入、书签及升级保留数据均通过。40 项测试与 4 项浏览器检查通过，Web 已部署到 [GitHub Pages](https://asahi12-26.github.io/open-novel-reader/)。

Android ARM64 APK 已生成且通过 Google `apksig` v2 签名验证；包名为 `io.github.opennovelreader.app`，versionName 为 `0.1.0-beta.1`，versionCode 为 `1001`，minSDK 为 `26`。它仍是开发签名包，**尚未完成 Android 真机安装、文件选择和阅读验证**。本机未找到 Android SDK 或可用模拟器，没有为验证而安装系统工具链。iOS 尚无安装包。

最终 APK 约 26.8 MiB，开发配置不再附带 Rust DWARF 调试符号。最终证书 SHA256 为 `b6da1f665e1a87edf0cac99798add5a77c02408460d5fae8eb094d277eaaba2e`，与旧 CI 包不同；不能把 debug.keystore 缓存当作稳定签名方案。固定发布签名与真机升级见 [Issue #3](https://github.com/Asahi12-26/open-novel-reader/issues/3)。

## Web / PWA

需要 Node.js 22.12+（推荐 Node 22 LTS）和 npm。

```sh
npm ci
npm test
npm run build
npm run preview
```

打开终端给出的本机地址。开发模式用 `npm run dev`。生产部署上传 `dist/` 到支持 HTTPS 的静态托管服务，PWA 离线壳只有生产构建才启用。首次在线打开后可从浏览器菜单安装；导入的小说另存于本机 IndexedDB，不进入构建产物。

GitHub 仓库 Settings → Pages → Source 选择 **GitHub Actions** 后，`Publish Web PWA` 工作流会在 main 更新时部署。Supabase 公开 URL / anon key 可放 Repository Variables；这些是公开客户端配置，不能填写 service_role 或 AI 密钥。

原生 Windows / Android 工作流同样从 Repository Variables 读取 `VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`，在打包前注入前端。`VITE_PUBLIC_APP_URL` 默认是 `https://asahi12-26.github.io/open-novel-reader/`，可用同名 Variable 覆盖；邮件确认与密码恢复回到这个 Web 地址，再由页面处理 `?auth=confirmation` / `?auth=recovery`。这些配置都会进入客户端，不能用于保存服务器密钥。只修改 Variables 不会改变已经下载的安装包，需要重新构建。

## 平台选择

本项目用一份 React 前端 + Tauri 2 壳覆盖 Windows、Android，预留 iOS，不额外引入 Capacitor。Tauri 官方提供桌面和移动构建；阅读采用系统 WebView 的文件选择与 IndexedDB，因此不需要申请全盘读写权限。桌面 HTML 拖拽通过 `dragDropEnabled: false` 放行。Windows 使用 WebView2；Android 使用系统 Android System WebView，建议保持最新。

该选择仍需在实际 Android 设备上检查系统文件选择器、恢复阅读和离线行为；配置存在不等于设备兼容性已经验证。

参考：[Tauri 前置依赖](https://v2.tauri.app/start/prerequisites/)、[系统 WebView](https://v2.tauri.app/reference/webview-versions/)、[CLI](https://v2.tauri.app/reference/cli/)。

## Windows

需要 Rust stable（MSVC toolchain）、Microsoft C++ Build Tools 的“使用 C++ 的桌面开发”和 WebView2。

```sh
npm ci
npm run tauri -- dev
npm run tauri -- build --bundles nsis --ci
```

安装程序输出到 `src-tauri/target/release/bundle/nsis/`。默认安装到当前用户目录。未配置 Authenticode 证书，Windows 可能显示未知发布者；当前配置不宣称已签名。CI 的 `windows-x64-installer` artifact 是同样的 NSIS `.exe`。下载后应先核对 GitHub Actions 的成功状态及来源。

下载示例：上述构建运行页 → `windows-x64-installer` → 解压 → 运行 `Open Novel Reader_0.1.0-beta.1_x64-setup.exe`。Windows 更新保留书库的基础流程已经过本机冒烟检查，但更换应用标识、数据源或卸载清理仍可能删除数据，升级前可导出备份。

## Android：0.2 固定发布签名

需要 Rust stable、JDK 17、Android SDK（当前生成模板的 compile / target SDK 为 37；build tools 36.0.0）、NDK 27.2.12479018；设置 `JAVA_HOME`、`ANDROID_HOME`、`NDK_HOME`。CI 使用锁定版本的 Tauri CLI 生成工程，由 Gradle补齐所需 SDK。手动构建时以生成的 Gradle 配置为准。不需要 Play Console 账号即可侧载 APK。

```sh
rustup target add aarch64-linux-android
npm ci
npm run tauri -- android init --ci --skip-targets-install
npm run tauri -- icon src-tauri/icons/icon.png
# Set ANDROID_KEYSTORE_PATH, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD securely.
node scripts/configure-android-signing.mjs
npm run tauri -- android build --apk --target aarch64
node scripts/verify-android-release.mjs
```

结果位于 `src-tauri/gen/android/app/build/outputs/apk/`。最低 Android 8（API 26），CI 生成仅含 `arm64-v8a` 的 release APK；artifact 为 `android-arm64-release-apk`。下载解压后用系统文件管理器安装，或 `adb install -r <apk>`。release 模式关闭 `debuggable` 和明文 HTTP；尚未完成真机验证，也未提交 Play Store。

签名 Secrets 尚未齐全时，main / 手动分支构建仍编译 release 模式，但只上传 `android-arm64-unsigned-candidate-apk`，仅用于确认编译及 app id、版本、ARM64、非调试标记。这是未签名候选物，不能作为可安装包或 Release 下载。tag 缺任一 Secret 必须失败；只有固定签名和证书验证通过的 tag 才能发布。Secrets 齐全后主线自动走签名流程，不生成临时密钥。

从 0.2 开始使用一份专用发布 JKS，CI 从 GitHub Actions Secrets 恢复到 runner 临时目录，构建后删除；不再依赖 debug.keystore 缓存，也不会缺密钥时自动生成替代品。公开证书 SHA256 固定在 `scripts/android-release-certificate.sha256`：`d72345d97d1478b4013b9187d729dc23005f5ad70cdf8551b67cc20686454e8b`。构建后通过 Android 官方 `apksigner` 校验证书、签名，通过 `aapt` 校验 app id、版本、ARM64 和非调试标记；与固定证书不符则禁止上传 artifact。

**旧 0.1 debug 包不能直接覆盖升级为此 release 证书。** 最终 0.1 Beta 的证书为 `b6da1f665e1a87edf0cac99798add5a77c02408460d5fae8eb094d277eaaba2e`，没有在本机找到它的私钥。先在旧应用导出书库，保留备份，再处理卸载与新安装；不要以为保留相同包名就会接受不同签名。自 0.2 首次安装该发布证书后，后续版本持续复用同一私钥并递增 versionCode，才具备常规覆盖升级的签名条件。

`src-tauri/gen/` 是 Tauri 自动生成内容，CI 每次由已锁定 npm CLI 重新生成。Android/iOS 工程变更应记录为脚本及配置，不能只改忽略目录。若升级 Tauri，需重新验证生成模板兼容性。

生成工程后，`scripts/configure-android-signing.mjs` 按 [Tauri 官方签名方式](https://v2.tauri.app/distribute/sign/android/)补入 Gradle release signingConfig，从环境读取密码，不把密码写进 Gradle 或 properties。它检查模板结构，遇到未知签名配置直接停止。keystore、密码和任何签名 properties 都不得提交或进入构建 artifacts。Android 的签名与更新要求见 [Android 官方说明](https://developer.android.com/studio/publish/app-signing)。

### 首次配置 GitHub（只做一次）

本机已用 JDK 17 `keytool` 生成 RSA 3072 / SHA256withRSA、有效期 10000 天的专用 JKS。安全目录为 `%LOCALAPPDATA%\OpenNovelReader\signing`，不在项目或 OneDrive 内；目录 ACL 仅当前用户与 SYSTEM。JKS 有随机密码，密码以 Windows 当前用户/机器绑定的 DPAPI 形式保存；`init` 遇到已存在材料不会重建。`status` 只显示路径和公开证书指纹。

```powershell
powershell -File scripts/android-signing.ps1 -Action status
```

**先完成独立加密备份，再保存 GitHub Secrets。** 在本机独立 PowerShell 窗口执行：

```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File scripts/android-signing.ps1 -Action backup
```

它只在本机以两次 `Read-Host -AsSecureString` 隐藏输入备份口令；不要把口令放进命令参数、聊天或日志。使用独立的长口令（至少 16 字符），保存到自己的密码管理器。默认备份位置 `%LOCALAPPDATA%\OpenNovelReaderBackups` 与签名目录分离，禁止放在项目、工作区、OneDrive 或目录链接内，ACL 仅当前用户与 SYSTEM。

若自动打开的窗口不可见，可自行打开 PowerShell 并进入项目目录执行上述命令；也可在 Windows 运行窗口使用脚本的完整路径，并添加 `-NoExit` 保留结果。`RemoteSigned` 仅用于这一次进程，不修改系统执行策略。看到 `Backup and independent restore verification succeeded` 才表示完成。

容器包含完整 JKS、别名、JKS 密码及公开证书指纹，不依赖原电脑 DPAPI。加密采用随机 32 字节 salt、PBKDF2-HMAC-SHA256 600000 轮派生独立 AES / HMAC 密钥、随机 IV、AES-256-CBC 加密后 HMAC-SHA256 认证；恢复时先恒时核对 MAC 再解密。实现兼容 Windows PowerShell 5.1 和 PowerShell 7，采用 [Microsoft PBKDF2 API](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.rfc2898derivebytes.-ctor?view=netframework-4.8.1)及 [OWASP 的独立认证建议](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)。

备份写入后自动在新临时目录恢复，比较完整 JKS 字节，使用 `keytool` 校验证书等于公开 pin，并重新生成可读取的目标机 DPAPI 凭据；清除临时原料后才写 `%LOCALAPPDATA%\OpenNovelReaderBackups\android-release-backup.receipt.json`。记录仅含成功状态、加密容器路径、容器 SHA256 与公开证书 SHA256。`copy-secret` / `github` 必须找到这个成功记录并确认容器哈希未变化才执行。自动测试通过 SecureString 注入的口令只生成测试记录，不能满足正式发布前置条件。

换电脑后，将加密容器和项目脚本带到新机器，准备 JDK 17，在空的目标签名目录执行恢复，并在本机隐藏输入原备份口令：

```powershell
powershell -NoProfile -File scripts/android-signing.ps1 -Action restore -BackupPath "D:\private-backups\android-release-<timestamp>.onr-signing-backup"
```

恢复会核对固定证书，并为新机器当前用户重新 DPAPI 保护 JKS 密码；已有签名文件绝不覆盖。错误口令、认证失败或证书不符会停止，且不保留临时恢复原料。加密容器可另存一份离线介质防止本机磁盘损坏；口令与容器分开保管，丢失口令无法恢复。

仓库 Settings → Secrets and variables → Actions → Secrets 添加下面三项。每次先执行对应命令，直接粘贴到 GitHub Secret value 后保存；脚本不会把值输出到终端。不要粘贴到聊天、文档、issue 或日志。

```powershell
powershell -File scripts/android-signing.ps1 -Action copy-secret -Secret ANDROID_KEY_BASE64
powershell -File scripts/android-signing.ps1 -Action copy-secret -Secret ANDROID_KEY_ALIAS
powershell -File scripts/android-signing.ps1 -Action copy-secret -Secret ANDROID_KEY_PASSWORD
powershell -File scripts/android-signing.ps1 -Action clear-clipboard
```

如已安装并登录 GitHub CLI，可用 `powershell -File scripts/android-signing.ps1 -Action github` 一次写入三项 Secrets；值通过标准输入传递。本次本机没有 `gh`、也没有 GitHub token 环境变量，连接器不提供 Secrets 写入接口，因此采用 GitHub 网页配置。tag 缺任一 Secret，Android job 会在安装工具链前明确失败；主线此时只构建未签名候选物。

DPAPI credential 文件只能由本机当前用户解密，复制它不能替代上述可移机加密备份；不要丢失已有私钥后再生成同名文件。证书指纹是公开信息，不能从指纹或 APK 恢复私钥。此处尚未声称用户交互备份、GitHub Secrets 配置或 0.2 签名构建已完成，以实际完成记录与 Actions 结果为准。

## iOS

共享前端与 Rust lib 已兼容移动入口。完成 Xcode、Rust iOS targets 和 Apple 签名配置后，在 macOS 上执行 `npm run tauri -- ios init` 与 `npm run tauri -- ios build`。Windows 无法构建 IPA；此轮没有声称交付 iOS 安装包。

## 自动构建与发布

- `Web checks`：单元测试、运行时依赖许可证检查、生产构建、Chromium 冒烟测试。
- `Windows and Android builds`：main 和 `v*` tag 自动生成原生 artifacts；tag 成功后附加到 GitHub prerelease。
- `Publish Web PWA`：GitHub Pages 生产部署；需要仓库启用 Pages。

0.2 的版本为 `0.2.0-beta.1`，Android versionCode 为 `2001`（上一版 `1001`）。将 package.json / package-lock.json、src-tauri/Cargo.toml / Cargo.lock、tauri.conf.json 版本同步更新；之后每个 Android 发布的 versionCode 必须继续递增。`node scripts/check-release-version.mjs` 在原生 CI 检查版本、tag 和稳定 app id。推送 `v0.2.0-beta.1` 一类 tag 后查看 Actions；只有成功生成的 artifact 才算原生构建完成。工作流失败时修复后再发布，不把未生成的文件列为下载。

tag 工作流将原生二进制复制成 `Open-Novel-Reader_<version>_windows-x64-setup.exe`、`Open-Novel-Reader_<version>_android-arm64.apk`，随同 `THIRD_PARTY_LICENSES.zip`、`SHA256SUMS.txt` 上传。先规范为无空格的 ASCII 下载名再生成校验值，上传后检查实际附件名称，避免 GitHub 重命名导致校验文件名不匹配。已存在的同 tag Release 只覆盖同名附件，不会因为 Release 已存在而失败。

当前未启用 Tauri 静默更新器；用户从同一仓库 Releases 下载新版安装程序覆盖安装。保持 app identifier、origin 和签名，常规覆盖升级保留 IndexedDB；正式升级前建议在设置中导出备份。Windows / Android 从首版固定 `useHttpsScheme: true`，不能随意修改，否则 WebView 会切换 IndexedDB 存储源。浏览器隐私清理、卸载、清除应用数据可能删除本机书库。数据迁移由 Dexie schema 版本管理；禁止通过清空数据库“迁移”。

## 安全与许可证

AI Key 仅在运行时内存中使用，本版关闭后需要重新输入；没有将明文 Key 放入 Web localStorage、IndexedDB、同步记录或仓库。原生持久凭据保险箱尚未配置，不应把暂存内存描述为系统密钥链持久存储。

`npm run licenses` 读取锁文件与已安装包元数据，生成 `artifacts/dependency-licenses.json`，对未知运行时许可证返回非零退出码。`node scripts/rust-licenses.mjs` 读取已提交的 Cargo.lock，通过有标识的 User-Agent、最多 3 个并发请求读取 crates.io 官方版本元数据，缓存到忽略的 `artifacts/rust-license-cache.json`；`--refresh` 强制刷新。

当前 Rust 清单为 406 个 registry 版本，已全部读取，没有未知许可证；5 个 MPL-2.0 包及其准确源码下载链接见 [第三方声明](../THIRD_PARTY_NOTICES.md)，完整锁定清单见 [Rust inventory](RUST_DEPENDENCIES.md)。它包含构建工具和其他平台依赖，不能据此声称全部都会链接到某个安装包。该检查不是法律意见；上游许可证、版权与可获得源码的通知须随分发保留。

发布前运行 `node scripts/collect-notices.mjs`，从已安装 npm runtime 包和 Cargo.lock 对应的官方源包收集原始 LICENSE / NOTICE / COPYING、版权声明；下载并发最多 4，所有 crate 都核对锁定 SHA-256，缓存放在忽略的 `artifacts/`。当前已收集 34 个 npm runtime 包与 406 个 crate 版本，缺失 0；聚合文件为 `docs/licenses/DEPENDENCY_NOTICES.txt`（约 1.34 MB），AGPL / MPL / Unicode 原文也保留在同一目录。将此目录与第三方声明一并放入安装资源或发布附件。部分未随 crate 发布的许可文件取自包内记录的上游精确 Git commit；报告记录源路径，不复制实现源码。
