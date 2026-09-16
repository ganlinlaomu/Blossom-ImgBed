import assert from 'node:assert/strict';
import { createUploadHandler, createUploadPreflightHandler } from '../../functions/blossom/upload.js';
import { createBlobHandler } from '../../functions/blossom/blob.js';
import { createDeleteHandler } from '../../functions/blossom/delete.js';
import { sha256Hex } from '../../functions/blossom/hash.js';
import { selectConsistentChannel } from '../../functions/upload/uploadTools.js';
import { onRequest as blossomRootRoute } from '../../functions/[sha256].js';

const PUBKEY_A = '1'.repeat(64);
const PUBKEY_B = '2'.repeat(64);

function context(request) {
    return {
        request,
        env: { img_url: {
            async get(key) { return key === 'blossom_enabled' ? 'true' : null; },
            async put() {}, async delete() {}, async list() { return { keys: [], list_complete: true }; },
        } },
        data: {}, waitUntil() {},
    };
}

async function uploadRequest(bytes, hash, { includeHashHeader = true } = {}) {
    return new Request('https://blossom.example/upload', {
        method: 'PUT',
        headers: {
            ...(includeHashHeader ? { 'X-SHA-256': hash } : {}),
            'Content-Type': 'text/plain',
        },
        body: bytes,
    });
}

