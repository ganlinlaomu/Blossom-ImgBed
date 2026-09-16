import { BlossomError } from './errors.js';
import { verifyAuthorizationEvent } from './event.js';
import { SHA256_PATTERN } from './types.js';

// BUD-11 already bounds a token's lifetime with its required expiration tag.
// A separate age limit is opt-in because clients may legitimately cache and
// reuse an authorization event until that expiration time.
const DEFAULT_MAX_AGE_SECONDS = 0;
const DEFAULT_FUTURE_SKEW_SECONDS = 0;

export function isBlossomEnabled(env) {
    const value = env?.BLOSSOM_ENABLED;
    return value === true || value === 1 || ['true', '1', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function readBoundedSeconds(value, fallback, maximum) {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) return fallback;
    return parsed;
}

export function getAuthorizationClockPolicy(env) {
    return {
        maxAgeSeconds: readBoundedSeconds(env?.BLOSSOM_AUTH_MAX_AGE_SECONDS, DEFAULT_MAX_AGE_SECONDS, 86400),
        futureSkewSeconds: readBoundedSeconds(env?.BLOSSOM_AUTH_FUTURE_SKEW_SECONDS, DEFAULT_FUTURE_SKEW_SECONDS, 300),
    };
}

function decodeBase64Url(value) {
    if (!value) {
        throw new BlossomError(401, 'Malformed BUD-11 authorization encoding');
    }

    // Current BUD-11 uses unpadded Base64URL. Older Blossom clients and
    // servers shipped standard Base64 before that requirement was clarified,
    // so accept either alphabet while rejecting mixed or malformed encodings.
    const isBase64Url = /^[A-Za-z0-9_-]+$/.test(value);
    const isLegacyBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(value)
        && !value.slice(0, -2).includes('=')
        && value.length % 4 !== 1;
    if (!isBase64Url && !isLegacyBase64) {
        throw new BlossomError(401, 'Malformed BUD-11 authorization encoding');
    }

    const unpadded = value.replace(/=+$/, '');
    if (unpadded.length % 4 === 1) {
        throw new BlossomError(401, 'Malformed BUD-11 authorization encoding');
    }
    const base64 = unpadded.replace(/-/g, '+').replace(/_/g, '/')
        .padEnd(Math.ceil(unpadded.length / 4) * 4, '=');
    try {
        const binary = atob(base64);
        const canonical = btoa(binary).replace(/=+$/, '');
        if (canonical !== base64.replace(/=+$/, '')) {
            throw new Error('Non-canonical Base64');
        }
        const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        throw new BlossomError(401, 'Malformed BUD-11 authorization encoding');
    }
}

export function parseAuthorizationHeader(header) {
    if (!header) throw new BlossomError(401, 'Missing Nostr Authorization header');
    const match = /^Nostr (\S+)$/i.exec(header.trim());
    if (!match) throw new BlossomError(401, 'Malformed Nostr Authorization header');

    try {
        return JSON.parse(decodeBase64Url(match[1]));
    } catch (error) {
        if (error instanceof BlossomError) throw error;
        throw new BlossomError(401, 'Malformed Nostr authorization event JSON');
    }
}

function getTagValues(event, name) {
    return event.tags.filter(tag => tag[0] === name).map(tag => tag[1]);
}

function validateClock(event, env, nowSeconds) {
    const { maxAgeSeconds, futureSkewSeconds } = getAuthorizationClockPolicy(env);
    if (event.created_at > nowSeconds + futureSkewSeconds) {
        throw new BlossomError(401, 'Nostr authorization was created in the future');
    }
    if (maxAgeSeconds > 0 && event.created_at < nowSeconds - maxAgeSeconds) {
        throw new BlossomError(401, 'Nostr authorization is too old');
    }

    const expirations = getTagValues(event, 'expiration');
    if (expirations.length !== 1 || !/^\d+$/.test(expirations[0])) {
        throw new BlossomError(401, 'Nostr authorization requires one valid expiration tag');
    }
    const expiration = Number(expirations[0]);
    if (!Number.isSafeInteger(expiration) || expiration <= nowSeconds) {
        throw new BlossomError(401, 'Nostr authorization has expired');
    }
}

function validateAction(event, action) {
    const actions = getTagValues(event, 't');
    if (actions.length !== 1 || actions[0] !== action) {
        throw new BlossomError(401, `Nostr authorization action must be ${action}`);
    }
}

function validateServerScope(event, request) {
    const servers = getTagValues(event, 'server');
    if (servers.length === 0) return;
    const hostname = new URL(request.url).hostname.toLowerCase();
    if (!servers.every(server => server === server.toLowerCase() && /^[a-z0-9.-]+$/.test(server))) {
        throw new BlossomError(401, 'Nostr authorization has a malformed server tag');
    }
    if (!servers.includes(hostname)) {
        throw new BlossomError(401, 'Nostr authorization is not valid for this server');
    }
}

function validateHashScope(event, expectedHash, required) {
    const hashes = getTagValues(event, 'x');
    if (hashes.some(hash => !SHA256_PATTERN.test(hash))) {
        throw new BlossomError(401, 'Nostr authorization has a malformed x tag');
    }
    if (required && (!expectedHash || !hashes.includes(expectedHash))) {
        throw new BlossomError(401, 'Nostr authorization does not cover this blob hash');
    }
    if (!required && expectedHash && hashes.length > 0 && !hashes.includes(expectedHash)) {
        throw new BlossomError(401, 'Nostr authorization does not cover this blob hash');
    }
}

export function authenticateBud11(request, env, { action, sha256, requireHash = false, nowSeconds } = {}) {
    const event = verifyAuthorizationEvent(parseAuthorizationHeader(request.headers.get('Authorization')));
    const now = nowSeconds ?? Math.floor(Date.now() / 1000);
    validateClock(event, env, now);
    validateAction(event, action);
    validateServerScope(event, request);
    validateHashScope(event, sha256, requireHash);
    return { event, pubkey: event.pubkey };
}
