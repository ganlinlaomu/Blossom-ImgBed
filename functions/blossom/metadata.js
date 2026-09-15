import { getDatabase } from '../utils/databaseAdapter.js';

const BLOB_PREFIX = 'manage@blossom@blob@';

function blobKey(sha256) {
    return `${BLOB_PREFIX}${sha256}`;
}

function usesD1(env) {
    return !!(env?.img_d1 && typeof env.img_d1.prepare === 'function');
}

function rowToBlob(row) {
    return row ? {
        sha256: row.sha256,
        imgbedId: row.imgbed_id,
        size: Number(row.size),
        type: row.mime_type,
        uploaded: Number(row.created_at),
    } : null;
}

export async function getBlob(env, sha256) {
    if (usesD1(env)) {
        const row = await env.img_d1.prepare(
            'SELECT sha256, imgbed_id, size, mime_type, created_at FROM blossom_blobs WHERE sha256 = ?'
        ).bind(sha256).first();
        return rowToBlob(row);
    }

    const value = await getDatabase(env).get(blobKey(sha256));
    if (!value) return null;
    const record = JSON.parse(value);
    return {
        sha256: record.sha256,
        imgbedId: record.imgbedId,
        size: Number(record.size),
        type: record.type,
        uploaded: Number(record.uploaded),
    };
}

export async function putBlob(env, blob) {
    if (usesD1(env)) {
        await env.img_d1.prepare(
            `INSERT INTO blossom_blobs (sha256, imgbed_id, size, mime_type, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(sha256) DO UPDATE SET
               imgbed_id = excluded.imgbed_id,
               size = excluded.size,
               mime_type = excluded.mime_type`
        ).bind(blob.sha256, blob.imgbedId, blob.size, blob.type, blob.uploaded).run();
        return;
    }

    const db = getDatabase(env);
    const existingValue = await db.get(blobKey(blob.sha256));
    const existing = existingValue ? JSON.parse(existingValue) : {};
    await db.put(blobKey(blob.sha256), JSON.stringify({
        ...blob,
        owners: Array.isArray(existing.owners) ? existing.owners : [],
    }));
}

export async function deleteBlob(env, sha256) {
    if (usesD1(env)) {
        await env.img_d1.prepare('DELETE FROM blossom_blobs WHERE sha256 = ?').bind(sha256).run();
        return;
    }
    await getDatabase(env).delete(blobKey(sha256));
}

export async function hasOwnership(env, sha256, pubkey) {
    if (usesD1(env)) {
        const row = await env.img_d1.prepare(
            'SELECT 1 AS found FROM blossom_ownership WHERE sha256 = ? AND pubkey = ?'
        ).bind(sha256, pubkey).first();
        return !!row;
    }
    const value = await getDatabase(env).get(blobKey(sha256));
    const owners = value ? JSON.parse(value).owners : [];
    return Array.isArray(owners) && owners.includes(pubkey);
}

export async function addOwnership(env, sha256, pubkey, createdAt) {
    if (usesD1(env)) {
        await env.img_d1.prepare(
            'INSERT OR IGNORE INTO blossom_ownership (sha256, pubkey, created_at) VALUES (?, ?, ?)'
        ).bind(sha256, pubkey, createdAt).run();
        return;
    }
    const db = getDatabase(env);
    const key = blobKey(sha256);
    const value = await db.get(key);
    if (!value) throw new Error('Blossom blob metadata is missing');
    const record = JSON.parse(value);
    const owners = new Set(Array.isArray(record.owners) ? record.owners : []);
    owners.add(pubkey);
    record.owners = [...owners];
    await db.put(key, JSON.stringify(record));
}

export async function removeOwnership(env, sha256, pubkey) {
    if (usesD1(env)) {
        await env.img_d1.prepare(
            'DELETE FROM blossom_ownership WHERE sha256 = ? AND pubkey = ?'
        ).bind(sha256, pubkey).run();
        return;
    }
    const db = getDatabase(env);
    const key = blobKey(sha256);
    const value = await db.get(key);
    if (!value) return;
    const record = JSON.parse(value);
    record.owners = (Array.isArray(record.owners) ? record.owners : []).filter(owner => owner !== pubkey);
    await db.put(key, JSON.stringify(record));
}

export async function countOwnerships(env, sha256) {
    if (usesD1(env)) {
        const row = await env.img_d1.prepare(
            'SELECT COUNT(*) AS count FROM blossom_ownership WHERE sha256 = ?'
        ).bind(sha256).first();
        return Number(row?.count || 0);
    }
    const value = await getDatabase(env).get(blobKey(sha256));
    const owners = value ? JSON.parse(value).owners : [];
    return new Set(Array.isArray(owners) ? owners : []).size;
}
