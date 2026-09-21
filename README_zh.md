# Blossom-ImgBed

Blossom-ImgBed 是一个面向 Nostr 的自托管 Blossom 媒体服务器，底层复用 CloudFlare-ImgBed 的多存储引擎。

它严格分离三类身份：

- 管理员登录现有 ImgBed Admin Dashboard，管理服务器配置。
- Nostr 用户不登录网站。兼容 Blossom 的客户端为每次上传或删除签署标准 BUD-11 请求。
- 可信后端使用权限明确的 API service token。只有 `issue_upload_token` 权限的 service token 可以签发绑定 pubkey 的短期上传 token，它不是管理员身份。

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

外部 Nostr 上传始终需要 pubkey 白名单。客户端名称、版本、请求头、Origin、Referer、User-Agent 均不参与授权。service 签发的 token 是独立的 upload-only 路径，不能访问 `/api/manage/*`、继续签发 token、列出或删除媒体。

## Cloudflare 全新部署

1. 使用 Cloudflare GitHub integration 部署本仓库。
2. 创建 Cloudflare D1 数据库。
3. 将 D1 以 `img_d1` 作为 binding name 绑定到 Worker。
4. 在 D1 Console 执行本仓库完整的 [`database/init.sql`](database/init.sql)。
5. 打开 `/adminLogin` 登录。数据库和环境变量都没有管理员配置时，初始账号为 `admin` / `admin`，请立即在安全设置中修改。
6. 打开 **用户管理**。
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

备份数据库后，按版本顺序执行 `database/migrations/` 中所有尚未执行的迁移。当前 service-token 迁移会新增 `blossom_upload_tokens` 与共享的 `hainei_*` 表，并删除已废弃的活动设置；旧表暂时保留以确保升级安全，不会改写现有文件和存储配置。

## 使用方式

### 管理员

在 `/adminLogin` 登录，然后进入 **用户管理**：

- 启用或关闭 Blossom 写操作；
- 复制根据当前请求域名生成的 Server URL；
- 添加、查看、删除允许的 Nostr pubkey。

关闭 Blossom 后，已签名的 `PUT` 和 `DELETE` 返回 `403 {"error":"blossom_disabled"}`；已有媒体的 `GET` 和 `HEAD` 读取保持正常。

### Nostr 用户

本项目不提供 Blossom Web Login、NIP-07 登录或 Web Upload Dashboard。用户只需把 Server URL 添加到兼容客户端。客户端用用户私钥签署 BUD-11 请求；服务器验证 kind `24242`、签名、action、expiration、server/hash scope 和 pubkey 白名单后，调用 ImgBed 存储引擎。

### Service 集成（包括 HaiNei）

使用现有 API Token 系统创建 `type: "service"`、且权限仅为 `issue_upload_token` 的 token。可信后端调用 `POST /api/service/upload-token`；原始短期 token 只返回一次，D1 只保存 SHA-256 哈希。默认 TTL 为 3600 秒，可配置的安全上限为 86400 秒。scope 固定为 `upload`，subject 必须是 64 位十六进制 Nostr pubkey。

管理员登录后可调用现有 `POST /api/manage/apiTokens`，请求 JSON 为 `{"name":"HaiNei Backend","type":"service","owner":"hainei-worker","permissions":["issue_upload_token"]}`。返回的原始值应直接保存为后端 secret，不能作为前端 token。

## API

Blossom：

```text
HEAD   /upload
PUT    /upload
POST   /upload（短期上传 token 的 raw Blossom 上传）
GET    /<sha256>[.<ext>]
HEAD   /<sha256>[.<ext>]
DELETE /<sha256>[.<ext>]
POST   /api/service/upload-token
```

签发请求使用 `Authorization: Bearer <service API token>`，JSON 为 `{"subject":"<64位十六进制pubkey>","ttl":3600}`。成功返回 `201`，包含 `token`、`subject`、`scope`、`issuedAt`、`expiresAt`。上传时向 `HEAD`、`PUT` 或受支持的 raw `POST /upload` 发送短期 Bearer token。

`BLOSSOM_UPLOAD_TOKEN_MAX_TTL_SECONDS` 控制签发上限。`HAINEI_MAX_FILE_SIZE_BYTES`、`HAINEI_DAILY_UPLOAD_COUNT`、`HAINEI_DAILY_UPLOAD_BYTES` 在可获得真实文件大小的 Blossom 端再次强制执行配额，应与 HaiNei Worker 配置保持一致。

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
