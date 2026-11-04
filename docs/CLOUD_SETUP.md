# V0.2 云服务连接

本地阅读始终可用。以下步骤完成前，源码和模拟传输检查不代表真实云服务已经上线。

## 账号维护者需要操作的部分

1. 在 Codex 添加 Supabase 并连接已有账号，指定用于本阅读器的项目名称。不要在聊天发送数据库密码、service-role、secret key 或个人访问令牌。
2. 如果项目尚未配置发信，在 Supabase 的 Authentication → Email / SMTP 中配置自己的邮件服务。密码和 SMTP 凭据只在供应商或 Supabase 页面填写。不得为此自动升级套餐。默认发信仅能发给项目组织成员，不能用作公开注册与找回密码服务。
3. 签名加密备份口令只在本机备份窗口输入，保留该口令和生成的备份文件；不要贴入聊天。建议再将加密备份文件复制到自己的离线介质。

## 自动配置范围

- 先检查目标项目现状，保留其他表与既有数据；按名称顺序应用 `supabase/migrations/` 中全部三份迁移。数据库与 Storage 都通过 `auth.uid()` 限制为自己的行 / 文件。
- 私有桶 `novel-files`，文件上限 50 MiB；云数据包上限 30 MiB。小说只有明确选择上传后才进入云端。
- Site URL：`https://asahi12-26.github.io/open-novel-reader/`。
- 邮件回调白名单：同一根地址的 `?auth=confirmation` 和 `?auth=recovery`。邮件模板保留默认 `{{ .ConfirmationURL }}`，不要使用 GitHub Pages 不存在的 `/auth/confirm` 路由。
- 三个平台的公开构建参数：`VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`（publishable / anon 公钥）、`VITE_PUBLIC_APP_URL`。服务端私钥不得打包进前端。
- GitHub 签名只保存为 Actions 加密 Secrets：`ANDROID_KEY_BASE64`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`。脚本在缺失凭据或证书与固定指纹不同的情况下拒绝发布。

## 必要真实验证

在同一账号的独立设备上导入原创测试书，选择上传，再检查另一设备的原文件、分类、章节位置、书签、阅读设置；断网修改后恢复连接，确认合并与续读。在另一账号检查无法读取、修改或下载前一账号的书籍。SQL 的两个账号隔离测试需在真实项目执行，并回滚测试数据；不拿用户私人小说做测试。

Windows 和 Android 最终包必须实际构建。Android 0.1 旧开发签名与新的固定发布签名不同，不能直接覆盖；先在旧版导出书库，保留可恢复备份，再迁移到新版。之后的正式包复用同一发布签名并递增 versionCode。

参考：[Supabase 邮箱密码](https://supabase.com/docs/guides/auth/passwords)、[邮件服务限制](https://supabase.com/docs/guides/auth/auth-smtp)、[回调地址配置](https://supabase.com/docs/guides/auth/redirect-urls)。
