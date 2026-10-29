import { BlossomError } from './errors.js';

function positiveSetting(value, fallback, maximum) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

// A DELETE lock never expires: a paused storage DELETE must never resume after
// another writer acquires a replacement lease. An UPLOAD lock is a lease. A
// Worker killed mid-request (client gone, limits hit) never runs its release,
// and a permanent upload lock would fail every retry of that same blob with 409.
// Taking over a stale upload is safe: the old request writes the same bytes,
// and its release only deletes rows it still owns.
export async function acquireBlobLock(env, sha256, operation, now = Math.floor(Date.now() / 1000)) {
    if (!env?.img_d1?.prepare) throw new BlossomError(503, 'blossom_writes_require_d1');
    const owner = crypto.randomUUID();
    const leaseSeconds = positiveSetting(env.BLOSSOM_UPLOAD_LOCK_LEASE_SECONDS, 300, 3600);
    const result = await env.img_d1.prepare(`
        INSERT INTO blossom_blob_operations (sha256, owner, operation, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(sha256) DO UPDATE SET
            owner = excluded.owner, operation = excluded.operation, created_at = excluded.created_at
        WHERE blossom_blob_operations.operation = 'upload' AND blossom_blob_operations.created_at <= ?
    `).bind(sha256, owner, operation, now, now - leaseSeconds).run();
    if (Number(result?.meta?.changes || 0) !== 1) throw new BlossomError(409, 'blob_operation_in_progress');
    return { sha256, owner };
}

export async function releaseBlobLock(env, lock) {
    await env.img_d1.prepare('DELETE FROM blossom_blob_operations WHERE sha256 = ? AND owner = ?')
        .bind(lock.sha256, lock.owner).run();
}

// Bodies are buffered in memory, and memory belongs to one isolate (or one
// Docker process), so the bound is kept per instance. A shared D1 counter
// limited nothing that matters here, held a slot for the whole time a slow
// client sent its body, and leaked a slot whenever a request was killed before
// its release ran — until every upload got 429.
let activeUploads = 0;
let activeBytes = 0;
const activeSlots = new Map();

export async function acquireUploadSlot(env, bytes = 0) {
    const maximum = positiveSetting(env?.BLOSSOM_MAX_CONCURRENT_UPLOADS, 8, 64);
    const byteBudget = positiveSetting(env?.BLOSSOM_MAX_INFLIGHT_UPLOAD_BYTES, 64 * 1024 * 1024, 1024 * 1024 * 1024);
    const reserved = Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
    // One upload always fits, so a single maximum-size file is never refused.
    if (activeUploads >= maximum || (activeUploads > 0 && activeBytes + reserved > byteBudget)) {
        throw new BlossomError(429, 'upload_concurrency_limit');
    }
    const owner = crypto.randomUUID();
    activeSlots.set(owner, reserved);
    activeUploads += 1;
    activeBytes += reserved;
    return owner;
}

export async function releaseUploadSlot(_env, owner) {
    if (!activeSlots.has(owner)) return;
    activeBytes -= activeSlots.get(owner);
    activeSlots.delete(owner);
    activeUploads -= 1;
}
