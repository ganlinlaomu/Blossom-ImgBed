# HaiNei content-bound upload capabilities

The issuer accepts optional `contentHash` (lowercase SHA-256) and `maxBytes` (positive integer). If supplied, both are required, and maxBytes cannot exceed the configured upload maximum. The response attests `bindingVersion: 1`, `singleUse: true`, the hash and the byte limit. Old unbound tokens remain compatible; actual-byte quota enforcement still applies to them.

HEAD validates the advertised hash/length without consuming the token. PUT reads a bounded stream, calculates the actual hash/size, checks the binding and atomically marks the capability used. Two concurrent PUTs cannot both consume one capability. A failed PUT after consumption requires a fresh token. Actual-byte quota reservation uses the existing atomic SQL limit; failures release against the reservation's original UTC date, including across midnight. A crashed process may conservatively leave quota charged until the next day; no distributed transaction or automatic reservation reclamation is claimed.

The stream maximum also applies to ordinary Blossom uploads; it defaults to 25 MiB and uses `HAINEI_MAX_FILE_SIZE_BYTES`. Raise that setting deliberately if the installation already permits larger uploads. Keep HaiNei Worker and Blossom limits consistent.

Existing D1 deployments must run `database/migrations/v2.14.0_bound_upload_tokens.sql` before deploying the issuer/upload code. New databases use the updated init.sql. The three ALTER statements are not repeatable: after an interrupted migration, inspect the table and apply only missing columns. The Docker server discovers SQL migrations automatically; Cloudflare operators must execute the migration explicitly.

Deploy this companion change before the HaiNei Worker/client update. HaiNei fails closed with `blossom_binding_upgrade_required` when the issuer does not attest the binding. To roll back the client feature, keep the added columns and token reader; do not restore a reusable interpretation of already bound capabilities.

Run `node --test test/audit-upload.test.mjs` with Node 22.6+ (the SQLite built-in is required). These three tests execute real SQLite SQL for concurrent single-use claims and actual-byte quotas, and check early cancellation of chunked overflow. They passed on Node 24; the complete existing Mocha/production deployment suite was not run in this workspace.
