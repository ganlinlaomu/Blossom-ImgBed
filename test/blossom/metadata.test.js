import assert from 'node:assert/strict';
import {
    addOwnership, countOwnerships, deleteBlob, getBlob, hasOwnership, putBlob, removeOwnership,
} from '../../functions/blossom/metadata.js';

function createKvEnv() {
    const values = new Map();
    return {
        values,
        env: {
            img_url: {
                async get(key) { return values.get(key) ?? null; },
                async put(key, value) { values.set(key, value); },
                async delete(key) { values.delete(key); },
                async getWithMetadata(key) { return values.get(key) ?? null; },
                async list() { return { keys: [] }; },
            },
        },
    };
}

describe('Blossom metadata and ownership', () => {
    it('keeps multiple pubkey owners separate from ImgBed storage metadata', async () => {
        const { env } = createKvEnv();
        const hash = 'c'.repeat(64);
        const blob = { sha256: hash, imgbedId: 'blossom/blob.bin', size: 3, type: 'application/octet-stream', uploaded: 1 };
        await putBlob(env, blob);
        await addOwnership(env, hash, '1'.repeat(64), 1);
        await addOwnership(env, hash, '2'.repeat(64), 1);

        assert.deepEqual(await getBlob(env, hash), blob);
        assert.equal(await countOwnerships(env, hash), 2);
        assert.equal(await hasOwnership(env, hash, '1'.repeat(64)), true);

        await removeOwnership(env, hash, '1'.repeat(64));
        assert.equal(await countOwnerships(env, hash), 1);
        assert.equal(await hasOwnership(env, hash, '2'.repeat(64)), true);

        await deleteBlob(env, hash);
        assert.equal(await getBlob(env, hash), null);
    });
});
