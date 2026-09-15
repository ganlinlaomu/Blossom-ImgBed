import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { addAllowedPubkey, removeAllowedPubkey } from '../../functions/blossom/allowlist.js';
import { BlossomError } from '../../functions/blossom/errors.js';
import {
    createLoginChallenge, NIP98_AUTH_KIND, verifyAndConsumeLoginEvent,
} from '../../functions/blossom/webAuth.js';
import { createLoginHandler } from '../../functions/api/blossom/auth/login.js';
import { createMeHandler } from '../../functions/api/blossom/auth/me.js';
import { createLogoutHandler } from '../../functions/api/blossom/auth/logout.js';
import { createSession, validateSession } from '../../functions/utils/auth/sessionManager.js';
import { createKvEnv } from './allowlist.test.js';

const SECRET = generateSecretKey();
const PUBKEY = getPublicKey(SECRET);
const DOMAIN = 'blossom.example';
const LOGIN_URL = `https://${DOMAIN}/api/blossom/auth/login`;

function signedLogin({ challenge, expiresAt, domain = DOMAIN, url = LOGIN_URL, createdAt, secret = SECRET } = {}) {
    return finalizeEvent({
        kind: NIP98_AUTH_KIND,
        created_at: createdAt ?? Math.floor(Date.now() / 1000),
        content: 'Authenticate with Blossom ImgBed',
        tags: [
            ['challenge', challenge], ['domain', domain], ['expiration', String(expiresAt)],
            ['u', url], ['method', 'POST'],
        ],
    }, secret);
}

function loginRequest(event) {
    return new Request(LOGIN_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event }),
    });
}

function cookiePair(setCookie) {
    return setCookie.split(';', 1)[0];
}

describe('NIP-07 Blossom login challenges', () => {
    it('verifies a signed login and prevents challenge replay', async () => {
        const { env } = createKvEnv();
        const now = Math.floor(Date.now() / 1000);
        const challenge = 'a'.repeat(64);
        const issued = await createLoginChallenge(env, new Request(`https://${DOMAIN}/api/blossom/auth/challenge`), {
            challenge, nowSeconds: now,
        });
        const event = signedLogin({ challenge, expiresAt: issued.expiresAt, createdAt: now });
        const verified = await verifyAndConsumeLoginEvent(env, loginRequest(event), event, { nowSeconds: now });
        assert.equal(verified.pubkey, PUBKEY);
        await assert.rejects(
            verifyAndConsumeLoginEvent(env, loginRequest(event), event, { nowSeconds: now }),
            /already used/
        );
    });

    it('rejects invalid signatures before consuming the challenge', async () => {
        const { env } = createKvEnv();
        const now = Math.floor(Date.now() / 1000);
        const challenge = 'b'.repeat(64);
        const issued = await createLoginChallenge(env, new Request(`https://${DOMAIN}/api/blossom/auth/challenge`), {
            challenge, nowSeconds: now,
        });
        const valid = signedLogin({ challenge, expiresAt: issued.expiresAt, createdAt: now });
        const invalid = JSON.parse(JSON.stringify(valid));
        invalid.sig = `${valid.sig.slice(0, -1)}${valid.sig.endsWith('0') ? '1' : '0'}`;
        await assert.rejects(verifyAndConsumeLoginEvent(env, loginRequest(invalid), invalid), /signature/);
        assert.equal((await verifyAndConsumeLoginEvent(env, loginRequest(valid), valid)).pubkey, PUBKEY);
    });

    it('rejects expired, unknown, and incorrectly scoped challenges', async () => {
        const now = Math.floor(Date.now() / 1000);
        const { env } = createKvEnv();
        const expiredChallenge = 'c'.repeat(64);
        const issued = await createLoginChallenge(env, new Request(`https://${DOMAIN}/api/blossom/auth/challenge`), {
            challenge: expiredChallenge, nowSeconds: now - 301,
        });
        const expired = signedLogin({ challenge: expiredChallenge, expiresAt: issued.expiresAt, createdAt: now - 301 });
        await assert.rejects(verifyAndConsumeLoginEvent(env, loginRequest(expired), expired, { nowSeconds: now }), /expired/);

        const unknown = signedLogin({ challenge: 'd'.repeat(64), expiresAt: now + 60 });
        await assert.rejects(verifyAndConsumeLoginEvent(env, loginRequest(unknown), unknown), /invalid or already used/);

        const domainChallenge = 'e'.repeat(64);
        const domainIssued = await createLoginChallenge(env, new Request(`https://${DOMAIN}/api/blossom/auth/challenge`), {
            challenge: domainChallenge, nowSeconds: now,
        });
        const wrongDomain = signedLogin({ challenge: domainChallenge, expiresAt: domainIssued.expiresAt, domain: 'evil.example' });
        await assert.rejects(verifyAndConsumeLoginEvent(env, loginRequest(wrongDomain), wrongDomain), /wrong domain/);

        const wrongUrl = signedLogin({ challenge: domainChallenge, expiresAt: domainIssued.expiresAt, url: 'https://blossom.example/not-login' });
        await assert.rejects(verifyAndConsumeLoginEvent(env, loginRequest(wrongUrl), wrongUrl), /audience URL/);
    });
});

