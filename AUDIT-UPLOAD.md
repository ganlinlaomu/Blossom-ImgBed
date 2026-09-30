# HaiNei upload compatibility and Blossom hardening

These changes are committed locally for review. They have not been published or deployed. HaiNei draft PRs #277, #278 and #279 have been created; deploy the Blossom companion before the HaiNei Worker/client changes in #278.

## Content-bound upload capabilities

The issuer accepts `contentHash` (lowercase SHA-256 string) and `maxBytes` (positive integer). Supplying either requires both, within the configured file maximum. The response attests `bindingVersion: 1`, `singleUse: true`, the hash and byte limit. HEAD validates the advertised hash/length without consuming the token. PUT checks actual bytes/hash and atomically consumes the bound capability once. Failure after consumption requires a fresh token.

Compatibility is the rollout default: historical unbound tokens continue to work with actual-byte quota enforcement. After all clients use bindingVersion 1, set `BLOSSOM_REQUIRE_BOUND_UPLOAD_TOKENS=true` to reject both issuance and use of legacy unbound capabilities. This setting affects service-issued bearer tokens; it does not remove the BUD-11 signed upload path.

Child capabilities with `parent_token_id` recheck the parent service token on authentication and again before consumption. Deleting the parent, removing `issue_upload_token`, or expiring the parent denies subsequent use. Parentless historical tokens cannot be associated with a revoked issuer; expire or explicitly revoke those rows during retirement.

## Migration and deployment

Docker migrations use a `schema_migrations` ledger and one SQLite transaction per file. Versions sort numerically, repeated migrations skip, changed applied migrations stop startup, and real SQL failures roll back and stop startup. For older databases without a ledger, existing ADD COLUMN fields are inspected and skipped individually; remaining columns and indexes still execute. This repairs partially applied v2.14 upgrades. Existing columns are preserved, not rebuilt or type-converted.

The Cloudflare deployment script runs init.sql, inspects the upload token table, and adds only missing `content_hash`, `max_bytes`, and `used_at` columns before deploying. Failed inspection or ALTER stops deployment. This also supports retry after a partial upgrade. This procedure was tested through the deployment runner contract; no remote D1 operation was performed here.

For deployments bypassing that script, apply the missing v2.14 columns and `database/migrations/v2.15.0_blob_operations.sql` before deploying. v2.14's raw ALTER script is not independently repeatable: inspect the table before rerunning it. New databases use the updated init.sql. Back up the database before upgrades and retain the new columns when rolling back the client. Do not reinterpret an already bound token as reusable.

## Upload, delete and resource coordination

Blossom mutations now require a D1 coordination binding (SQLite in Docker). KV-only deployments must add D1 and provision the Blossom schema before upgrading; they receive 503 for writes otherwise. Existing read paths and the general ImgBed APIs retain their behavior. Mixed KV/D1 deployments still need consistent Blossom metadata and ownership in D1.

A per-hash operation record excludes competing Blossom upload/delete requests until the active operation finishes. Conflicts return 409 `blob_operation_in_progress`. Uploads deduplicate under that lock, and a thrown/failed physical deletion restores the requesting owner's metadata. This coordination covers the Blossom endpoints, not independent administrator or external storage deletions.

Body receivers also reserve a global D1 slot before buffering. The default `BLOSSOM_MAX_CONCURRENT_UPLOADS=2` bounds concurrent uploads across instances; saturation returns 429. The stream has a 15-second idle timeout, a 120-second total read deadline, actual-byte limits and abort cancellation. Bodies remain buffered for hashing and the existing storage pipeline; this is not streaming-to-storage. Measure memory before increasing file size or concurrency, especially in Workers.

The service-token issuer reads at most 8 KiB of JSON, with a 5-second idle and 10-second total deadline. Atomic limits default to 120 requests/minute per issuer and 600 globally, configured by `BLOSSOM_TOKEN_ISSUES_PER_MINUTE` and `BLOSSOM_TOKEN_ISSUES_PER_MINUTE_GLOBAL`. Expired issuer-rate and upload-token rows are cleaned in bounded batches. Internal exception details and upstream upload response bodies are not returned to callers.

## Crash recovery and remaining limits

Operation locks and upload slots do not expire automatically. An old physical DELETE must never resume after a replacement lock is granted. A process crash can therefore leave a hash blocked or a concurrency slot occupied, prioritizing storage consistency over availability.

Recovery procedure:

1. Disable Blossom writes and stop every instance that could still execute the affected operation. A timestamp alone does not prove an operation has stopped.
2. Inspect `blossom_blob_operations` and `blossom_upload_slots` alongside blob/ownership metadata and the underlying ImgBed storage. Reconcile missing files, interrupted ownership changes and duplicate/orphan uploads before reopening writes.
3. Remove only the reconciled operation row with its exact hash and owner, and only the confirmed abandoned upload-slot owner. Restart and verify upload/read/delete before enabling writes.

Actual-byte quota failure release uses the reservation's original UTC date. A process crash can conservatively leave quota charged until the next day. Remote storage writes and database metadata are not one transaction; an interrupted upload can leave orphan storage. This patch does not provide a durable quota reservation ledger, automatic orphan reconciliation or retry-safe recovery jobs. Those require a separate storage-recovery design; do not blindly release quota or delete files from timestamps alone.

## Validation

The upload tests now use Mocha and the existing better-sqlite3 dependency, so `npm test` includes them and supports the declared Node 20–22 runtime range. Validation here used Node 22; Node 20 was not tested. Node 24 exposed a native-module incompatibility and was not used for the final results.

The full suite passed 95 tests, including real SQLite concurrency, quota accounting, migration rollback/restart, parent revocation, issuer limits, chunked overflow, timeout/abort, concurrent upload versus delete, and owner restoration. The Worker route build and Wrangler deployment dry-run both passed. Real cloud deployment, physical storage failure/crash recovery and browser/phone testing were not performed.
