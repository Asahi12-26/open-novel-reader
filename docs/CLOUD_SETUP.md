# 私人云维护

V0.6.1 默认使用本地书库并直接连接 DeepSeek。已有开发者账号可在「设置 → 私人云同步」登录现有项目。私人云的注册和匿名登录已关闭，现有邮箱登录和邮箱确认保留。

## 自建私人项目

1. 按文件名顺序应用 `supabase/migrations/`。升级前从应用导出 ZIP，并使用项目自己的数据库与 Storage 备份方式保存独立副本。新权限迁移只增加约束和角色检查，原书籍包、头像、原文件及账号沿用原 ID。
2. 在 Supabase Auth Dashboard 关闭 **Allow new users to sign up** 和 **Allow anonymous sign-ins**，保持邮箱登录及确认。先在已登录的项目控制台确认自己的既有 Auth UID。
3. 用项目管理员的 SQL Editor 执行以下语句。使用已确认账号的真实 UID 替换占位符。自建部署的授权名单初始为空。

```sql
insert into reader_private.cloud_members (user_id)
values ('YOUR-VERIFIED-AUTH-USER-ID'::uuid)
on conflict do nothing;
```

4. 在应用高级设置或构建环境设置 HTTPS 项目 URL 和 publishable/anon 公钥。构建参数为 `VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`、`VITE_PUBLIC_APP_URL`。发布前端只接受公钥。
5. 只为要同步的书打开上传许可。用同一授权账号在另一台设备检查原文件、书签、人物、系列和剧情。

新版权限检查通过 `reader_has_private_cloud()` 返回当前会话是否被批准。两张业务表和两个书库桶都要求白名单及原所有权一致。服务端用 Auth UID 判定，名单本身留在私有 schema。开发环境可用 `supabase test db` 运行跟随迁移的 SQL 测试。

需要恢复已有开发者的云权限时，重新核对并加入同一 Auth UID。账号、记录和文件无需删除或重新创建。直接使用旧版云账号拥有的本机资料时，在原账号下导出备份。

## 邮件和旧版兼容

维护现有站点 URL 和允许的邮箱回调地址。本站回调来自站点根路径的 `?auth=confirmation` 和 `?auth=recovery`；自建使用各自的明确 HTTPS 回调。Supabase 内置邮件目前面向项目团队且每项目每小时最多 2 封。只有账号维护者需要在设备上管理凭证。 [邮件服务限制](https://supabase.com/docs/guides/auth/auth-smtp) · [回调配置](https://supabase.com/docs/guides/auth/redirect-urls)

`deepseek-proxy` 只供旧版已授权账号兼容。它保留网关 JWT 校验，并验证用户、云权限、请求结构、费用估算及持久限额。V0.6.1 使用设备直连，部署私人云时不需要为了新版 AI 初始化代理。 [同步机制与旧版兼容](SYNC_AI.md) · [历史验收记录](../PROJECT_STATUS.md)
