# Blossom-ImgBed

Blossom-ImgBed is a self-hosted [Blossom](https://github.com/hzrd149/blossom) media server for Nostr, powered by the CloudFlare-ImgBed multi-storage engine.

It keeps the two trust domains deliberately separate:

- Administrators sign in to the existing ImgBed Admin Dashboard to configure the server.
- Nostr users never sign in to the website. A compatible client signs every upload or delete request using standard BUD-11 authorization.

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

Allowlist membership grants only the right to call signed Blossom write/delete APIs. It does not create a web session, ImgBed user, Admin session, password, or access to `/api/manage/*`.

## Fresh install on Cloudflare

1. Deploy this repository using the Cloudflare GitHub integration.
2. Create a Cloudflare D1 database.
3. Bind the database to the Worker with the binding name `img_d1`.
4. Run this repository's complete [`database/init.sql`](database/init.sql) in the D1 Console.
5. Open `/adminLogin` and sign in. When no database or environment credentials exist, the initial credentials are `admin` / `admin`; change them immediately in Security Settings.
6. Open **User Management → Nostr Allowlist**.
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

Back up the database, then apply the non-destructive Blossom migrations in order:

```text
database/migrations/v2.8.0_add_blossom_metadata.sql
database/migrations/v2.9.0_add_blossom_allowlist.sql
database/migrations/v2.10.0_add_blossom_settings.sql
```

The migrations only add Blossom tables/indexes and the default disabled setting. They do not delete or rewrite existing files, settings, metadata, or storage configuration.

## Using the server

### Administrator

Sign in at `/adminLogin`, then open **User Management → Nostr Allowlist** to:

- enable or disable Blossom write operations;
- copy the request-derived Server URL;
- add, inspect, and remove allowed Nostr pubkeys.

Disabling Blossom rejects signed `PUT` and `DELETE` operations with `403 {"error":"blossom_disabled"}`. Existing media remains available through `GET` and `HEAD`.

### Nostr user

There is no Blossom web login or web upload dashboard. Add the server URL to a compatible Nostr client. The client uses the user's private key to sign each standard BUD-11 request; the server verifies the kind `24242` event, signature, action, expiration, server/hash scope, and pubkey allowlist before invoking ImgBed storage.

## Blossom endpoints

```text
HEAD   /upload
PUT    /upload
GET    /<sha256>[.<ext>]
HEAD   /<sha256>[.<ext>]
DELETE /<sha256>[.<ext>]
```

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
