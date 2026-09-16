# Blossom-ImgBed

Blossom-ImgBed 是一个面向 Nostr 的自托管 Blossom 媒体服务器，底层复用 CloudFlare-ImgBed 的多存储引擎。

它严格分离两类身份：

- 管理员登录现有 ImgBed Admin Dashboard，管理服务器配置。
- Nostr 用户不登录网站。兼容 Blossom 的客户端为每次上传或删除签署标准 BUD-11 请求。

Blossom 只提供协议与认证层。文件继续使用 ImgBed 现有的渠道选择、容量过滤、路由、负载均衡，以及 Cloudflare R2、Telegram、S3、WebDAV、Hugging Face、Discord 存储实现。

## 架构

```text
公开网页                         Blossom API
  └─ 项目介绍页                    └─ BUD-11 签名
       └─ Admin Login                  └─ pubkey 白名单
            └─ ImgBed Admin                 └─ ImgBed 存储引擎
                 └─ Blossom Settings             ├─ R2 / S3
                      ├─ 启用开关                  ├─ Telegram / Discord
                      ├─ Server URL               └─ WebDAV / Hugging Face
                      └─ pubkey 白名单
```

白名单只授予已签名 Blossom 写入/删除 API 的权限，不会创建 Web Session、ImgBed 用户、Admin Session、用户名或密码，也不能访问 `/api/manage/*`。

## Cloudflare 全新部署

1. 使用 Cloudflare GitHub integration 部署本仓库。
2. 创建 Cloudflare D1 数据库。
3. 将 D1 以 `img_d1` 作为 binding name 绑定到 Worker。
4. 在 D1 Console 执行本仓库完整的 [`database/init.sql`](database/init.sql)。
5. 打开 `/adminLogin` 登录。数据库和环境变量都没有管理员配置时，初始账号为 `admin` / `admin`，请立即在安全设置中修改。
6. 打开 **用户管理 → Nostr 白名单**。
7. 启用 Blossom。
8. 添加允许的 `npub1…` 或 64 位十六进制 pubkey。
9. 复制页面显示的 Server URL，并配置到兼容 Blossom 的 Nostr Client。

`database/init.sql` 是独立、完整 schema；全新安装不需要先执行上游 CloudFlare-ImgBed SQL。

### 管理员账号优先级

1. 数据库已有安全配置
2. `BASIC_USER` / `BASIC_PASS` 环境变量
3. 全新安装默认 `admin` / `admin`

密码机制继续保留 PBKDF2、旧 SHA-256 和明文兼容、自动升级哈希、修改密码和 Session 失效。

## 升级已有 ImgBed 数据库

备份数据库后，依次执行非破坏性迁移：

```text
database/migrations/v2.8.0_add_blossom_metadata.sql
database/migrations/v2.9.0_add_blossom_allowlist.sql
database/migrations/v2.10.0_add_blossom_settings.sql
```

这些迁移只增加 Blossom 表、索引和默认关闭的设置，不会删除或覆盖原文件、settings、metadata 或存储配置。

## 使用方式

### 管理员

在 `/adminLogin` 登录，然后进入 **用户管理 → Nostr 白名单**：

- 启用或关闭 Blossom 写操作；
- 复制根据当前请求域名生成的 Server URL；
- 添加、查看、删除允许的 Nostr pubkey。

关闭 Blossom 后，已签名的 `PUT` 和 `DELETE` 返回 `403 {"error":"blossom_disabled"}`；已有媒体的 `GET` 和 `HEAD` 读取保持正常。

### Nostr 用户

本项目不提供 Blossom Web Login、NIP-07 登录或 Web Upload Dashboard。用户只需把 Server URL 添加到兼容客户端。客户端用用户私钥签署 BUD-11 请求；服务器验证 kind `24242`、签名、action、expiration、server/hash scope 和 pubkey 白名单后，调用 ImgBed 存储引擎。

## API

Blossom：

```text
HEAD   /upload
PUT    /upload
GET    /<sha256>[.<ext>]
HEAD   /<sha256>[.<ext>]
DELETE /<sha256>[.<ext>]
```

由现有 Admin 中间件保护的管理 API：

```text
GET    /api/manage/blossom/settings
POST   /api/manage/blossom/settings
GET    /api/manage/blossom/pubkeys
POST   /api/manage/blossom/pubkeys
DELETE /api/manage/blossom/pubkeys/:pubkey
```

## 数据库诊断

- 未绑定 `img_d1`：Admin Login 返回 `database_not_configured`，并提示绑定名称。
- D1 为空或不完整：返回 `database_not_initialized` 和缺失表名，并提示执行 `database/init.sql`。
- 账号密码错误：返回独立的 `unauthorized`，不会与数据库错误混淆。

## 开发

需要 Node.js 20–22。

```bash
npm ci
npm test
npm run build
```

## 许可证

见 [LICENSE](LICENSE)。
