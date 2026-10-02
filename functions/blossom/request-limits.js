import { BlossomError } from './errors.js';

function limit(value, fallback) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 100000) : fallback;
}

export async function reserveTokenIssue(env, parentTokenId, now = Math.floor(Date.now() / 1000)) {
    if (!env?.img_d1?.prepare) throw new BlossomError(503, 'upload_tokens_require_d1');
    for (const [key, maximum] of [
        [`issuer:${parentTokenId}`, limit(env.BLOSSOM_TOKEN_ISSUES_PER_MINUTE, 480)],
        ['global', limit(env.BLOSSOM_TOKEN_ISSUES_PER_MINUTE_GLOBAL, 2400)],
    ]) {
        const result = await env.img_d1.prepare(`
            INSERT INTO blossom_token_issue_limits (bucket, count, expires_at) VALUES (?, 1, ?)
            ON CONFLICT(bucket) DO UPDATE SET count = count + 1
            WHERE count < ?
        `).bind(`${key}:${Math.floor(now / 60)}`, now + 120, maximum).run();
        if (Number(result?.meta?.changes || 0) !== 1) throw new BlossomError(429, 'token_issue_rate_limited');
    }
    // Keep each cleanup bounded even after a long idle period.
    await env.img_d1.prepare(`DELETE FROM blossom_token_issue_limits WHERE bucket IN (
        SELECT bucket FROM blossom_token_issue_limits WHERE expires_at <= ? LIMIT 100
    )`).bind(now).run();
    await env.img_d1.prepare(`DELETE FROM blossom_upload_tokens WHERE token_hash IN (
        SELECT token_hash FROM blossom_upload_tokens WHERE expires_at <= ? LIMIT 100
    )`).bind(now).run();
}
