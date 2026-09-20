import { verifyNostrEvent } from './event.js';
import { BlossomError } from './errors.js';
import { BLOSSOM_EVENT_KIND } from './types.js';

const TOKEN_SCOPE_UPLOAD = 'blossom:upload';
const DEFAULT_CHALLENGE_TTL_SECONDS = 300;
const DEFAULT_TOKEN_TTL_SECONDS = 3600;
const d1SchemaPromises = new WeakMap();

function usesD1(env) {
    return !!(env?.img_d1 && typeof env.img_d1.prepare === 'function');
}

function readBoundedSeconds(value, fallback, maximum) {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) return fallback;
    return parsed;
}

function nowSeconds() {
    return Math.floor(Date.now() / 1000);
}

function randomHex(bytes) {
    const buffer = new Uint8Array(bytes);
    crypto.getRandomValues(buffer);
    return [...buffer].map(value => value.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function readTokenPolicy(env) {
    return {
        challengeTtlSeconds: readBoundedSeconds(env?.HAINEI_CHALLENGE_TTL_SECONDS, DEFAULT_CHALLENGE_TTL_SECONDS, 3600),
        tokenTtlSeconds: readBoundedSeconds(env?.HAINEI_UPLOAD_TOKEN_TTL_SECONDS, DEFAULT_TOKEN_TTL_SECONDS, 86400),
    };
}

async function ensureD1Schema(env) {
    if (!usesD1(env)) return;

    const database = env.img_d1;
    let schemaPromise = d1SchemaPromises.get(database);
    if (!schemaPromise) {
        schemaPromise = (async () => {
            await database.prepare(`
                CREATE TABLE IF NOT EXISTS blossom_hainei_challenges (
                    challenge TEXT PRIMARY KEY,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    used_at INTEGER
                )
            `).run();
            await database.prepare(`
                CREATE TABLE IF NOT EXISTS blossom_hainei_tokens (
                    token_hash TEXT PRIMARY KEY,
                    pubkey TEXT NOT NULL,
                    scope TEXT NOT NULL,
                    client_info TEXT,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL
                )
            `).run();
            const columnInfo = await database.prepare('PRAGMA table_info(blossom_hainei_tokens)').all();
            const hasClientInfoColumn = Array.isArray(columnInfo?.results)
                && columnInfo.results.some(column => column.name === 'client_info');
            if (!hasClientInfoColumn) {
                try {
                    await database.prepare('ALTER TABLE blossom_hainei_tokens ADD COLUMN client_info TEXT').run();
                } catch (error) {
                    if (!String(error?.message || '').includes('duplicate column name')) {
                        throw error;
                    }
                }
            }
            await database.prepare(`
                CREATE INDEX IF NOT EXISTS idx_blossom_hainei_tokens_expires_at
                ON blossom_hainei_tokens(expires_at)
            `).run();
            await database.prepare(`
                CREATE INDEX IF NOT EXISTS idx_blossom_hainei_challenges_expires_at
                ON blossom_hainei_challenges(expires_at)
            `).run();
        })();
        d1SchemaPromises.set(database, schemaPromise);
        schemaPromise.catch(() => d1SchemaPromises.delete(database));
    }

    await schemaPromise;
}

function getTagValues(event, name) {
    return event.tags.filter(tag => tag[0] === name).map(tag => tag[1]);
}

function extractClientInfo(event) {
    if (!event || !Array.isArray(event.tags)) {
        return { client: null, version: null, isHaiNeiClient: false };
    }

    const clientTag = event.tags.find(tag => tag[0] === 'client');
    const versionTag = event.tags.find(tag => tag[0] === 'client_version');

    return {
        client: clientTag ? clientTag[1] : null,
        version: versionTag ? versionTag[1] : null,
        isHaiNeiClient: !!(clientTag && clientTag[1] === 'hainei'),
    };
}

function parseAuthorizationHeader(header) {
    if (!header || typeof header !== 'string') return null;
    const trimmed = header.trim();
    if (!trimmed.toLowerCase().startsWith('bearer ')) return null;
    const token = trimmed.slice(7).trim();
    return token || null;
}

async function consumeChallenge(env, challenge, now) {
    if (!/^[0-9a-f]{64}$/.test(challenge)) {
        throw new BlossomError(400, 'invalid_challenge');
    }

    if (!usesD1(env)) throw new BlossomError(503, 'hainei_access_requires_d1');
    await ensureD1Schema(env);
    const row = await env.img_d1.prepare(
        'SELECT challenge, expires_at, used_at FROM blossom_hainei_challenges WHERE challenge = ?'
    ).bind(challenge).first();
    if (!row) throw new BlossomError(400, 'invalid_challenge');
    if (row.used_at !== null && row.used_at !== undefined) {
        throw new BlossomError(409, 'challenge_already_used');
    }
    if (Number(row.expires_at) <= now) {
        throw new BlossomError(410, 'challenge_expired');
    }

    const result = await env.img_d1.prepare(
        `UPDATE blossom_hainei_challenges
         SET used_at = ?
         WHERE challenge = ? AND used_at IS NULL AND expires_at > ?`
    ).bind(now, challenge, now).run();
    if (Number(result?.meta?.changes || 0) === 0) {
        const refreshed = await env.img_d1.prepare(
            'SELECT expires_at, used_at FROM blossom_hainei_challenges WHERE challenge = ?'
        ).bind(challenge).first();
        if (refreshed && Number(refreshed.expires_at) <= now) {
            throw new BlossomError(410, 'challenge_expired');
        }
        throw new BlossomError(409, 'challenge_already_used');
    }
}

function validateExchangeEvent(event, challenge, request, now) {
    verifyNostrEvent(event);
    if (event.kind !== BLOSSOM_EVENT_KIND) {
        throw new BlossomError(401, `Nostr authorization kind must be ${BLOSSOM_EVENT_KIND}`);
    }

    const actions = getTagValues(event, 't');
    if (actions.length !== 1 || actions[0] !== 'hainei_access') {
        throw new BlossomError(401, 'Nostr authorization action must be hainei_access');
    }

    const challenges = getTagValues(event, 'challenge');
    if (challenges.length !== 1 || challenges[0] !== challenge) {
        throw new BlossomError(401, 'Nostr authorization challenge is invalid');
    }

    if (event.created_at > now + 60) {
        throw new BlossomError(401, 'Nostr authorization was created in the future');
    }
    if (event.created_at < now - 600) {
        throw new BlossomError(401, 'Nostr authorization is too old');
    }

    const expirations = getTagValues(event, 'expiration');
    if (expirations.length !== 1 || !/^\d+$/.test(expirations[0])) {
        throw new BlossomError(401, 'Nostr authorization requires one valid expiration tag');
    }
    const expiration = Number(expirations[0]);
    if (!Number.isSafeInteger(expiration) || expiration <= now) {
        throw new BlossomError(401, 'Nostr authorization has expired');
    }

    const servers = getTagValues(event, 'server');
    if (servers.length > 0) {
        const hostname = new URL(request.url).hostname.toLowerCase();
        if (!servers.includes(hostname)) {
            throw new BlossomError(401, 'Nostr authorization is not valid for this server');
        }
    }

    return expiration;
}

function parseExchangeEvent(request, body) {
    if (body?.event && typeof body.event === 'object') {
        return body.event;
    }
    const authorization = body?.authorization || request.headers.get('Authorization');
    if (!authorization || typeof authorization !== 'string') {
        throw new BlossomError(400, 'missing_authorization_event');
    }

    const match = /^Nostr (\S+)$/i.exec(authorization.trim());
    if (!match) throw new BlossomError(401, 'Malformed Nostr Authorization header');
    const normalized = match[1].replace(/-/g, '+').replace(/_/g, '/')
        .padEnd(Math.ceil(match[1].length / 4) * 4, '=');
    try {
        return JSON.parse(atob(normalized));
    } catch {
        throw new BlossomError(401, 'Malformed Nostr authorization event JSON');
    }
}

export async function createHaiNeiChallenge(env, now = nowSeconds()) {
    if (!usesD1(env)) throw new BlossomError(503, 'hainei_access_requires_d1');
    const { challengeTtlSeconds } = readTokenPolicy(env);
    const challenge = randomHex(32);
    const expiresAt = now + challengeTtlSeconds;
    await ensureD1Schema(env);
    await env.img_d1.prepare(
        'INSERT INTO blossom_hainei_challenges (challenge, created_at, expires_at, used_at) VALUES (?, ?, ?, NULL)'
    ).bind(challenge, now, expiresAt).run();

    return {
        challenge,
        expiresAt,
        ttlSeconds: challengeTtlSeconds,
    };
}

export async function exchangeHaiNeiChallengeForUploadToken(request, env, body) {
    if (!usesD1(env)) throw new BlossomError(503, 'hainei_access_requires_d1');
    const now = nowSeconds();
    const challenge = typeof body?.challenge === 'string' ? body.challenge.trim().toLowerCase() : '';
    if (!challenge) throw new BlossomError(400, 'challenge_required');

    const event = parseExchangeEvent(request, body);
    const eventExpiration = validateExchangeEvent(event, challenge, request, now);
    await consumeChallenge(env, challenge, now);

    const { tokenTtlSeconds } = readTokenPolicy(env);
    const token = `hainei_${randomHex(32)}`;
    const tokenHash = await sha256Hex(token);
    const expiresAt = now + Math.min(tokenTtlSeconds, Math.max(1, eventExpiration - now));
    const scope = TOKEN_SCOPE_UPLOAD;
    const clientInfo = extractClientInfo(event);
    const record = {
        tokenHash,
        pubkey: event.pubkey,
        scope,
        clientInfo: JSON.stringify(clientInfo),
        createdAt: now,
        expiresAt,
    };

    await ensureD1Schema(env);
    await env.img_d1.prepare(`
        INSERT INTO blossom_hainei_tokens (token_hash, pubkey, scope, client_info, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
        record.tokenHash,
        record.pubkey,
        record.scope,
        record.clientInfo,
        record.createdAt,
        record.expiresAt,
    ).run();

    return {
        token,
        tokenType: 'Bearer',
        scope,
        pubkey: event.pubkey,
        expiresAt,
        issuedAt: now,
    };
}

async function getTokenRecord(env, tokenHash) {
    if (!usesD1(env)) return null;
    await ensureD1Schema(env);
    const row = await env.img_d1.prepare(`
        SELECT token_hash, pubkey, scope, client_info, created_at, expires_at
        FROM blossom_hainei_tokens
        WHERE token_hash = ?
    `).bind(tokenHash).first();
    return row ? {
        tokenHash: row.token_hash,
        pubkey: row.pubkey,
        scope: row.scope,
        clientInfo: row.client_info,
        createdAt: Number(row.created_at),
        expiresAt: Number(row.expires_at),
    } : null;
}

export async function authenticateHaiNeiUploadToken(request, env) {
    const token = parseAuthorizationHeader(request.headers.get('Authorization'));
    if (!token) return { matched: false, authorized: false };

    const tokenHash = await sha256Hex(token);
    const record = await getTokenRecord(env, tokenHash);
    if (!record) throw new BlossomError(401, 'invalid_hainei_token');

    const now = nowSeconds();
    if (Number(record.expiresAt) <= now) {
        throw new BlossomError(401, 'expired_hainei_token');
    }
    if (record.scope !== TOKEN_SCOPE_UPLOAD) {
        throw new BlossomError(403, 'invalid_hainei_scope');
    }

    let clientInfo = { isHaiNeiClient: false };
    if (record.clientInfo) {
        try {
            const parsed = JSON.parse(record.clientInfo);
            if (parsed && typeof parsed === 'object') {
                clientInfo = parsed;
            }
        } catch {
            clientInfo = { isHaiNeiClient: false };
        }
    }

    return {
        matched: true,
        authorized: true,
        pubkey: record.pubkey,
        scope: record.scope,
        expiresAt: record.expiresAt,
        clientInfo,
    };
}
