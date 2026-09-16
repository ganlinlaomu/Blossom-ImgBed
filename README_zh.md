# Blossom ImgBed

Blossom ImgBed 是基于 CloudFlare-ImgBed 存储能力开发的独立 Blossom 媒体服务器项目。

## 使用 Cloudflare GitHub App / Workers Builds 部署

将本仓库通过 Cloudflare GitHub App 连接到 Worker。本项目的部署脚本会在发布 Worker 前，自动对绑定的 D1 执行 [`database/init.sql`](database/init.sql)。该 SQL 是幂等的，后续重新部署时重复执行也不会删除现有数据。

Cloudflare 官方参考：[Git 集成](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/)、[Workers Builds 配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)与 [D1 绑定/初始化](https://developers.cloudflare.com/d1/get-started/)。

Workers Builds 建议配置：

```text
Build command:  npm run build
Deploy command: npm run deploy
```

此流程使用 Cloudflare 自带的 Git 集成，不需要 GitHub Actions，也不需要在 GitHub 仓库配置 `CLOUDFLARE_API_TOKEN` 或 `CLOUDFLARE_ACCOUNT_ID`。

### 全新安装

1. 点击上方 **Deploy to Cloudflare** 按钮，并将生成的仓库连接到 Workers Builds。
2. 保留自动识别的 Deploy command：`npm run deploy`。Cloudflare 会创建 `wrangler.jsonc` 声明的 D1/R2 资源，并将 D1 绑定为 `img_d1`。
3. 部署过程中，`npm run db:init:cloudflare` 会在发布 Worker 前，对该 binding 自动执行完整的 [`database/init.sql`](database/init.sql)。
4. 配置 Worker 运行时的管理员变量 `BASIC_USER` 与 `BASIC_PASS`，然后访问 Admin。

`img_d1` 始终指向同一个 D1，其中同时包含完整 ImgBed 基础 schema 与 Blossom schema：

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

全新安装只使用 Blossom-ImgBed 自己的 [`database/init.sql`](database/init.sql)。它已经包含 CloudFlare-ImgBed 的完整基础 schema 和当前 Blossom schema，不需要再到上游仓库寻找或先执行另一份 SQL。部署脚本会自动执行它；其中全部使用 `CREATE ... IF NOT EXISTS`，重复部署不会删除已有数据。

如果是手动连接 Git 仓库，请把 Workers Builds 的 Deploy command 设置为 `npm run deploy`。只使用 `npx wrangler deploy` 会跳过数据库初始化。对于旧部署或故障恢复，仍可在 D1 Console 手动执行 `database/init.sql`，或在已登录 Wrangler 的项目目录运行 `npm run db:init:cloudflare`。

已有 CloudFlare-ImgBed 数据库应保留原表和数据，再按需要执行 [`database/migrations/`](database/migrations/) 中的 Blossom 升级脚本。migration 用于旧数据库升级，不是全新安装的必需步骤。

如果 Admin 登录返回 `database_not_configured`，请检查 D1 binding 的变量名是否严格为 `img_d1`；如果返回 `database_not_initialized`，说明部署可能跳过或未能完成初始化命令，请重新执行 `npm run deploy`，或在 D1 Console 执行本项目的 `database/init.sql`。`GET /api/system/database-status` 可返回同样的安全诊断信息，不会暴露 database ID、密码或凭据。

---

以下保留 CloudFlare-ImgBed 基础功能说明。

<div align="center">
    <a href="https://github.com/MarSeventh/CloudFlare-ImgBed"><img width="80%" alt="logo" src="readme/banner.png" /></a>
    <p><em>🗂️ 打破图床边界，构建你的专属开源文件托管引擎。</em></p>
    <p>
        <a href="https://github.com/MarSeventh/CloudFlare-ImgBed/blob/main/README_zh.md">简体中文</a> | <a href="https://github.com/MarSeventh/CloudFlare-ImgBed/blob/main/README.md">English</a> | <a href="https://cfbed.sanyue.de">官方网站</a>
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
> **遇到问题请务必先查看[公告](https://github.com/MarSeventh/CloudFlare-ImgBed/discussions/categories/announcements)，重要通知和非兼容性更新内容均会在公告中说明！**


# 1. 💡 项目介绍

CloudFlare ImgBed 是支持 Docker 与 Serverless 部署的自建图床和文件托管方案，可将 **Telegram**、**Discord**、**Cloudflare R2**、**S3 兼容存储**、**Hugging Face**、**WebDAV** 等渠道统一接入一个管理界面。项目提供文件管理、身份认证、目录组织、内容审核、RESTful API 与 WebDAV，适用于个人图床、网站资源管理和轻量文件分发。 **[查看完整功能 →](https://cfbed.sanyue.de/guide/features.html)**

![CloudFlare](readme/海报.png)

## 🤝 合作伙伴

<table width="100%">
  <tr>
    <td align="center" width="20%">
      <strong><a href="https://www.cloudflare.com/">Cloudflare</a></strong>
    </td>
    <td align="center" width="20%">
      <strong><a href="https://edgeone.ai/?from=github">EdgeOne</a></strong>
    </td>
    <td align="center" width="20%">
      <strong><a href="https://www.hncloud.com/activity/activity_2026summer.html?k=MarSeventh">华纳云</a></strong>
    </td>
    <td align="center" width="20%">
      <strong><a href="https://www.svyun.com/recommend/AELZ0UeMz8K11Zg7pEXC">速维云</a></strong>
    </td>
    <td align="center" width="20%">
      <strong><a href="https://linux.do/t/topic/2578561">Linux DO</a></strong>
    </td>
  </tr>
  <tr>
    <td align="center"><a href="https://www.cloudflare.com/"><img src="readme/cloudflare-logo.png" alt="Cloudflare Logo" height="25"></a></td>
    <td align="center"><a href="https://edgeone.ai/?from=github"><img src="readme/edgeone-logo.png" alt="EdgeOne Logo" height="25"></a></td>
    <td align="center"><a href="https://www.hncloud.com/activity/activity_2026summer.html?k=MarSeventh"><img src="readme/hncloud-logo.png" alt="华纳云 Logo" height="25"></a></td>
    <td align="center"><a href="https://www.svyun.com/recommend/AELZ0UeMz8K11Zg7pEXC"><img src="readme/svyun-logo.png" alt="速维云 Logo" height="25"></a></td>
    <td align="center"><a href="https://linux.do/t/topic/2578561"><img src="readme/linuxdo-logo.png" alt="Linux DO Logo" height="25"></a></td>
  </tr>
  <tr>
    <td align="center"><sub>提供 CDN 加速及安全防护</sub></td>
    <td align="center"><sub>提供 CDN 加速及安全防护</sub></td>
    <td align="center"><sub>提供稳定、优质的云计算资源</sub></td>
    <td align="center"><sub>提供稳定、优质的云计算资源</sub></td>
    <td align="center"><sub>提供社区支持</sub></td>
  </tr>
</table>

# 2. 🖥️ 在线演示

**演示站点**：[CloudFlare ImgBed](https://cfbed.1314883.xyz/) · **访问密码**：`cfbed`

![文件上传页面](readme/upload.png)

<details>
    <summary>其他页面效果展示</summary>

<table>
  <tr>
    <td align="center" width="50%">
      <strong>登录页面</strong><br>
      <img src="readme/login.png" alt="登录页面" width="100%">
    </td>
    <td align="center" width="50%">
      <strong>上传进度</strong><br>
      <img src="readme/uploading.png" alt="上传进度" width="100%">
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <strong>文件管理</strong><br>
      <img src="readme/dashboard.png" alt="文件管理" width="100%">
    </td>
    <td align="center" width="50%">
      <strong>用户管理</strong><br>
      <img src="readme/customer-config.png" alt="用户管理" width="100%">
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <strong>状态页面</strong><br>
      <img src="readme/status-page.png" alt="状态页面" width="100%">
    </td>
    <td align="center" width="50%">
      <strong>公开画廊</strong><br>
      <img src="readme/public-gallery.png" alt="公开画廊" width="100%">
    </td>
  </tr>
</table>

</details>

# 3. 📚 文档与更新

## 📖 项目文档

项目文档涵盖部署方式、存储渠道配置、功能使用、RESTful API、WebDAV、版本升级及常见问题等内容。无论是首次部署还是日常维护，都可以在文档中找到对应的操作说明。

**[查看完整文档 →](https://cfbed.sanyue.de)**

## 📝 更新日志

了解项目的最新功能、问题修复、兼容性变更和升级注意事项。

[![更新日志](https://recent-update.cfbed.sanyue.de/cn)](https://cfbed.sanyue.de/guide/update-log.html)

# 4. 🌱 项目生态

欢迎前往 [CloudFlare ImgBed 生态](https://cfbed.sanyue.de/about/ecosystem.html)，探索社区提供的扩展、应用和教程，包括：

- **优秀的插件扩展**：浏览器扩展，Typecho、WordPress、Obsidian 等平台的集成插件，OpenList 驱动等
- **丰富的周边应用**：桌面客户端、Bot 辅助工具等
- **AI 智能体应用**：项目官方 Skill 及相关工具
- **优质的教程内容**：内容创作者分享的优质视频和图文教程

您也可以向社区分享自己的作品，提交规范请参见[生态建设征集令](https://github.com/MarSeventh/CloudFlare-ImgBed/discussions/606)，期待您的参与！

# 5. 💝 支持与赞助

## ☕ 支持项目

开源项目的维护需要持续投入时间和精力。如果 CloudFlare ImgBed 对您有所帮助，欢迎支持项目持续发展。

<p align="center">
  <a href="https://afdian.com/a/marseventh"><img src="https://img.shields.io/badge/爱发电-946CE6?style=for-the-badge&logo=afdian&logoColor=white" height="36" alt="通过爱发电支持"></a>
  &nbsp;&nbsp;
  <a href="readme/weixin-reward.png"><img src="https://img.shields.io/badge/微信赞赏-07C160?style=for-the-badge&logo=wechat&logoColor=white" height="36" alt="通过微信赞赏支持"></a>
</p>

## 💖 赞助者

感谢每一位赞助者对本项目的支持！您的支持帮助项目持续维护，也为 CloudFlare ImgBed 的长期改进提供动力。

[![赞助者](https://afdian-sponsors.sanyue.de/image?columns=12)](https://afdian.com/a/marseventh)

# 6. 👥 项目社区

## 🧑‍💻 贡献者

感谢所有为项目贡献代码、文档、创意和反馈的开发者！

[![贡献者](https://contrib.rocks/image?repo=Marseventh/Cloudflare-ImgBed)](https://github.com/MarSeventh/CloudFlare-ImgBed/graphs/contributors)

## ⭐ Star 趋势

**如果这个项目对您有所帮助，欢迎点亮一个 Star ⭐，感谢您的支持！**

<a href="https://github.com/MarSeventh/CloudFlare-ImgBed">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://marseventh.github.io/CloudFlare-ImgBed/star-history-dark.svg" />
   <source media="(prefers-color-scheme: light)" srcset="https://marseventh.github.io/CloudFlare-ImgBed/star-history-light.svg" />
   <img alt="Star-History" src="https://marseventh.github.io/CloudFlare-ImgBed/star-history-light.svg" />
 </picture>
</a>

# 7. ⚖️ 开源协议与相关项目

## 📄 开源协议

> [!IMPORTANT]
> 本项目基于 [MIT License](LICENSE) 开源。您可以自由使用、修改和分发本项目，但须在软件的所有副本或重要部分中保留原始版权及许可声明。

## 🔗 相关开源项目

- **Web 前端**：[MarSeventh/Sanyue-ImgHub](https://github.com/MarSeventh/Sanyue-ImgHub)
- **桌面客户端**：[MarSeventh/satellite](https://github.com/MarSeventh/satellite)
- **上游项目**：[cf-pages/Telegraph-Image](https://github.com/cf-pages/Telegraph-Image)

CloudFlare ImgBed 由 Telegraph-Image 发展而来，感谢原项目作者及所有贡献者。
