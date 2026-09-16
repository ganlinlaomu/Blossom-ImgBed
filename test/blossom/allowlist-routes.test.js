import assert from 'node:assert/strict';
import { BlossomError } from '../../functions/blossom/errors.js';
import { createUploadHandler } from '../../functions/blossom/upload.js';
import { createDeleteHandler } from '../../functions/blossom/delete.js';
import { sha256Hex } from '../../functions/blossom/hash.js';
import { addAllowedPubkey, removeAllowedPubkey } from '../../functions/blossom/allowlist.js';
import { onRequestGet, onRequestPost } from '../../functions/api/manage/blossom/pubkeys.js';
import { onRequestDelete } from '../../functions/api/manage/blossom/pubkeys/[pubkey].js';
import { onRequest as manageMiddleware } from '../../functions/api/manage/_middleware.js';
import { createKvEnv } from './allowlist.test.js';

const ALLOWED = '1'.repeat(64);
const UNKNOWN = '2'.repeat(64);

function context(env, request) {
    return { env: { ...env, BLOSSOM_ENABLED: 'true' }, request, data: {}, waitUntil() {} };
}

async function uploadRequest(bytes, hash) {
    return new Request('https://blossom.example/upload', {
        method: 'PUT', headers: { 'X-SHA-256': hash, 'Content-Type': 'text/plain' }, body: bytes,
    });
}

describe('Blossom write allowlist enforcement', () => {
    it('allows an authenticated allowed pubkey to reach ImgBed upload', async () => {
        const { env } = createKvEnv();
        await addAllowedPubkey(env, ALLOWED, null);
        const bytes = new TextEncoder().encode('allowed');
        const hash = await sha256Hex(bytes);
        let uploads = 0;
        const handler = createUploadHandler({
            authenticate: () => ({ pubkey: ALLOWED }),
            getBlob: async () => null,
            uploadViaImgBed: async () => { uploads++; return 'stored.txt'; },
        });
        const response = await handler(context(env, await uploadRequest(bytes, hash)), () => {});
        assert.equal(response.status, 201);
        assert.equal(uploads, 1);
    });

    it('rejects an unknown or removed pubkey before reading or uploading', async () => {
        const { env } = createKvEnv();
        await addAllowedPubkey(env, ALLOWED, null);
        await removeAllowedPubkey(env, ALLOWED);
        const bytes = new TextEncoder().encode('denied');
        const hash = await sha256Hex(bytes);
        let bodyReads = 0;
        let uploads = 0;
        const handler = createUploadHandler({
            authenticate: () => ({ pubkey: ALLOWED }),
            readAndHash: async () => { bodyReads++; },
            uploadViaImgBed: async () => { uploads++; },
        });
        const response = await handler(context(env, await uploadRequest(bytes, hash)), () => {});
        assert.equal(response.status, 403);
        assert.deepEqual(await response.json(), { error: 'pubkey_not_allowed' });
        assert.equal(bodyReads, 0);
        assert.equal(uploads, 0);
    });

    it('rejects bad BUD-11 authentication before querying the allowlist', async () => {
        const { env } = createKvEnv();
        const bytes = new TextEncoder().encode('invalid signature');
        const hash = await sha256Hex(bytes);
        let allowlistChecks = 0;
        const handler = createUploadHandler({
            authenticate: () => { throw new BlossomError(401, 'Invalid Nostr event signature'); },
            isPubkeyAllowed: async () => { allowlistChecks++; return true; },
        });
        const response = await handler(context(env, await uploadRequest(bytes, hash)), () => {});
        assert.equal(response.status, 401);
        assert.equal(allowlistChecks, 0);
    });

    it('allows an allowed owner to delete and blocks unknown or removed pubkeys', async () => {
        const { env } = createKvEnv();
        await addAllowedPubkey(env, ALLOWED, null);
        const hash = 'a'.repeat(64);
        const blob = { sha256: hash, imgbedId: 'stored.bin', size: 1, type: 'application/octet-stream', uploaded: 1 };
        let physicalDeletes = 0;
        const dependencies = {
            authenticate: () => ({ pubkey: ALLOWED }), getBlob: async () => blob,
            hasOwnership: async () => true, removeOwnership: async () => {}, countOwnerships: async () => 0,
            deleteViaImgBed: async () => { physicalDeletes++; return true; }, deleteBlob: async () => {},
        };
        const request = new Request(`https://blossom.example/${hash}`, { method: 'DELETE' });
        assert.equal((await createDeleteHandler(dependencies)(context(env, request), hash)).status, 204);

        await removeAllowedPubkey(env, ALLOWED);
        const denied = await createDeleteHandler(dependencies)(context(env, request), hash);
        assert.equal(denied.status, 403);
        assert.deepEqual(await denied.json(), { error: 'pubkey_not_allowed' });
        assert.equal(physicalDeletes, 1);

        const unknown = createDeleteHandler({ ...dependencies, authenticate: () => ({ pubkey: UNKNOWN }) });
        assert.equal((await unknown(context(env, request), hash)).status, 403);
    });
});

