# 构建、安装与更新

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

## Android

需要 Rust stable、JDK 17、Android SDK（platform 36、build tools 36.0.0）、NDK 27.2.12479018；设置 `JAVA_HOME`、`ANDROID_HOME`、`NDK_HOME`。不需要 Play Console 账号即可侧载 APK。

```sh
rustup target add aarch64-linux-android
npm ci
npm run tauri -- android init --ci --skip-targets-install
npm run tauri -- icon src-tauri/icons/icon.png
npm run tauri -- android build --debug --apk --target aarch64
```

结果位于 `src-tauri/gen/android/app/build/outputs/apk/`。本版最低 Android 8（API 26）；CI 优先生成 ARM64、debug 签名 APK，下载 artifact `android-arm64-debug-apk` 后解压，再用系统文件管理器安装，或 `adb install -r <apk>`。Debug 包是可安装的开发分发物，尚未具备商店发布签名。CI 缓存 debug keystore 减少升级签名变化；缓存被清理或本机构建使用不同密钥时，无法直接覆盖安装，先导出备份，不要直接卸载丢失数据。

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

`npm run licenses` 读取锁文件与已安装包元数据，生成 `artifacts/dependency-licenses.json`，对未知运行时许可证返回非零退出码。此检查是依赖清单检查，不代替法律意见；上游许可证与版权须随分发保留。Rust 的完整传递依赖以首次成功生成的 Cargo.lock 为准，发布前需补充 Rust 依赖许可证清单。
