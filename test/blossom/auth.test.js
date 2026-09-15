import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { authenticateBud11, parseAuthorizationHeader } from '../../functions/blossom/auth.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const SECRET_KEY = generateSecretKey();

function signedEvent({ action = 'upload', hash = HASH_A, kind = 24242, createdAt, expiration, content = 'Authorize Blossom operation' } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return finalizeEvent({
        kind,
        created_at: createdAt ?? now,
        content,
        tags: [['t', action], ['expiration', String(expiration ?? now + 60)], ['x', hash]],
    }, SECRET_KEY);
}

function authorization(event) {
    return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64url')}`;
}

function requestFor(event) {
    return new Request('https://blossom.example/upload', { headers: { Authorization: authorization(event) } });
}

describe('BUD-11 authentication', () => {
    it('accepts a valid signed authorization event', () => {
        const event = signedEvent();
        const result = authenticateBud11(requestFor(event), {}, {
            action: 'upload', sha256: HASH_A, requireHash: true,
        });
        assert.equal(result.pubkey, event.pubkey);
    });

    it('rejects an invalid Schnorr signature', () => {
        const event = signedEvent();
        event.sig = `${event.sig.slice(0, -1)}${event.sig.endsWith('0') ? '1' : '0'}`;
        assert.throws(() => authenticateBud11(requestFor(event), {}, {
            action: 'upload', sha256: HASH_A, requireHash: true,
        }), /signature/);
    });

    it('rejects the wrong event kind', () => {
        assert.throws(() => authenticateBud11(requestFor(signedEvent({ kind: 1 })), {}, {
            action: 'upload', sha256: HASH_A, requireHash: true,
        }), /kind/);
    });

    it('rejects expired and stale events', () => {
        const now = Math.floor(Date.now() / 1000);
        assert.throws(() => authenticateBud11(requestFor(signedEvent({ expiration: now - 1 })), {}, {
            action: 'upload', sha256: HASH_A, requireHash: true,
        }), /expired/);
        assert.throws(() => authenticateBud11(requestFor(signedEvent({ createdAt: now - 301 })), {}, {
            action: 'upload', sha256: HASH_A, requireHash: true,
        }), /too old/);
    });

    it('rejects future events, missing expiration, and the wrong server scope', () => {
        const now = Math.floor(Date.now() / 1000);
        assert.throws(() => authenticateBud11(requestFor(signedEvent({ createdAt: now + 1 })), {}, {
            action: 'upload', sha256: HASH_A, requireHash: true,
        }), /future/);

        const withoutExpiration = signedEvent();
        withoutExpiration.tags = withoutExpiration.tags.filter(tag => tag[0] !== 'expiration');
        const resigned = finalizeEvent({
            kind: withoutExpiration.kind,
            created_at: withoutExpiration.created_at,
            content: withoutExpiration.content,
            tags: withoutExpiration.tags,
        }, SECRET_KEY);
        assert.throws(() => authenticateBud11(requestFor(resigned), {}, {
            action: 'upload', sha256: HASH_A, requireHash: true,
        }), /expiration/);

        const scoped = signedEvent();
        const scopedEvent = finalizeEvent({
            kind: scoped.kind,
            created_at: scoped.created_at,
            content: scoped.content,
            tags: [...scoped.tags, ['server', 'other.example']],
        }, SECRET_KEY);
        assert.throws(() => authenticateBud11(requestFor(scopedEvent), {}, {
            action: 'upload', sha256: HASH_A, requireHash: true,
        }), /server/);
    });

    it('rejects wrong actions and hash scopes', () => {
        assert.throws(() => authenticateBud11(requestFor(signedEvent({ action: 'delete' })), {}, {
            action: 'upload', sha256: HASH_A, requireHash: true,
        }), /action/);
        assert.throws(() => authenticateBud11(requestFor(signedEvent({ hash: HASH_B })), {}, {
            action: 'upload', sha256: HASH_A, requireHash: true,
        }), /does not cover/);
    });

    it('rejects malformed authorization headers', () => {
        assert.throws(() => parseAuthorizationHeader('Bearer token'), /Malformed/);
        assert.throws(() => parseAuthorizationHeader('Nostr !!!'), /Malformed/);
        assert.throws(() => parseAuthorizationHeader(`Nostr ${Buffer.from('{').toString('base64url')}`), /JSON/);
    });

    it('rejects event id tampering even with a well-shaped signature', () => {
        const event = signedEvent();
        event.id = HASH_B;
        assert.throws(() => authenticateBud11(requestFor(event), {}, {
            action: 'upload', sha256: HASH_A, requireHash: true,
        }), /event id/);
    });
});
