import { uploadQuotaPolicy } from './upload-quota.js';
import { BlossomError } from './errors.js';
import { getDatabase } from '../utils/databaseAdapter.js';

export const UPLOAD_TOKEN_SCOPE = 'upload';
export const UPLOAD_TOKEN_PREFIX = 'imgbed_upload_';
const DEFAULT_TTL_SECONDS = 3600;
const MAX_TTL_SECONDS = 86400;
const MIN_TTL_SECONDS = 60;
const PUBKEY_PATTERN = /^[0-9a-f]{64}$/;

function requireD1(env) {
    if (!env?.img_d1 || typeof env.img_d1.prepare !== 'function') {
        throw new BlossomError(503, 'upload_tokens_require_d1');
    }
    return env.img_d1;
}

function bytesToHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes) {
    return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function hashUploadToken(token) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    return bytesToHex(new Uint8Array(digest));
}

function readMaximumTtl(env) {
    const configured = Number(env?.BLOSSOM_UPLOAD_TOKEN_MAX_TTL_SECONDS);
    if (!Number.isSafeInteger(configured) || configured < MIN_TTL_SECONDS) return MAX_TTL_SECONDS;
    return Math.min(configured, MAX_TTL_SECONDS);
}

export function normalizeUploadTokenTtl(value, env) {
    const ttl = value === undefined || value === null ? DEFAULT_TTL_SECONDS : Number(value);
    const maximum = readMaximumTtl(env);
    if (!Number.isSafeInteger(ttl) || ttl < MIN_TTL_SECONDS || ttl > maximum) {
        throw new BlossomError(400, `ttl must be an integer between ${MIN_TTL_SECONDS} and ${maximum}`);
    }
    return ttl;
}

export function normalizeUploadTokenSubject(value) {
    if (typeof value !== 'string' || !PUBKEY_PATTERN.test(value.trim().toLowerCase())) {
        throw new BlossomError(400, 'subject must be a 64-character hex Nostr pubkey');
    }
    return value.trim().toLowerCase();
}

export async function issueUploadToken(
    env,
    { subject, ttl, contentHash, maxBytes, issuedBy = null, parentTokenId = null },
    now = Math.floor(Date.now() / 1000),
) {
    const database = requireD1(env);
    const normalizedSubject = normalizeUploadTokenSubject(subject);
    const ttlSeconds = normalizeUploadTokenTtl(ttl, env);
    const bound = contentHash !== undefined || maxBytes !== undefined;
    if (
        bound &&
        (typeof contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(contentHash) ||
            !Number.isSafeInteger(maxBytes) ||
            maxBytes <= 0 ||
            maxBytes > uploadQuotaPolicy(env).maxFileSize)
    )
        throw new BlossomError(400, 'invalid_upload_binding');
    if (!bound && String(env.BLOSSOM_REQUIRE_BOUND_UPLOAD_TOKENS) === 'true') {
        throw new BlossomError(400, 'upload_binding_required');
    }
    const token = `${UPLOAD_TOKEN_PREFIX}${randomHex(32)}`;
    const tokenHash = await hashUploadToken(token);
    const expiresAt = now + ttlSeconds;

    await database
        .prepare(
            `
        INSERT INTO blossom_upload_tokens
            (token_hash, subject_pubkey, scope, issued_by, parent_token_id, created_at, expires_at, revoked_at, content_hash, max_bytes, used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)
    `,
        )
        .bind(
            tokenHash,
            normalizedSubject,
            UPLOAD_TOKEN_SCOPE,
            issuedBy,
            parentTokenId,
            now,
            expiresAt,
            contentHash ?? null,
            maxBytes ?? null,
        )
        .run();

    return {
        token,
        subject: normalizedSubject,
        scope: UPLOAD_TOKEN_SCOPE,
        issuedAt: now,
        expiresAt,
        ...(bound ? { bindingVersion: 1, contentHash, maxBytes, singleUse: true } : {}),
    };
}

function bearerToken(request) {
    const header = request.headers.get('Authorization');
    const match = typeof header === 'string' ? /^Bearer\s+([^\s]+)$/i.exec(header.trim()) : null;
    return match?.[1] || null;
}

export async function assertUploadTokenParent(env, parentTokenId, now = Math.floor(Date.now() / 1000)) {
    if (!parentTokenId) return; // Historical tokens may have no issuer ID.
    const value = await getDatabase(env).get('manage@sysConfig@security');
    const parent = (value ? JSON.parse(value) : {}).apiTokens?.tokens?.[parentTokenId];
    const expiresAt = parent?.expiresAt == null ? null : Date.parse(parent.expiresAt);
    if (!parent || parent.type !== 'service' ||
        !Array.isArray(parent.permissions) || !parent.permissions.includes('issue_upload_token') ||
        (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= now * 1000))) {
        throw new BlossomError(401, 'revoked_upload_token_parent');
    }
}

export async function authenticateUploadToken(request, env, now = Math.floor(Date.now() / 1000)) {
    const token = bearerToken(request);
    if (!token || !token.startsWith(UPLOAD_TOKEN_PREFIX)) {
        return { matched: false, authorized: false };
    }

    const tokenHash = await hashUploadToken(token);
    const row = await requireD1(env)
        .prepare(
            `
        SELECT token_hash, subject_pubkey, scope, issued_by, parent_token_id,
               created_at, expires_at, revoked_at, content_hash, max_bytes, used_at
        FROM blossom_upload_tokens WHERE token_hash = ?
    `,
        )
        .bind(tokenHash)
        .first();
    if (!row) throw new BlossomError(401, 'invalid_upload_token');
    if (row.revoked_at !== null && row.revoked_at !== undefined) {
        throw new BlossomError(401, 'revoked_upload_token');
    }
    if (Number(row.expires_at) <= now) throw new BlossomError(401, 'expired_upload_token');
    if (row.used_at != null) throw new BlossomError(401, 'upload_token_already_used');
    if (row.scope !== UPLOAD_TOKEN_SCOPE) throw new BlossomError(403, 'invalid_upload_token_scope');
    if (!PUBKEY_PATTERN.test(String(row.subject_pubkey))) throw new BlossomError(401, 'invalid_upload_token_subject');

    if (!row.content_hash && String(env.BLOSSOM_REQUIRE_BOUND_UPLOAD_TOKENS) === 'true') {
        throw new BlossomError(401, 'upload_binding_required');
    }
    await assertUploadTokenParent(env, row.parent_token_id, now);

    return {
        matched: true,
        authorized: true,
        pubkey: row.subject_pubkey,
        scope: row.scope,
        parentTokenId: row.parent_token_id ?? null,
        expiresAt: Number(row.expires_at),
        tokenHash,
        contentHash: row.content_hash,
        maxBytes: row.max_bytes,
    };
}

export async function consumeBoundUploadToken(env, authorization, sha256, size) {
    await assertUploadTokenParent(env, authorization.parentTokenId);
    if (!authorization.contentHash) return; // Legacy callers still have actual-byte quota enforcement.
    if (sha256 !== authorization.contentHash || size > authorization.maxBytes)
        throw new BlossomError(409, 'upload_binding_mismatch');
    const now = Math.floor(Date.now() / 1000);
    const result = await requireD1(env)
        .prepare(
            `UPDATE blossom_upload_tokens SET used_at=?
      WHERE token_hash=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
        )
        .bind(now, authorization.tokenHash, now)
        .run();
    if (Number(result?.meta?.changes || 0) !== 1) throw new BlossomError(401, 'upload_token_already_used');
}