describe('Blossom web login and session', () => {
    async function issueLogin(env, challengeCharacter = 'f') {
        const challenge = challengeCharacter.repeat(64);
        const issued = await createLoginChallenge(env, new Request(`https://${DOMAIN}/api/blossom/auth/challenge`), { challenge });
        return signedLogin({ challenge, expiresAt: issued.expiresAt });
    }

    it('creates a Secure, HttpOnly 24-hour session for an allowed pubkey', async () => {
        const { env } = createKvEnv();
        env.BLOSSOM_ENABLED = 'true';
        await addAllowedPubkey(env, PUBKEY, null);
        const response = await createLoginHandler()({ env, request: loginRequest(await issueLogin(env)) });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).pubkey, PUBKEY);
        const cookie = response.headers.get('Set-Cookie');
        assert.match(cookie, /^blossom_session=/);
        assert.match(cookie, /HttpOnly/);
        assert.match(cookie, /Secure/);
        assert.match(cookie, /SameSite=Strict/);
        assert.match(cookie, /Max-Age=86400/);

        const request = new Request(`https://${DOMAIN}/api/blossom/auth/me`, { headers: { Cookie: cookiePair(cookie) } });
        assert.equal((await validateSession(env, request, 'blossom')).valid, true);
        assert.equal((await createMeHandler()({ env, request })).status, 200);
    });

    it('denies a valid signature from a non-allowlisted pubkey', async () => {
        const { env } = createKvEnv();
        env.BLOSSOM_ENABLED = 'true';
        const response = await createLoginHandler()({ env, request: loginRequest(await issueLogin(env, '1')) });
        assert.equal(response.status, 403);
        assert.deepEqual(await response.json(), { error: 'pubkey_not_allowed' });
    });

    it('invalidates expired sessions and sessions removed from the allowlist', async () => {
        const { env, values } = createKvEnv();
        env.BLOSSOM_ENABLED = 'true';
        await addAllowedPubkey(env, PUBKEY, null);
        const session = await createSession(env, 'blossom', PUBKEY);
        const pair = cookiePair(session.cookie);
        const token = pair.split('=')[1];
        const sessionKey = `manage@session@${token}`;
        const expired = JSON.parse(values.get(sessionKey));
        expired.expiresAt = Date.now() - 1;
        values.set(sessionKey, JSON.stringify(expired));
        const expiredRequest = new Request(`https://${DOMAIN}/api/blossom/auth/me`, { headers: { Cookie: pair } });
        assert.equal((await validateSession(env, expiredRequest, 'blossom')).valid, false);

        const active = await createSession(env, 'blossom', PUBKEY);
        const activeRequest = new Request(`https://${DOMAIN}/api/blossom/auth/me`, {
            headers: { Cookie: cookiePair(active.cookie) },
        });
        await removeAllowedPubkey(env, PUBKEY);
        const me = await createMeHandler()({ env, request: activeRequest });
        assert.deepEqual(await me.json(), { authenticated: false });
        assert.match(me.headers.get('Set-Cookie'), /Max-Age=0/);
        assert.equal((await validateSession(env, activeRequest, 'blossom')).valid, false);
    });

    it('logs out and destroys the Blossom session', async () => {
        const { env } = createKvEnv();
        const session = await createSession(env, 'blossom', PUBKEY);
        const request = new Request(`https://${DOMAIN}/api/blossom/auth/logout`, {
            method: 'POST', headers: { Cookie: cookiePair(session.cookie) },
        });
        const response = await createLogoutHandler()({ env, request });
        assert.match(response.headers.get('Set-Cookie'), /Max-Age=0/);
        assert.equal((await validateSession(env, request, 'blossom')).valid, false);
    });
});
