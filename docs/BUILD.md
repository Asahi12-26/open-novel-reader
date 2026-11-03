# 构建、安装与更新

## 已验证产物（2026-11-03）

提交 `e0631fd` 的 [Windows / Android 构建](https://github.com/Asahi12-26/open-novel-reader/actions/runs/41422399968) 已成功生成两个安装文件。Windows x64 NSIS 已在本机实际安装，验证了小说文件导入、阅读、书签、关闭重启后续读，以及从首轮构建覆盖安装修复构建后保留阅读位置与书签。Web 的生产构建与 4 项浏览器冒烟也已通过，并已部署到 [GitHub Pages](https://asahi12-26.github.io/open-novel-reader/)。

Android ARM64 APK 已生成且通过 Google `apksig` v2 签名验证；包名为 `io.github.opennovelreader.app`，versionName 为 `0.1.0-beta.1`，versionCode 为 `1001`，minSDK 为 `26`。它仍是开发签名包，**尚未完成 Android 真机安装、文件选择和阅读验证**。本机未找到 Android SDK 或可用模拟器，没有为验证而安装系统工具链。iOS 尚无安装包。

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

## Android

需要 Rust stable、JDK 17、Android SDK（当前生成模板的 compile / target SDK 为 37；build tools 36.0.0）、NDK 27.2.12479018；设置 `JAVA_HOME`、`ANDROID_HOME`、`NDK_HOME`。CI 使用锁定版本的 Tauri CLI 生成工程，由 Gradle补齐所需 SDK。手动构建时以生成的 Gradle 配置为准。不需要 Play Console 账号即可侧载 APK。

```sh
rustup target add aarch64-linux-android
npm ci
npm run tauri -- android init --ci --skip-targets-install
npm run tauri -- icon src-tauri/icons/icon.png
npm run tauri -- android build --debug --apk --target aarch64
```

结果位于 `src-tauri/gen/android/app/build/outputs/apk/`。本版最低 Android 8（API 26）；CI 优先生成 ARM64、debug 签名 APK，下载 artifact `android-arm64-debug-apk` 后解压，再用系统文件管理器安装，或 `adb install -r <apk>`。Debug 包是可安装的开发分发物，尚未具备商店发布签名。CI 缓存 debug keystore 减少升级签名变化；缓存被清理或本机构建使用不同密钥时，无法直接覆盖安装，先导出备份，不要直接卸载丢失数据。

已生成文件为 `universal/debug/app-universal-debug.apk`（仅含 `arm64-v8a`，约 124 MB）；debug 符号使文件较大，后续优化 release 构建可进一步缩小。证书主题为 `CN=Android Debug,O=Android,C=US`，证书 SHA-256 为 `95864f9413a9fcf07985eeab0314b5fbac15358db024c8060121ba85ddc0ee50`。开发包的 `debuggable=true` 与 `usesCleartextTraffic=true` 不是正式商店安全配置，发布生产包时必须复核。

`src-tauri/gen/` 是 Tauri 自动生成内容，CI 每次由已锁定 npm CLI 重新生成。Android/iOS 工程变更应记录为脚本及配置，不能只改忽略目录。若升级 Tauri，需重新验证生成模板兼容性。

商店或稳定 Beta 发布应创建并安全保存固定 keystore、按 [Tauri Android 签名说明](https://v2.tauri.app/distribute/sign/android/)配置 release 签名，然后改用 `android build --apk` / `--aab`。keystore、密码及 keystore.properties 不得提交。当前工作流未代替用户创建生产私钥。

## iOS

共享前端与 Rust lib 已兼容移动入口。完成 Xcode、Rust iOS targets 和 Apple 签名配置后，在 macOS 上执行 `npm run tauri -- ios init` 与 `npm run tauri -- ios build`。Windows 无法构建 IPA；此轮没有声称交付 iOS 安装包。

## 自动构建与发布

- `Web checks`：单元测试、运行时依赖许可证检查、生产构建、Chromium 冒烟测试。
- `Windows and Android builds`：main 和 `v*` tag 自动生成原生 artifacts；tag 成功后附加到 GitHub prerelease。
- `Publish Web PWA`：GitHub Pages 生产部署；需要仓库启用 Pages。

将 package.json、src-tauri/Cargo.toml、tauri.conf.json 三处版本同步更新；Android versionCode 必须递增。推送 `v0.1.0-beta.1` 一类 tag 后查看 Actions；只有成功生成的 artifact 才算原生构建完成。工作流失败时修复后再发布，不把未生成的文件列为下载。

当前未启用 Tauri 静默更新器；用户从同一仓库 Releases 下载新版安装程序覆盖安装。保持 app identifier、origin 和签名，常规覆盖升级保留 IndexedDB；正式升级前建议在设置中导出备份。Windows / Android 从首版固定 `useHttpsScheme: true`，不能随意修改，否则 WebView 会切换 IndexedDB 存储源。浏览器隐私清理、卸载、清除应用数据可能删除本机书库。数据迁移由 Dexie schema 版本管理；禁止通过清空数据库“迁移”。

## 安全与许可证

AI Key 仅在运行时内存中使用，本版关闭后需要重新输入；没有将明文 Key 放入 Web localStorage、IndexedDB、同步记录或仓库。原生持久凭据保险箱尚未配置，不应把暂存内存描述为系统密钥链持久存储。

`npm run licenses` 读取锁文件与已安装包元数据，生成 `artifacts/dependency-licenses.json`，对未知运行时许可证返回非零退出码。`node scripts/rust-licenses.mjs` 读取已提交的 Cargo.lock，通过有标识的 User-Agent、最多 3 个并发请求读取 crates.io 官方版本元数据，缓存到忽略的 `artifacts/rust-license-cache.json`；`--refresh` 强制刷新。

当前 Rust 清单为 406 个 registry 版本，已全部读取，没有未知许可证；5 个 MPL-2.0 包及其准确源码下载链接见 [第三方声明](../THIRD_PARTY_NOTICES.md)，完整锁定清单见 [Rust inventory](RUST_DEPENDENCIES.md)。它包含构建工具和其他平台依赖，不能据此声称全部都会链接到某个安装包。该检查不是法律意见；上游许可证、版权与可获得源码的通知须随分发保留。

发布前运行 `node scripts/collect-notices.mjs`，从已安装 npm runtime 包和 Cargo.lock 对应的官方源包收集原始 LICENSE / NOTICE / COPYING、版权声明；下载并发最多 4，所有 crate 都核对锁定 SHA-256，缓存放在忽略的 `artifacts/`。当前已收集 34 个 npm runtime 包与 406 个 crate 版本，缺失 0；聚合文件为 `docs/licenses/DEPENDENCY_NOTICES.txt`（约 1.34 MB），AGPL / MPL / Unicode 原文也保留在同一目录。将此目录与第三方声明一并放入安装资源或发布附件。部分未随 crate 发布的许可文件取自包内记录的上游精确 Git commit；报告记录源路径，不复制实现源码。
