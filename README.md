# Blossom ImgBed

*A Blossom-compatible Nostr media server powered by CloudFlare-ImgBed multi-storage backends.*

**Status: Early development**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ganlinlaomu/Blossom-ImgBed)

Blossom ImgBed is an independent project based on CloudFlare-ImgBed, designed to add Blossom protocol support, Nostr public-key authentication, and public multi-storage media hosting.

The initial Blossom core is implemented as an additive protocol layer. It reuses CloudFlare-ImgBed's existing storage, channel, upload, read/proxy, and deletion infrastructure instead of reimplementing storage providers.

## Deploy to Cloudflare

Connect this repository to a Worker with the Cloudflare GitHub App / Workers Builds. Workers Builds deploys the code when the configured production branch changes; it does **not** execute this repository's SQL file in D1. D1 schema initialization is a one-time manual step.

Cloudflare references: [Git integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/), [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), and [D1 binding/setup](https://developers.cloudflare.com/d1/get-started/).

Use these Workers Builds commands:

```text
Build command:  npm run build
Deploy command: npx wrangler deploy
```

This deployment model uses Cloudflare's Git integration. It does not require a GitHub Actions workflow, `CLOUDFLARE_API_TOKEN`, or `CLOUDFLARE_ACCOUNT_ID` repository secrets.

### Fresh installation

1. Deploy Blossom ImgBed from this GitHub repository with Cloudflare Workers Builds.
2. In Cloudflare D1, create one database, for example `blossom-imgbed-db`.
3. Open the deployed Worker, add a **D1 database** binding, select that database, and set **Variable name** to exactly `img_d1`.
4. Open the database's **Console**, paste the complete [`database/init.sql`](database/init.sql), and execute it once.
5. Optionally bind an R2 bucket as `img_r2` if you want to use Cloudflare R2 storage. R2 is not required for Admin login; Telegram, S3, WebDAV, Hugging Face, Discord, and the other existing storage providers remain available.
6. Configure the Worker runtime secrets and open the Admin page:

* `BASIC_USER`: administrator username
* `BASIC_PASS`: a strong administrator password

The `img_d1` binding points to a single database containing both the complete ImgBed base schema and the Blossom additions:

```text
img_d1
├── files
├── settings
├── index_operations
├── index_metadata
├── other_data
├── blossom_blobs
├── blossom_ownership
└── blossom_allowed_pubkeys
```

The local [`database/init.sql`](database/init.sql) is the only schema file required for a fresh installation. It already contains the full CloudFlare-ImgBed base schema plus the current Blossom schema; do not fetch or execute an SQL file from the upstream repository first. The script is idempotent (`CREATE ... IF NOT EXISTS`) and can be run again without deleting existing rows.

For an existing CloudFlare-ImgBed database, keep its existing base tables and data, then apply only the required files in [`database/migrations/`](database/migrations/) to add Blossom tables. Migrations are for upgrades; they are not prerequisites for a fresh install.

If Admin login reports `database_not_configured`, add the D1 binding with the exact variable name `img_d1`. If it reports `database_not_initialized`, run this project's `database/init.sql` in the D1 Console. `GET /api/system/database-status` provides the same safe diagnostic state without returning database IDs or credentials.

## Blossom Support

PR1 adds the first Blossom protocol surface while keeping the original ImgBed UI and APIs intact:

* BUD-11 Nostr authorization using signed kind `24242` events
* `PUT /upload` (BUD-02)
* `GET /<sha256>` and `HEAD /<sha256>` (BUD-01)
* `DELETE /<sha256>` (BUD-12)
* SHA-256 validation, basic deduplication, and many-to-many pubkey ownership

Set `BLOSSOM_ENABLED=true` to enable these endpoints. BUD-11 events are accepted for five minutes by default; deployments can set `BLOSSOM_AUTH_MAX_AGE_SECONDS` to another non-negative value (maximum one day). `BLOSSOM_AUTH_FUTURE_SKEW_SECONDS` defaults to `0` to follow BUD-11's requirement that `created_at` be in the past, but can be set up to 300 seconds when controlled clients require clock-skew tolerance.

Existing D1 installations can apply [`database/migrations/v2.8.0_add_blossom_metadata.sql`](database/migrations/v2.8.0_add_blossom_metadata.sql). Fresh installations receive these tables from `database/init.sql`. Docker/SQLite deployments initialize the complete schema automatically. KV deployments use the isolated `manage@blossom@...` keyspace.

## Blossom Upload Access

Blossom write access is allowlist-only. An administrator must add a Nostr public key on the **Blossom Access** page at `/blossom-access.html` before that key can upload or delete blobs. The page is linked from the existing admin screens and uses the existing ImgBed administrator session; it does not introduce another password or user system.

The admin interface accepts either a 64-character hex public key or an `npub`. Values are decoded and stored as lowercase hex. It never accepts or requests an `nsec` or any other private key.

Access rules are:

* `GET /<sha256>` and `HEAD /<sha256>` remain public.
* `PUT /upload` requires valid BUD-11 authentication and a pubkey in the allowlist.
* `DELETE /<sha256>` requires valid BUD-11 authentication, a pubkey in the allowlist, and existing blob ownership.
* Removing a pubkey only revokes future Blossom write access; it does not delete existing blobs or ownership metadata.

The allowlist admin API is protected by the existing `/api/manage` administrator authentication:

```text
GET    /api/manage/blossom/pubkeys
POST   /api/manage/blossom/pubkeys
DELETE /api/manage/blossom/pubkeys/<pubkey>
```

Existing D1 installations can also apply [`database/migrations/v2.9.0_add_blossom_allowlist.sql`](database/migrations/v2.9.0_add_blossom_allowlist.sql). Fresh installations receive this table from `database/init.sql`. Docker/SQLite initializes the complete schema automatically. KV deployments use isolated `manage@blossom@allowed-pubkey@...` keys.

## NIP-07 Web Login

The lightweight Blossom upload page is available at `/blossom-upload.html` and requires a NIP-07-compatible browser signer. Login proves control of a Nostr public key by signing a short-lived, domain-bound challenge; the verified pubkey must still exist in the administrator allowlist.

Private keys are never entered into or sent to Blossom ImgBed. Signing stays inside the user's NIP-07 extension. The resulting Web session is stored as a random server-side session token in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie and expires after 24 hours. `/api/blossom/auth/me` checks the allowlist again, so removing a pubkey immediately invalidates its Web access.

Authentication endpoints:

```text
GET  /api/blossom/auth/challenge
POST /api/blossom/auth/login
GET  /api/blossom/auth/me
POST /api/blossom/auth/logout
```

Login challenges expire after five minutes by default. `BLOSSOM_LOGIN_CHALLENGE_TTL_SECONDS` may be set from 60 through 600 seconds. Each challenge is deleted after one valid signed use to prevent replay.

Web uploads do not use an internal or session-only upload API. The browser hashes the selected file with Web Crypto, asks the NIP-07 signer to sign the standard kind `24242` BUD-11 upload event, and sends the file to the same `PUT /upload` endpoint used by external Blossom clients. The server independently verifies BUD-11, the allowlist, and the uploaded bytes before invoking the existing ImgBed storage pipeline.

```text
Browser
   │
   │ NIP-07
   ▼
Nostr Signature
   │
   ▼
Allowlist Check
   │
   ▼
Web Session
   │
   ▼
BUD-11 Upload
   │
   ▼
PUT /upload
   │
   ▼
Existing ImgBed Storage
```

The authorization value below is a placeholder for a Base64url-encoded, signed kind `24242` event. Never send an `nsec` or any other private key to the server.

```bash
sha256="$(sha256sum ./photo.jpg | cut -d ' ' -f 1)"

curl -X PUT "https://blossom.example/upload" \
  -H "Authorization: Nostr $BUD11_EVENT_BASE64URL" \
  -H "X-SHA-256: $sha256" \
  -H "Content-Type: image/jpeg" \
  --data-binary @./photo.jpg

curl -I "https://blossom.example/$sha256.jpg"

curl -X DELETE "https://blossom.example/$sha256" \
  -H "Authorization: Nostr $BUD11_DELETE_EVENT_BASE64URL"
```

## Architecture

```text
Nostr Client
│
│ BUD-11
▼
Blossom ImgBed
│
├── Blossom protocol
├── Nostr authentication
├── pubkey authorization
└── existing ImgBed storage layer
    │
    ├── Cloudflare R2
    ├── Telegram
    ├── S3
    ├── WebDAV
    ├── Hugging Face
    └── Discord
```

The Blossom layer will not reimplement any Storage Provider. Future Blossom APIs should reuse the storage, channel-selection, load-balancing, and upload infrastructure already provided by CloudFlare-ImgBed.

## Roadmap

### Phase 1

* Blossom protocol core
* BUD-11 authentication
* Nostr pubkey authorization
* PUT /upload
* GET /<sha256>
* HEAD /<sha256>
* DELETE /<sha256>

### Phase 2

* Pubkey ownership
* Upload quota
* Rate limiting
* Public upload policy

### Phase 3

* Nostr Web login
* NIP-07
* User media dashboard

### Phase 4

* Public Blossom service
* Abuse protection
* Moderation
* Multi-storage health/failover

## Credits

This project is based on CloudFlare-ImgBed.

Original project:
https://github.com/MarSeventh/CloudFlare-ImgBed

The original MIT [LICENSE](LICENSE) and copyright notice are retained.

## CloudFlare-ImgBed foundation documentation

<div align="center">
    <a href="https://github.com/MarSeventh/CloudFlare-ImgBed"><img width="80%" alt="logo" src="readme/banner.png" /></a>
    <p><em>🗂️ Beyond image hosting: an all-in-one, open-source file management hub.</em></p>
    <p>
        <a href="https://github.com/MarSeventh/CloudFlare-ImgBed/blob/main/README_zh.md">简体中文</a> | <a href="https://github.com/MarSeventh/CloudFlare-ImgBed/blob/main/README.md">English</a> | <a href="https://cfbed.sanyue.de/en">Official Website</a>
    </p>
    <p align="center">
        <a href="https://github.com/MarSeventh/CloudFlare-ImgBed/blob/main/LICENSE"><img src="https://img.shields.io/github/license/MarSeventh/CloudFlare-ImgBed" alt="License" /></a>
        <a href="https://github.com/MarSeventh/CloudFlare-ImgBed/releases"><img src="https://img.shields.io/github/release/MarSeventh/CloudFlare-ImgBed" alt="latest version" /></a>
        <a href="https://github.com/MarSeventh/CloudFlare-ImgBed/releases"><img src="https://img.shields.io/github/downloads/MarSeventh/CloudFlare-ImgBed/total?color=%239F7AEA&logo=github" alt="Downloads" /></a>
        <a href="https://hub.docker.com/r/marseventh/cloudflare-imgbed"><img src="https://img.shields.io/docker/pulls/marseventh/cloudflare-imgbed" alt="Docker Pulls" /></a>
        <a href="https://github.com/MarSeventh/CloudFlare-ImgBed/stargazers"><img src="https://img.shields.io/github/stars/MarSeventh/CloudFlare-ImgBed" alt="Stars" /></a>
        <a href="https://github.com/MarSeventh/CloudFlare-ImgBed/network/members"><img src="https://img.shields.io/github/forks/MarSeventh/CloudFlare-ImgBed" alt="Forks" /></a>
        <a href="https://atomgit.com/MarSeventh/CloudFlare-ImgBed"><img src="https://atomgit.com/MarSeventh/CloudFlare-ImgBed/star/badge.svg" alt="G-star" /></a>
    </p>
    <p align="center">
        <a href="https://trendshift.io/repositories/14324" target="_blank"><img src="https://trendshift.io/api/badge/repositories/14324" alt="GitHub Trending" width="250" /></a>
        <a href="https://hellogithub.com/repository/MarSeventh/CloudFlare-ImgBed" target="_blank"><img src="https://api.hellogithub.com/v1/widgets/recommend.svg?rid=71d65ace215945b0909d4c75c31b9fcb&claim_uid=6DsuqF4hInJWerv&theme=neutral" alt="Featured｜HelloGitHub" width="250" /></a>
    </p>
</div>

---

> [!IMPORTANT]
>
> **If you encounter issues, please check the [announcement](https://github.com/MarSeventh/CloudFlare-ImgBed/discussions/categories/announcements) first. Important notifications and non-compatible updates will be explained in the announcement!**


# 1. 💡 Introduction

CloudFlare ImgBed is a self-hosted image and file hosting solution for Docker and serverless environments, bringing **Telegram**, **Discord**, **Cloudflare R2**, **S3-compatible storage**, **Hugging Face**, **WebDAV**, and more into one management interface. It provides file management, authentication, directory organization, content moderation, a RESTful API, and WebDAV for personal image hosting, website asset management, and lightweight file distribution. **[View all features →](https://cfbed.sanyue.de/en/guide/features.html)**

![CloudFlare](readme/海报.png)

## 🤝 Partners

<table width="100%">
  <tr>
    <td align="center" width="20%">
      <strong><a href="https://www.cloudflare.com/">Cloudflare</a></strong>
    </td>
    <td align="center" width="20%">
      <strong><a href="https://edgeone.ai/?from=github">EdgeOne</a></strong>
    </td>
    <td align="center" width="20%">
      <strong><a href="https://www.hncloud.com/activity/activity_2026summer.html?k=MarSeventh">HuaNa Cloud</a></strong>
    </td>
    <td align="center" width="20%">
      <strong><a href="https://www.svyun.com/recommend/AELZ0UeMz8K11Zg7pEXC">SuWei Cloud</a></strong>
    </td>
    <td align="center" width="20%">
      <strong><a href="https://linux.do/t/topic/2578561">Linux DO</a></strong>
    </td>
  </tr>
  <tr>
    <td align="center"><a href="https://www.cloudflare.com/"><img src="readme/cloudflare-logo.png" alt="Cloudflare logo" height="25"></a></td>
    <td align="center"><a href="https://edgeone.ai/?from=github"><img src="readme/edgeone-logo.png" alt="EdgeOne logo" height="25"></a></td>
    <td align="center"><a href="https://www.hncloud.com/activity/activity_2026summer.html?k=MarSeventh"><img src="readme/hncloud-logo.png" alt="HuaNa Cloud logo" height="25"></a></td>
    <td align="center"><a href="https://www.svyun.com/recommend/AELZ0UeMz8K11Zg7pEXC"><img src="readme/svyun-logo.png" alt="SuWei Cloud logo" height="25"></a></td>
    <td align="center"><a href="https://linux.do/t/topic/2578561"><img src="readme/linuxdo-logo.png" alt="Linux DO logo" height="25"></a></td>
  </tr>
  <tr>
    <td align="center"><sub>Provides CDN acceleration and security protection</sub></td>
    <td align="center"><sub>Provides CDN acceleration and security protection</sub></td>
    <td align="center"><sub>Provides stable and high-quality cloud computing resources</sub></td>
    <td align="center"><sub>Provides stable and high-quality cloud computing resources</sub></td>
    <td align="center"><sub>Provides community support</sub></td>
  </tr>
</table>

# 2. 🖥️ Demo

**Demo Address**: [CloudFlare ImgBed](https://cfbed.1314883.xyz/) · **Access Password**: `cfbed`

![Upload Page](readme/upload.png)

<details>
    <summary>Other page screenshots</summary>

<table>
  <tr>
    <td align="center" width="50%">
      <strong>Login Page</strong><br>
      <img src="readme/login.png" alt="Login Page" width="100%">
    </td>
    <td align="center" width="50%">
      <strong>Upload Progress</strong><br>
      <img src="readme/uploading.png" alt="Upload Progress" width="100%">
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <strong>File Management</strong><br>
      <img src="readme/dashboard.png" alt="File Management" width="100%">
    </td>
    <td align="center" width="50%">
      <strong>User Management</strong><br>
      <img src="readme/customer-config.png" alt="User Management" width="100%">
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <strong>Status Page</strong><br>
      <img src="readme/status-page.png" alt="Status Page" width="100%">
    </td>
    <td align="center" width="50%">
      <strong>Public Gallery</strong><br>
      <img src="readme/public-gallery.png" alt="Public Gallery" width="100%">
    </td>
  </tr>
</table>

</details>

# 3. 📚 Documentation & Updates

## 📖 Documentation

The documentation covers deployment, storage configuration, feature usage, RESTful API integration, WebDAV, version upgrades, and troubleshooting. Whether you are deploying the project for the first time or maintaining an existing instance, you can find the relevant instructions here.

**[Read the full documentation →](https://cfbed.sanyue.de/en)**

## 📝 Changelog

Follow the latest features, bug fixes, compatibility changes, and upgrade notes.

[![Recent Updates](https://recent-update.cfbed.sanyue.de/en)](https://cfbed.sanyue.de/en/guide/update-log.html)

# 4. 🌱 Ecosystem

An open-source ecosystem grows through community support. Visit the [CloudFlare ImgBed Ecosystem](https://cfbed.sanyue.de/en/about/ecosystem.html) page to explore the following resources and more:

- **Plugin Extensions**: Browser extensions, integrations for Typecho, WordPress, and Obsidian, OpenList drivers, and more.
- **Companion Applications**: Desktop clients, bot tools, and more.
- **AI Agent Applications**: Official project skills and related tools.
- **Tutorials and Guides**: High-quality videos and articles from content creators.

Discover useful plugins, applications, and tutorials, or share your own work with the community. See the [Ecosystem Call for Contributions](https://github.com/MarSeventh/CloudFlare-ImgBed/discussions/606) for submission guidelines. We look forward to your participation!

# 5. 💝 Support & Sponsors

## ☕ Support the Project

Maintaining an open source project takes time and effort. If CloudFlare ImgBed has helped you, consider supporting its continued development.

<p align="center">
  <a href="https://afdian.com/a/marseventh"><img src="https://img.shields.io/badge/AFDIAN-946CE6?style=for-the-badge&logo=afdian&logoColor=white" height="36" alt="Support via Afdian"></a>
  &nbsp;&nbsp;
  <a href="readme/weixin-reward.png"><img src="https://img.shields.io/badge/WeChat_Pay-07C160?style=for-the-badge&logo=wechat&logoColor=white" height="36" alt="Support via WeChat Pay"></a>
</p>

## 💖 Sponsors

Thank you to every sponsor who supports this project! Your support helps sustain ongoing maintenance and drives the continued improvement of CloudFlare ImgBed.

[![Sponsors](https://afdian-sponsors.sanyue.de/image?columns=12)](https://afdian.com/a/marseventh)

# 6. 👥 Community

## 🧑‍💻 Contributors

Thank you to everyone who has contributed code, documentation, ideas, and feedback!

[![Contributors](https://contrib.rocks/image?repo=Marseventh/Cloudflare-ImgBed)](https://github.com/MarSeventh/CloudFlare-ImgBed/graphs/contributors)

## ⭐ Star History

**If you find the project useful, please consider giving it a Star ⭐. Thank you for your support!**

<a href="https://github.com/MarSeventh/CloudFlare-ImgBed">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://marseventh.github.io/CloudFlare-ImgBed/star-history-dark.svg" />
   <source media="(prefers-color-scheme: light)" srcset="https://marseventh.github.io/CloudFlare-ImgBed/star-history-light.svg" />
   <img alt="Star-History" src="https://marseventh.github.io/CloudFlare-ImgBed/star-history-light.svg" />
 </picture>
</a>

# 7. ⚖️ License & Related Projects

## 📄 License

> [!IMPORTANT]
> This project is licensed under the [MIT License](LICENSE). You may use, modify, and distribute it, provided that the original copyright and license notices are retained in all copies or substantial portions of the software.

## 🔗 Related Open Source Projects

- **Web frontend**: [MarSeventh/Sanyue-ImgHub](https://github.com/MarSeventh/Sanyue-ImgHub)
- **Desktop client**: [MarSeventh/satellite](https://github.com/MarSeventh/satellite)
- **Upstream project**: [cf-pages/Telegraph-Image](https://github.com/cf-pages/Telegraph-Image)

CloudFlare ImgBed evolved from Telegraph-Image. Thanks to its original authors and contributors.
