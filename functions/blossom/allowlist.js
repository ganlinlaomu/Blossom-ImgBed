import { nip19 } from 'nostr-tools';
import { getDatabase } from '../utils/databaseAdapter.js';

const PUBKEY_PATTERN = /^[0-9a-f]{64}$/;
const KV_PREFIX = 'manage@blossom@allowed-pubkey@';
const MAX_NOTE_LENGTH = 200;
const d1SchemaPromises = new WeakMap();

export class AllowlistValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AllowlistValidationError';
    }
}

function usesD1(env) {
    return !!(env?.img_d1 && typeof env.img_d1.prepare === 'function');
}

async function ensureD1Schema(env) {
    if (!usesD1(env)) return;

    const database = env.img_d1;
    let schemaPromise = d1SchemaPromises.get(database);
    if (!schemaPromise) {
        schemaPromise = (async () => {
            await database.prepare(`
                CREATE TABLE IF NOT EXISTS blossom_allowed_pubkeys (
                    pubkey TEXT PRIMARY KEY,
                    note TEXT,
                    created_at INTEGER NOT NULL
                )
            `).run();
            await database.prepare(`
                CREATE INDEX IF NOT EXISTS idx_blossom_allowed_pubkeys_created_at
                ON blossom_allowed_pubkeys(created_at DESC)
            `).run();
        })();
        d1SchemaPromises.set(database, schemaPromise);
        schemaPromise.catch(() => d1SchemaPromises.delete(database));
    }

    await schemaPromise;
}

export function normalizePubkey(value) {
    if (typeof value !== 'string') {
        throw new AllowlistValidationError('pubkey must be a 64-character hex key or npub');
    }

    const input = value.trim();
    if (/^[0-9a-fA-F]{64}$/.test(input)) return input.toLowerCase();

    if (input.toLowerCase().startsWith('npub1')) {
        try {
            const decoded = nip19.decode(input.toLowerCase());
            if (decoded.type === 'npub' && typeof decoded.data === 'string' && PUBKEY_PATTERN.test(decoded.data)) {
                return decoded.data;
            }
        } catch {
            // Normalize all bech32 decoding failures into the public validation error below.
        }
    }

    throw new AllowlistValidationError('pubkey must be a valid 64-character hex key or npub');
}

export function normalizeNote(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw new AllowlistValidationError('note must be a string');
    const note = value.trim();
    if (note.length > MAX_NOTE_LENGTH) {
        throw new AllowlistValidationError(`note must be at most ${MAX_NOTE_LENGTH} characters`);
    }
    return note || null;
}

function toEntry(record) {
    const pubkey = record.pubkey;
    return {
        pubkey,
        npub: nip19.npubEncode(pubkey),
        note: record.note ?? null,
        createdAt: Number(record.createdAt ?? record.created_at),
    };
}

function kvKey(pubkey) {
    return `${KV_PREFIX}${pubkey}`;
}

export async function isPubkeyAllowed(env, pubkey) {
    const normalized = normalizePubkey(pubkey);
    if (usesD1(env)) {
        await ensureD1Schema(env);
        const row = await env.img_d1.prepare(
            'SELECT 1 AS found FROM blossom_allowed_pubkeys WHERE pubkey = ?'
        ).bind(normalized).first();
        return !!row;
    }
    return await getDatabase(env).get(kvKey(normalized)) !== null;
}

export async function listAllowedPubkeys(env) {
    if (usesD1(env)) {
        await ensureD1Schema(env);
        const response = await env.img_d1.prepare(
            'SELECT pubkey, note, created_at FROM blossom_allowed_pubkeys ORDER BY created_at DESC, pubkey ASC'
        ).all();
        return (response.results || []).map(toEntry);
    }

    const db = getDatabase(env);
    const entries = [];
    let cursor;
    do {
        const page = await db.list({ prefix: KV_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
        for (const key of page.keys || []) {
            const value = await db.get(key.name);
            if (!value) continue;
            try {
                entries.push(toEntry(JSON.parse(value)));
            } catch {
                console.warn(`Ignoring malformed Blossom allowlist entry: ${key.name}`);
            }
        }
        cursor = page.list_complete === false ? page.cursor : undefined;
    } while (cursor);

    return entries.sort((a, b) => b.createdAt - a.createdAt || a.pubkey.localeCompare(b.pubkey));
}

export async function addAllowedPubkey(env, pubkey, note, createdAt = Math.floor(Date.now() / 1000)) {
    const normalized = normalizePubkey(pubkey);
    const normalizedNote = normalizeNote(note);
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
        throw new AllowlistValidationError('createdAt must be a positive integer');
    }

    if (usesD1(env)) {
        await ensureD1Schema(env);
        const result = await env.img_d1.prepare(
            'INSERT OR IGNORE INTO blossom_allowed_pubkeys (pubkey, note, created_at) VALUES (?, ?, ?)'
        ).bind(normalized, normalizedNote, createdAt).run();
        const created = Number(result?.meta?.changes || 0) > 0;
        const row = await env.img_d1.prepare(
            'SELECT pubkey, note, created_at FROM blossom_allowed_pubkeys WHERE pubkey = ?'
        ).bind(normalized).first();
        return { created, entry: toEntry(row) };
    }

    const db = getDatabase(env);
    const key = kvKey(normalized);
    const existing = await db.get(key);
    if (existing) return { created: false, entry: toEntry(JSON.parse(existing)) };
    const record = { pubkey: normalized, note: normalizedNote, createdAt };
    await db.put(key, JSON.stringify(record));
    return { created: true, entry: toEntry(record) };
}

export async function removeAllowedPubkey(env, pubkey) {
    const normalized = normalizePubkey(pubkey);
    if (usesD1(env)) {
        await ensureD1Schema(env);
        const result = await env.img_d1.prepare(
            'DELETE FROM blossom_allowed_pubkeys WHERE pubkey = ?'
        ).bind(normalized).run();
        return { removed: Number(result?.meta?.changes || 0) > 0, pubkey: normalized };
    }

    const db = getDatabase(env);
    const key = kvKey(normalized);
    const existing = await db.get(key);
    if (!existing) return { removed: false, pubkey: normalized };
    await db.delete(key);
    return { removed: true, pubkey: normalized };
}
