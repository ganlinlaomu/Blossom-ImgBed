import { BlossomError } from './errors.js';
import { changed, d1Batch } from './d1.js';

function limit(value, fallback) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 100000) : fallback;
}

export async function reserveTokenIssue(env, parentTokenId, now = Math.floor(Date.now() / 1000), waitUntil = null) {
    if (!env?.img_d1?.prepare) throw new BlossomError(503, 'upload_tokens_require_d1');
    const db = env.img_d1;
    const counters = [
        [`issuer:${parentTokenId}`, limit(env.BLOSSOM_TOKEN_ISSUES_PER_MINUTE, 480)],
        ['global', limit(env.BLOSSOM_TOKEN_ISSUES_PER_MINUTE_GLOBAL, 2400)],
    ].map(([key, maximum]) => db.prepare(`
            INSERT INTO blossom_token_issue_limits (bucket, count, expires_at) VALUES (?, 1, ?)
            ON CONFLICT(bucket) DO UPDATE SET count = count + 1
            WHERE count < ?
        `).bind(`${key}:${Math.floor(now / 60)}`, now + 120, maximum));
    const results = await d1Batch(db, counters);
    if (!results.every(changed)) throw new BlossomError(429, 'token_issue_rate_limited');

    // Keep each cleanup bounded even after a long idle period. It is not part
    // of the decision, so it runs after the response when the runtime allows.
    const cleanup = d1Batch(db, [
        db.prepare(`DELETE FROM blossom_token_issue_limits WHERE bucket IN (
            SELECT bucket FROM blossom_token_issue_limits WHERE expires_at <= ? LIMIT 100
        )`).bind(now),
        db.prepare(`DELETE FROM blossom_upload_tokens WHERE token_hash IN (
            SELECT token_hash FROM blossom_upload_tokens WHERE expires_at <= ? LIMIT 100
        )`).bind(now),
    ]).catch(error => console.error('Failed to clean up Blossom token rows:', error));
    if (typeof waitUntil === 'function') waitUntil(cleanup);
    else await cleanup;
}
