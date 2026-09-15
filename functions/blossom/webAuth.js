import { getDatabase } from '../utils/databaseAdapter.js';
import { BlossomError } from './errors.js';
import { verifyNostrEvent } from './event.js';

export const NIP98_AUTH_KIND = 27235;
const CHALLENGE_PREFIX = 'manage@blossom@login-challenge@';
const CHALLENGE_PATTERN = /^[0-9a-f]{64}$/;
const DEFAULT_CHALLENGE_TTL_SECONDS = 300;
const MAX_CHALLENGE_TTL_SECONDS = 600;
const FUTURE_SKEW_SECONDS = 30;

function hex(bytes) {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function randomChallenge() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return hex(bytes);
}

function challengeTtl(env) {
    const parsed = Number(env?.BLOSSOM_LOGIN_CHALLENGE_TTL_SECONDS);
    return Number.isSafeInteger(parsed) && parsed >= 60 && parsed <= MAX_CHALLENGE_TTL_SECONDS
        ? parsed
        : DEFAULT_CHALLENGE_TTL_SECONDS;
}

function key(challenge) {
    return `${CHALLENGE_PREFIX}${challenge}`;
}

function oneTag(event, name) {
    const values = event.tags.filter(tag => tag[0] === name).map(tag => tag[1]);
    if (values.length !== 1 || !values[0]) {
        throw new BlossomError(401, `Nostr login event requires one ${name} tag`);
    }
    return values[0];
}

function expectedLoginUrl(request) {
    return new URL('/api/blossom/auth/login', request.url).toString();
}

export async function createLoginChallenge(env, request, options = {}) {
    const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    const challenge = options.challenge ?? randomChallenge();
    if (!CHALLENGE_PATTERN.test(challenge)) throw new Error('Generated challenge is malformed');
    const expiresAt = now + challengeTtl(env);
    const domain = new URL(request.url).hostname.toLowerCase();
    const record = { challenge, domain, createdAt: now, expiresAt };
    await getDatabase(env).put(key(challenge), JSON.stringify(record), {
        expirationTtl: challengeTtl(env),
    });
    return { challenge, expiresAt };
}

export async function verifyAndConsumeLoginEvent(env, request, event, options = {}) {
    verifyNostrEvent(event);
    if (event.kind !== NIP98_AUTH_KIND) {
        throw new BlossomError(401, `Nostr login event kind must be ${NIP98_AUTH_KIND}`);
    }

    const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    const challenge = oneTag(event, 'challenge');
    if (!CHALLENGE_PATTERN.test(challenge)) throw new BlossomError(401, 'Malformed login challenge');

    const db = getDatabase(env);
    const stored = await db.get(key(challenge));
    if (!stored) throw new BlossomError(401, 'Login challenge is invalid or already used');

    let record;
    try {
        record = JSON.parse(stored);
    } catch {
        await db.delete(key(challenge));
        throw new BlossomError(401, 'Login challenge is malformed');
    }

    if (record.expiresAt <= now) {
        await db.delete(key(challenge));
        throw new BlossomError(401, 'Login challenge has expired');
    }
    if (event.created_at < record.createdAt || event.created_at > now + FUTURE_SKEW_SECONDS) {
        throw new BlossomError(401, 'Nostr login event timestamp is outside the challenge window');
    }

    const requestUrl = new URL(request.url);
    const domain = oneTag(event, 'domain');
    if (domain !== record.domain || domain !== requestUrl.hostname.toLowerCase()) {
        throw new BlossomError(401, 'Nostr login event has the wrong domain');
    }
    if (oneTag(event, 'u') !== expectedLoginUrl(request)) {
        throw new BlossomError(401, 'Nostr login event has the wrong audience URL');
    }
    if (oneTag(event, 'method') !== 'POST') {
        throw new BlossomError(401, 'Nostr login event has the wrong HTTP method');
    }

    const expiration = oneTag(event, 'expiration');
    if (!/^\d+$/.test(expiration)) throw new BlossomError(401, 'Malformed login expiration');
    const expirationSeconds = Number(expiration);
    if (!Number.isSafeInteger(expirationSeconds) || expirationSeconds <= now || expirationSeconds > record.expiresAt) {
        throw new BlossomError(401, 'Nostr login event has expired or exceeds the challenge lifetime');
    }

    // Consumption happens only after the signed event and every scope constraint are valid.
    // D1/KV deletion prevents all subsequent replay attempts with the same challenge.
    await db.delete(key(challenge));
    return { event, pubkey: event.pubkey };
}
