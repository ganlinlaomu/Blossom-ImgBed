import assert from 'node:assert/strict';
import {
    buildAuthorizationHeader, createUploadAuthorization, signUploadAuthorization, uploadBlossomBlob,
} from '../../frontend-dist/js/nostr/blossom-auth.js';
import { createLoginEvent } from '../../frontend-dist/js/nostr/web-login.js';

const HASH = 'a'.repeat(64);

describe('NIP-07 browser helpers', () => {
    it('constructs a PR1-compatible BUD-11 event and authorization header', async () => {
        const unsigned = createUploadAuthorization({ sha256: HASH, hostname: 'blossom.example', nowSeconds: 100 });
        assert.equal(unsigned.kind, 24242);
        assert.deepEqual(unsigned.tags, [
            ['t', 'upload'], ['expiration', '400'], ['x', HASH], ['server', 'blossom.example'],
        ]);
        const signed = { ...unsigned, pubkey: '1'.repeat(64), id: '2'.repeat(64), sig: '3'.repeat(128) };
        const signer = { signEvent: async event => ({ ...event, ...signed }) };
        assert.equal((await signUploadAuthorization(signer, {
            sha256: HASH, hostname: 'blossom.example', nowSeconds: 100,
        })).kind, 24242);
        const header = buildAuthorizationHeader(signed);
        assert.match(header, /^Nostr [A-Za-z0-9_-]+$/);
        assert.deepEqual(JSON.parse(Buffer.from(header.slice(6), 'base64url').toString()), signed);
    });

    it('uses PUT /upload with the BUD-11 header and blob body', async () => {
        const file = new File(['blob'], 'blob.txt', { type: 'text/plain' });
        const event = { kind: 24242, tags: [], content: 'upload' };
        let captured;
        const response = await uploadBlossomBlob({
            file, event, sha256: HASH,
            fetchImpl: async (url, options) => { captured = { url, options }; return new Response('{}'); },
        });
        assert.equal(response.status, 200);
        assert.equal(captured.url, '/upload');
        assert.equal(captured.options.method, 'PUT');
        assert.equal(captured.options.body, file);
        assert.equal(captured.options.headers['X-SHA-256'], HASH);
        assert.match(captured.options.headers.Authorization, /^Nostr /);
    });

    it('constructs a domain- and audience-bound login event', () => {
        const event = createLoginEvent({
            challenge: 'b'.repeat(64), expiresAt: 400, nowSeconds: 100,
            location: { hostname: 'blossom.example', origin: 'https://blossom.example' },
        });
        assert.equal(event.kind, 27235);
        assert.ok(event.tags.some(tag => tag[0] === 'domain' && tag[1] === 'blossom.example'));
        assert.ok(event.tags.some(tag => tag[0] === 'u' && tag[1].endsWith('/api/blossom/auth/login')));
    });
});
