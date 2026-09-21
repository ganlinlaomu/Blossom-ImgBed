# Blossom-ImgBed

Blossom-ImgBed is a self-hosted [Blossom](https://github.com/hzrd149/blossom) media server for Nostr, powered by the CloudFlare-ImgBed multi-storage engine.

It keeps three trust domains deliberately separate:

- Administrators sign in to the existing ImgBed Admin Dashboard to configure the server.
- Nostr users never sign in to the website. A compatible client signs every upload or delete request using standard BUD-11 authorization.
- Trusted backend integrations use explicitly permissioned API service tokens. A service token with only `issue_upload_token` may mint a short-lived, per-pubkey upload token; it is not an administrator.

Blossom is a protocol and authorization layer. Files continue to use the existing ImgBed routing, quota, load-balancing, and storage implementations for Cloudflare R2, Telegram, S3-compatible storage, WebDAV, Hugging Face, and Discord.

## Architecture

```text
Public /                         Blossom API
  └─ project landing page         └─ BUD-11 signature
       └─ Admin Login                  └─ pubkey allowlist
            └─ ImgBed Admin                 └─ ImgBed storage engine
                 └─ Blossom Settings             ├─ R2 / S3
                      ├─ Enable                   ├─ Telegram / Discord
                      ├─ Server URL               └─ WebDAV / Hugging Face
                      └─ Pubkey allowlist
```

External Nostr uploads always require allowlist membership. Client names, versions, headers, origins, referrers, and user agents never affect authorization. Service-issued tokens are a separate upload-only path and cannot access `/api/manage/*`, issue another token, list media, or delete media.

## Fresh install on Cloudflare

1. Deploy this repository using the Cloudflare GitHub integration.
2. Create a Cloudflare D1 database.
3. Bind the database to the Worker with the binding name `img_d1`.
4. Run this repository's complete [`database/init.sql`](database/init.sql) in the D1 Console.
5. Open `/adminLogin` and sign in. When no database or environment credentials exist, the initial credentials are `admin` / `admin`; change them immediately in Security Settings.
6. Open **User Management**.
7. Enable Blossom.
8. Add each allowed Nostr identity as an `npub1…` value or 64-character hex pubkey.
9. Copy the displayed Server URL into a Blossom-compatible Nostr client.

`database/init.sql` is self-contained. A new deployment does not need an upstream CloudFlare-ImgBed SQL file first.

### Administrator credential priority

Credentials resolve in this order:

1. Existing database security configuration
2. `BASIC_USER` / `BASIC_PASS` environment bindings
3. `admin` / `admin` fresh-install fallback

Passwords retain PBKDF2 storage, legacy SHA-256 and plaintext compatibility, automatic rehashing, password changes, and session invalidation.

## Upgrade an existing ImgBed database

Back up the database, then apply every unapplied file in `database/migrations/` in version order. The current service-token migration adds `blossom_upload_tokens` and the shared `hainei_*` tables and removes obsolete active settings. Deprecated tables are retained temporarily for safe upgrades; existing files and storage configuration are not rewritten.

## Using the server

### Administrator

Sign in at `/adminLogin`, then open **User Management** to:

- enable or disable Blossom write operations;
- copy the request-derived Server URL;
- add, inspect, and remove allowed Nostr pubkeys.

Disabling Blossom rejects signed `PUT` and `DELETE` operations with `403 {"error":"blossom_disabled"}`. Existing media remains available through `GET` and `HEAD`.

### Nostr user

There is no Blossom web login or web upload dashboard. Add the server URL to a compatible Nostr client. The client uses the user's private key to sign each standard BUD-11 request; the server verifies the kind `24242` event, signature, action, expiration, server/hash scope, and pubkey allowlist before invoking ImgBed storage.

### Service integrations (including HaiNei)

Create an existing API token with `type: "service"` and the single permission `issue_upload_token`. The trusted backend calls `POST /api/service/upload-token`; the raw result is returned once and only its SHA-256 hash is stored in D1. The default TTL is 3600 seconds and the maximum is configurable up to 86400 seconds. The token scope is exactly `upload` and its subject is a 64-character hex Nostr pubkey.

An authenticated administrator can create it through the existing `POST /api/manage/apiTokens` API with `{"name":"HaiNei Backend","type":"service","owner":"hainei-worker","permissions":["issue_upload_token"]}`. Store the returned raw value directly as the backend secret; it is not a frontend token.

## Blossom endpoints

```text
HEAD   /upload
PUT    /upload
POST   /upload (raw Blossom upload when using a short-lived upload token)
GET    /<sha256>[.<ext>]
HEAD   /<sha256>[.<ext>]
DELETE /<sha256>[.<ext>]
POST   /api/service/upload-token
```

Issuer request: `{"subject":"<64-char hex pubkey>","ttl":3600}` with `Authorization: Bearer <service API token>`. Success is `201` with `token`, `subject`, `scope`, `issuedAt`, and `expiresAt`. Uploads send `Authorization: Bearer <short-lived token>` to `HEAD`, `PUT`, or supported raw `POST /upload`.

`BLOSSOM_UPLOAD_TOKEN_MAX_TTL_SECONDS` controls the issuer ceiling. `HAINEI_MAX_FILE_SIZE_BYTES`, `HAINEI_DAILY_UPLOAD_COUNT`, and `HAINEI_DAILY_UPLOAD_BYTES` enforce the same upload limits at Blossom, where the actual file size is known; keep them aligned with the HaiNei Worker values.

Management endpoints are protected by the existing Admin middleware:

```text
GET    /api/manage/blossom/settings
POST   /api/manage/blossom/settings
GET    /api/manage/blossom/pubkeys
POST   /api/manage/blossom/pubkeys
DELETE /api/manage/blossom/pubkeys/:pubkey
```

## Database diagnostics

- Without an `img_d1` binding, Admin Login returns `database_not_configured` and explains that the binding name must be `img_d1`.
- With an empty/incomplete D1, Admin Login returns `database_not_initialized`, lists only missing table names, and instructs the administrator to run `database/init.sql`.
- Incorrect credentials return `unauthorized` and remain distinct from database errors.

## Development

Requires Node.js 20–22.

```bash
npm ci
npm test
npm run build
```

## License

See [LICENSE](LICENSE).
