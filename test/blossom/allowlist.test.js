import assert from 'node:assert/strict';
import { nip19 } from 'nostr-tools';
import {
    addAllowedPubkey, isPubkeyAllowed, listAllowedPubkeys, normalizePubkey, removeAllowedPubkey,
} from '../../functions/blossom/allowlist.js';

const PUBKEY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

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
                async list({ prefix = '' } = {}) {
                    return {
                        keys: [...values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })),
                        list_complete: true,
                    };
                },
            },
        },
    };
}

describe('Blossom pubkey allowlist service', () => {
    it('adds, lists, and removes a valid pubkey', async () => {
        const { env } = createKvEnv();
        const added = await addAllowedPubkey(env, PUBKEY.toUpperCase(), ' HaiNei ', 123);
        assert.equal(added.created, true);
        assert.equal(added.entry.pubkey, PUBKEY);
        assert.equal(added.entry.note, 'HaiNei');
        assert.equal(await isPubkeyAllowed(env, PUBKEY), true);
        assert.deepEqual(await listAllowedPubkeys(env), [added.entry]);

        assert.deepEqual(await removeAllowedPubkey(env, PUBKEY), { removed: true, pubkey: PUBKEY });
        assert.equal(await isPubkeyAllowed(env, PUBKEY), false);
    });

    it('does not create duplicate records', async () => {
        const { env } = createKvEnv();
        const first = await addAllowedPubkey(env, PUBKEY, 'first', 123);
        const duplicate = await addAllowedPubkey(env, PUBKEY, 'replacement', 456);
        assert.equal(first.created, true);
        assert.equal(duplicate.created, false);
        assert.equal(duplicate.entry.note, 'first');
        assert.equal((await listAllowedPubkeys(env)).length, 1);
    });

    it('accepts npub and persists lowercase hex', async () => {
        const { env } = createKvEnv();
        const result = await addAllowedPubkey(env, nip19.npubEncode(PUBKEY), null, 123);
        assert.equal(result.entry.pubkey, PUBKEY);
        assert.equal(normalizePubkey(result.entry.npub), PUBKEY);
    });

    it('rejects invalid public keys and notes', async () => {
        const { env } = createKvEnv();
        await assert.rejects(addAllowedPubkey(env, 'nsec1invalid', null), /valid 64-character/);
        await assert.rejects(addAllowedPubkey(env, 'f'.repeat(63), null), /valid 64-character/);
        await assert.rejects(addAllowedPubkey(env, PUBKEY, 'x'.repeat(201)), /at most 200/);
    });
});

export { createKvEnv };
