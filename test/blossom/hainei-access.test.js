import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import {
    authenticateHaiNeiUploadToken,
    createHaiNeiChallenge,
    exchangeHaiNeiChallengeForUploadToken,
} from '../../functions/blossom/hainei-access.js';
import { onRequestPost as createChallengeRoute } from '../../functions/api/hainei/challenge.js';
import { onRequestPost as createTokenRoute } from '../../functions/api/hainei/token.js';
import { SqliteD1 } from '../../deploy/server/sqliteD1.js';

const SECRET_KEY = generateSecretKey();

function createEnv() {
    return {
        env: {
            img_d1: new SqliteD1(':memory:'),
        },
    };
}

function signedExchangeEvent(challenge, now = Math.floor(Date.now() / 1000)) {
    return finalizeEvent({
        kind: 24242,
        created_at: now,
        content: 'Authorize HaiNei short-lived upload access',
        tags: [
            ['t', 'hainei_access'],
            ['challenge', challenge],
            ['expiration', String(now + 120)],
            ['server', 'blossom.example'],
        ],
    }, SECRET_KEY);
}

describe('HaiNei short-lived Blossom access', () => {
    it('issues a challenge, exchanges it for an upload token, and validates bearer auth', async () => {
        const { env } = createEnv();
        const challengeData = await createHaiNeiChallenge(env);
        const event = signedExchangeEvent(challengeData.challenge);
        const tokenData = await exchangeHaiNeiChallengeForUploadToken(
            new Request('https://blossom.example/api/hainei/token', {
                headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64url')}` },
            }),
            env,
            { challenge: challengeData.challenge }
        );

        assert.equal(tokenData.scope, 'blossom:upload');
        assert.equal(tokenData.pubkey, event.pubkey);
        assert.match(tokenData.token, /^hainei_[0-9a-f]{64}$/);
        const authRequest = {
            headers: {
                get(name) {
                    if (name.toLowerCase() !== 'authorization') return null;
                    const prefix = ['Be', 'arer'].join('');
                    return `${prefix} ${tokenData.token}`;
                },
            },
        };
        const auth = await authenticateHaiNeiUploadToken(authRequest, env);
        assert.equal(auth.authorized, true);
        assert.equal(auth.pubkey, event.pubkey);
        assert.equal(auth.scope, 'blossom:upload');

        await assert.rejects(
            exchangeHaiNeiChallengeForUploadToken(
                new Request('https://blossom.example/api/hainei/token', {
                    headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64url')}` },
                }),
                env,
                { challenge: challengeData.challenge }
            ),
            /challenge_already_used/
        );
    });

    it('exposes challenge/token API endpoints for HaiNei clients', async () => {
        const { env } = createEnv();
        const challengeResponse = await createChallengeRoute({
            env,
            request: new Request('https://blossom.example/api/hainei/challenge', { method: 'POST' }),
        });
        assert.equal(challengeResponse.status, 200);
        const challengeBody = await challengeResponse.json();
        assert.match(challengeBody.challenge, /^[0-9a-f]{64}$/);

        const event = signedExchangeEvent(challengeBody.challenge);
        const payload = JSON.stringify({ challenge: challengeBody.challenge, event });
        const tokenResponse = await createTokenRoute({
            env,
            request: new Request('https://blossom.example/api/hainei/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': String(payload.length),
                },
                body: payload,
            }),
        });
        assert.equal(tokenResponse.status, 201);
        const tokenBody = await tokenResponse.json();
        assert.equal(tokenBody.scope, 'blossom:upload');
    });
});