describe('Blossom upload', () => {
    it('accepts an authorized BUD-06 HEAD /upload preflight', async () => {
        const hash = 'a'.repeat(64);
        let authOptions;
        const handler = createUploadPreflightHandler({
            authenticate: (_request, _env, options) => {
                authOptions = options;
                return { pubkey: PUBKEY_A };
            },
            isPubkeyAllowed: async () => true,
        });
        const response = await handler(context(new Request('https://blossom.example/upload', {
            method: 'HEAD',
            headers: {
                'X-SHA-256': hash,
                'X-Content-Type': 'image/png',
                'X-Content-Length': '1234',
            },
        })));

        assert.equal(response.status, 200);
        assert.deepEqual(authOptions, { action: 'upload', sha256: hash, requireHash: true });
        assert.equal(response.headers.get('Access-Control-Expose-Headers'), 'X-Reason');
    });

    it('rejects malformed BUD-06 preflight metadata and non-allowlisted pubkeys', async () => {
        const hash = 'b'.repeat(64);
        const allowed = createUploadPreflightHandler({
            authenticate: () => ({ pubkey: PUBKEY_A }),
            isPubkeyAllowed: async () => true,
        });
        const missingLength = await allowed(context(new Request('https://blossom.example/upload', {
            method: 'HEAD',
            headers: { 'X-SHA-256': hash, 'X-Content-Type': 'image/png' },
        })));
        assert.equal(missingLength.status, 411);

        const denied = createUploadPreflightHandler({
            authenticate: () => ({ pubkey: PUBKEY_B }),
            isPubkeyAllowed: async () => false,
        });
        const deniedResponse = await denied(context(new Request('https://blossom.example/upload', {
            method: 'HEAD',
            headers: {
                'X-SHA-256': hash,
                'X-Content-Type': 'image/png',
                'X-Content-Length': '1234',
            },
        })));
        assert.equal(deniedResponse.status, 403);
        assert.deepEqual(await deniedResponse.json(), { error: 'pubkey_not_allowed' });
    });

    it('uploads an authorized blob through the existing ImgBed pipeline', async () => {
        const bytes = new TextEncoder().encode('hello blossom');
        const hash = await sha256Hex(bytes);
        let pipelineCalls = 0;
        let storedBlob;
        let ownership;
        const handler = createUploadHandler({
            authenticate: () => ({ pubkey: PUBKEY_A }),
            isPubkeyAllowed: async () => true,
            getBlob: async () => null,
            putBlob: async (_env, blob) => { storedBlob = blob; },
            addOwnership: async (_env, sha256, pubkey) => { ownership = [sha256, pubkey]; },
            uploadViaImgBed: async (_context, file, sha256, processFileUpload) => {
                pipelineCalls++;
                assert.equal(file.size, bytes.length);
                assert.equal(sha256, hash);
                assert.equal(typeof processFileUpload, 'function');
                return `blossom/${hash}.txt`;
            },
        });
        const response = await handler(context(await uploadRequest(bytes, hash)), () => {});
        const descriptor = await response.json();
        assert.equal(response.status, 201);
        assert.equal(pipelineCalls, 1);
        assert.equal(storedBlob.sha256, hash);
        assert.deepEqual(ownership, [hash, PUBKEY_A]);
        assert.deepEqual(Object.keys(descriptor), ['url', 'sha256', 'size', 'type', 'uploaded']);
    });

    it('accepts PUT without X-SHA-256 when the signed x tag covers the body hash', async () => {
        const bytes = new TextEncoder().encode('client omits the redundant hash header');
        const hash = await sha256Hex(bytes);
        let authOptions;
        let pipelineCalls = 0;
        const handler = createUploadHandler({
            authenticate: (_request, _env, options) => {
                authOptions = options;
                return { pubkey: PUBKEY_A, event: { tags: [['x', hash]] } };
            },
            isPubkeyAllowed: async () => true,
            getBlob: async () => null,
            putBlob: async () => {},
            addOwnership: async () => {},
            uploadViaImgBed: async () => {
                pipelineCalls++;
                return `blossom/${hash}.txt`;
            },
        });

        const response = await handler(
            context(await uploadRequest(bytes, hash, { includeHashHeader: false })),
            () => {}
        );

        assert.equal(response.status, 201);
        assert.deepEqual(authOptions, { action: 'upload', requireHash: false });
        assert.equal(pipelineCalls, 1);
    });

    it('rejects PUT without X-SHA-256 when the signed x tag does not cover the body', async () => {
        const bytes = new TextEncoder().encode('body hash is not authorized');
        let pipelineCalls = 0;
        const handler = createUploadHandler({
            authenticate: () => ({ pubkey: PUBKEY_A, event: { tags: [['x', 'c'.repeat(64)]] } }),
            isPubkeyAllowed: async () => true,
            uploadViaImgBed: async () => { pipelineCalls++; },
        });

        const response = await handler(
            context(await uploadRequest(bytes, 'c'.repeat(64), { includeHashHeader: false })),
            () => {}
        );

        assert.equal(response.status, 401);
        assert.equal(response.headers.get('X-Reason'), 'Nostr authorization does not cover the uploaded blob hash');
        assert.equal(pipelineCalls, 0);
    });

    it('rejects a body hash mismatch before the ImgBed pipeline is called', async () => {
        const bytes = new TextEncoder().encode('wrong body');
        let pipelineCalls = 0;
        const handler = createUploadHandler({
            authenticate: () => ({ pubkey: PUBKEY_A }),
            isPubkeyAllowed: async () => true,
            uploadViaImgBed: async () => { pipelineCalls++; },
        });
        const response = await handler(context(await uploadRequest(bytes, 'a'.repeat(64))), () => {});
        assert.equal(response.status, 409);
        assert.equal(pipelineCalls, 0);
    });

    it('deduplicates an existing blob only after authorization and records another owner', async () => {
        const bytes = new TextEncoder().encode('duplicate');
        const hash = await sha256Hex(bytes);
        const blob = { sha256: hash, imgbedId: 'existing.txt', size: bytes.length, type: 'text/plain', uploaded: 1 };
        let authenticated = false;
        let pipelineCalls = 0;
        let addedOwner;
        const handler = createUploadHandler({
            authenticate: () => { authenticated = true; return { pubkey: PUBKEY_B }; },
            isPubkeyAllowed: async () => true,
            getBlob: async () => blob,
            getImgBedRecord: async () => ({ metadata: {} }),
            addOwnership: async (_env, _hash, pubkey) => { addedOwner = pubkey; },
            uploadViaImgBed: async () => { pipelineCalls++; },
        });
        const response = await handler(context(await uploadRequest(bytes, hash)), () => {});
        assert.equal(response.status, 200);
        assert.equal(authenticated, true);
        assert.equal(addedOwner, PUBKEY_B);
        assert.equal(pipelineCalls, 0);
    });
});