describe('Blossom allowlist admin API', () => {
    it('lets the protected admin API add, list, and remove entries', async () => {
        const { env, values } = createKvEnv();
        env.BASIC_USER = 'admin';
        env.BASIC_PASS = 'configured';
        values.set('manage@session@test-admin', JSON.stringify({
            authType: 'admin', expiresAt: Date.now() + 60_000,
        }));
        const adminHeaders = { 'Content-Type': 'application/json', Cookie: 'admin_session=test-admin' };
        const post = await onRequestPost({ env, request: new Request('https://img.example/api/manage/blossom/pubkeys', {
            method: 'POST', headers: adminHeaders,
            body: JSON.stringify({ pubkey: ALLOWED, note: 'HaiNei' }),
        }) });
        assert.equal(post.status, 201);
        assert.equal((await post.json()).created, true);

        const list = await onRequestGet({ env, request: new Request(
            'https://img.example/api/manage/blossom/pubkeys', { headers: adminHeaders },
        ) });
        assert.equal((await list.json())[0].note, 'HaiNei');

        const removed = await onRequestDelete({
            env,
            request: new Request(`https://img.example/api/manage/blossom/pubkeys/${ALLOWED}`, {
                method: 'DELETE', headers: adminHeaders,
            }),
            params: { pubkey: ALLOWED },
        });
        assert.equal(removed.status, 200);
        assert.equal((await removed.json()).removed, true);
    });

    it('rejects invalid admin input and denies an unauthenticated configured admin', async () => {
        const { env, values } = createKvEnv();
        env.BASIC_USER = 'admin';
        env.BASIC_PASS = 'configured';
        values.set('manage@session@test-admin', JSON.stringify({
            authType: 'admin', expiresAt: Date.now() + 60_000,
        }));
        const invalid = await onRequestPost({ env, request: new Request('https://img.example/api/manage/blossom/pubkeys', {
            method: 'POST', headers: {
                'Content-Type': 'application/json', Cookie: 'admin_session=test-admin',
            }, body: JSON.stringify({ pubkey: 'bad' }),
        }) });
        assert.equal(invalid.status, 400);

        let reachedApi = false;
        const authentication = manageMiddleware[1];
        const denied = await authentication({
            env: { ...env, BASIC_USER: 'admin', BASIC_PASS: 'configured' },
            request: new Request('https://img.example/api/manage/blossom/pubkeys'),
            next: async () => { reachedApi = true; return new Response('ok'); },
        });
        assert.equal(denied.status, 401);
        assert.equal(reachedApi, false);
    });

    it('rejects direct API access without a configured, logged-in administrator', async () => {
        const { env } = createKvEnv();
        const request = new Request('https://img.example/api/manage/blossom/pubkeys');

        const unconfigured = await onRequestGet({ env, request });
        assert.equal(unconfigured.status, 401);
        assert.deepEqual(await unconfigured.json(), { error: 'admin_not_configured' });

        env.BASIC_USER = 'admin';
        env.BASIC_PASS = 'configured';
        const loggedOut = await onRequestGet({ env, request });
        assert.equal(loggedOut.status, 401);
        assert.deepEqual(await loggedOut.json(), { error: 'admin_login_required' });
    });
});
