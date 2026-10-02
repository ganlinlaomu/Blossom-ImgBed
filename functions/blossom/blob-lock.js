import { BlossomError } from './errors.js';

// No automatic expiry: a paused storage DELETE must never resume after another
// writer acquires a replacement lease. Crash recovery needs operator reconciliation.
export async function acquireBlobLock(env, sha256, operation) {
    if (!env?.img_d1?.prepare) throw new BlossomError(503, 'blossom_writes_require_d1');
    const owner = crypto.randomUUID();
    const result = await env.img_d1.prepare(`
        INSERT OR IGNORE INTO blossom_blob_operations (sha256, owner, operation, created_at)
        VALUES (?, ?, ?, ?)
    `).bind(sha256, owner, operation, Math.floor(Date.now() / 1000)).run();
    if (Number(result?.meta?.changes || 0) !== 1) throw new BlossomError(409, 'blob_operation_in_progress');
    return { sha256, owner };
}

export async function releaseBlobLock(env, lock) {
    await env.img_d1.prepare('DELETE FROM blossom_blob_operations WHERE sha256 = ? AND owner = ?')
        .bind(lock.sha256, lock.owner).run();
}

export async function acquireUploadSlot(env) {
    if (!env?.img_d1?.prepare) throw new BlossomError(503, 'blossom_writes_require_d1');
    const configured = Number(env.BLOSSOM_MAX_CONCURRENT_UPLOADS);
    const maximum = Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, 64) : 8;
    const owner = crypto.randomUUID();
    const result = await env.img_d1.prepare(`
        INSERT INTO blossom_upload_slots (owner, created_at)
        SELECT ?, ? WHERE (SELECT COUNT(*) FROM blossom_upload_slots) < ?
    `).bind(owner, Math.floor(Date.now() / 1000), maximum).run();
    if (Number(result?.meta?.changes || 0) !== 1) throw new BlossomError(429, 'upload_concurrency_limit');
    return owner;
}

export async function releaseUploadSlot(env, owner) {
    await env.img_d1.prepare('DELETE FROM blossom_upload_slots WHERE owner = ?').bind(owner).run();
}
