import { BlossomError } from './errors.js';

function setting(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function uploadQuotaPolicy(env) {
    return {
        maxFileSize: setting(env?.HAINEI_MAX_FILE_SIZE_BYTES, 25 * 1024 * 1024, 1, 1024 * 1024 * 1024),
        dailyCount: setting(env?.HAINEI_DAILY_UPLOAD_COUNT, 100, 1, 100000),
        dailyBytes: setting(env?.HAINEI_DAILY_UPLOAD_BYTES, 1024 * 1024 * 1024, 1, 1024 * 1024 * 1024 * 1024),
    };
}

function usageDate(now = Date.now()) {
    return new Date(now).toISOString().slice(0, 10);
}

export async function assertUploadQuota(env, pubkey, size) {
    if (!env?.img_d1?.prepare) throw new BlossomError(503, 'upload_tokens_require_d1');
    const policy = uploadQuotaPolicy(env);
    if (size > policy.maxFileSize) throw new BlossomError(413, 'file_too_large');
    const row = await env.img_d1.prepare(`
        SELECT upload_count, upload_bytes FROM hainei_media_usage
        WHERE pubkey = ? AND usage_date = ?
    `).bind(pubkey, usageDate()).first();
    if (Number(row?.upload_count || 0) >= policy.dailyCount) throw new BlossomError(429, 'daily_upload_count_exceeded');
    if (Number(row?.upload_bytes || 0) + size > policy.dailyBytes) throw new BlossomError(429, 'daily_upload_bytes_exceeded');
}

export async function reserveUploadQuota(env, pubkey, size) {
    await assertUploadQuota(env, pubkey, size);
    const policy = uploadQuotaPolicy(env);
    const result = await env.img_d1.prepare(`
        INSERT INTO hainei_media_usage (pubkey, usage_date, upload_count, upload_bytes)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(pubkey, usage_date) DO UPDATE SET
            upload_count = upload_count + 1,
            upload_bytes = upload_bytes + excluded.upload_bytes
        WHERE upload_count < ? AND upload_bytes + excluded.upload_bytes <= ?
    `).bind(pubkey, usageDate(), size, policy.dailyCount, policy.dailyBytes).run();
    if (Number(result?.meta?.changes || 0) !== 1) throw new BlossomError(429, 'daily_upload_quota_exceeded');
}

export async function releaseUploadQuota(env, pubkey, size) {
    await env.img_d1.prepare(`
        UPDATE hainei_media_usage SET
            upload_count = MAX(0, upload_count - 1),
            upload_bytes = MAX(0, upload_bytes - ?)
        WHERE pubkey = ? AND usage_date = ?
    `).bind(size, pubkey, usageDate()).run();
}