describe('Blossom GET and HEAD', () => {
    const hash = 'a'.repeat(64);
    const blob = { sha256: hash, imgbedId: 'stored.bin', size: 4, type: 'application/octet-stream', uploaded: 1 };

    it('returns an existing blob through the ImgBed reader', async () => {
        const handler = createBlobHandler({
            getBlob: async () => blob,
            readViaImgBed: async () => new Response('data'),
        });
        const response = await handler(context(new Request(`https://blossom.example/${hash}`)), hash);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), 'data');
        assert.equal(response.headers.get('Content-Length'), '4');
        assert.equal(response.headers.get('ETag'), `"${hash}"`);
    });

    it('returns 404 for a missing blob and 400 for an invalid hash', async () => {
        const handler = createBlobHandler({ getBlob: async () => null });
        assert.equal((await handler(context(new Request(`https://blossom.example/${hash}`)), hash)).status, 404);
        assert.equal((await handler(context(new Request('https://blossom.example/bad')), 'bad')).status, 400);
    });

    it('returns HEAD metadata with no body', async () => {
        const handler = createBlobHandler({
            getBlob: async () => blob,
            readViaImgBed: async () => new Response(null, { headers: { 'Content-Length': '0' } }),
        });
        const request = new Request(`https://blossom.example/${hash}`, { method: 'HEAD' });
        const response = await handler(context(request), hash);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Content-Length'), '4');
        assert.equal(await response.text(), '');
    });
});

describe('Blossom DELETE', () => {
    const hash = 'b'.repeat(64);
    const blob = { sha256: hash, imgbedId: 'stored.bin', size: 4, type: 'application/octet-stream', uploaded: 1 };
    const deleteRequest = new Request(`https://blossom.example/${hash}`, { method: 'DELETE' });

    it('lets an owner delete the last physical blob through ImgBed', async () => {
        let physicalDeletes = 0;
        let metadataDeletes = 0;
        const handler = createDeleteHandler({
            authenticate: () => ({ pubkey: PUBKEY_A }), getBlob: async () => blob,
            isPubkeyAllowed: async () => true,
            hasOwnership: async () => true, removeOwnership: async () => {}, countOwnerships: async () => 0,
            deleteViaImgBed: async () => { physicalDeletes++; return true; },
            deleteBlob: async () => { metadataDeletes++; },
        });
        const response = await handler(context(deleteRequest), hash);
        assert.equal(response.status, 204);
        assert.equal(physicalDeletes, 1);
        assert.equal(metadataDeletes, 1);
    });

    it('denies a non-owner', async () => {
        let physicalDeletes = 0;
        const handler = createDeleteHandler({
            authenticate: () => ({ pubkey: PUBKEY_B }), getBlob: async () => blob,
            isPubkeyAllowed: async () => true,
            hasOwnership: async () => false,
            deleteViaImgBed: async () => { physicalDeletes++; return true; },
        });
        assert.equal((await handler(context(deleteRequest), hash)).status, 403);
        assert.equal(physicalDeletes, 0);
    });

    it('keeps the physical blob when another owner remains', async () => {
        let physicalDeletes = 0;
        const handler = createDeleteHandler({
            authenticate: () => ({ pubkey: PUBKEY_A }), getBlob: async () => blob,
            isPubkeyAllowed: async () => true,
            hasOwnership: async () => true, removeOwnership: async () => {}, countOwnerships: async () => 1,
            deleteViaImgBed: async () => { physicalDeletes++; return true; },
        });
        assert.equal((await handler(context(deleteRequest), hash)).status, 204);
        assert.equal(physicalDeletes, 0);
    });
});

describe('ImgBed regression guards', () => {
    it('retains the existing channel-selection behavior', () => {
        const channels = [{ name: 'first' }, { name: 'second' }];
        assert.equal(selectConsistentChannel(channels, 'upload-id', false), channels[0]);
        assert.equal(selectConsistentChannel(channels, 'upload-id', true), selectConsistentChannel(channels, 'upload-id', true));
    });

    it('keeps hash reads on the Blossom reader while passing non-hash routes through', async () => {
        let passes = 0;
        const fallback = async () => { passes++; return new Response('legacy'); };
        const disabled = await blossomRootRoute({
            request: new Request(`https://blossom.example/${'a'.repeat(64)}`),
            env: context(new Request('https://blossom.example')).env,
            params: { sha256: 'a'.repeat(64) }, next: fallback,
        });
        const nonHash = await blossomRootRoute({
            request: new Request('https://blossom.example/dashboard'),
            env: context(new Request('https://blossom.example')).env,
            params: { sha256: 'dashboard' }, next: fallback,
        });
        assert.equal(disabled.status, 404);
        assert.equal(await nonHash.text(), 'legacy');
        assert.equal(passes, 1);
    });
});
