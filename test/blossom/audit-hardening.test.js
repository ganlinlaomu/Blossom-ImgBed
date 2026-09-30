import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { SqliteD1 } from '../../deploy/server/sqliteD1.js';
import { applyMigrations } from '../../deploy/server/migrations.js';
import { createApiToken, deleteApiToken } from '../../functions/api/manage/apiTokens.js';
import { getDatabase } from '../../functions/utils/databaseAdapter.js';
import { issueUploadToken, authenticateUploadToken, consumeBoundUploadToken } from '../../functions/blossom/upload-token.js';
import { acquireBlobLock, releaseBlobLock, acquireUploadSlot, releaseUploadSlot } from '../../functions/blossom/blob-lock.js';
import { readAndHashRequest } from '../../functions/blossom/hash.js';
import { reserveTokenIssue } from '../../functions/blossom/request-limits.js';
import { errorResponse } from '../../functions/blossom/errors.js';
import { createUploadHandler } from '../../functions/blossom/upload.js';
import { createDeleteHandler } from '../../functions/blossom/delete.js';
import { addOwnership, hasOwnership, putBlob } from '../../functions/blossom/metadata.js';
import { onRequestPost } from '../../functions/api/service/upload-token.js';

const subject = 'a'.repeat(64), hash = 'b'.repeat(64);
const init = readFileSync(new URL('../../database/init.sql', import.meta.url), 'utf8');
function env() { const img_d1 = new SqliteD1(':memory:'); img_d1.exec(init); return { img_d1 }; }
function req(token) { return new Request('https://x/upload', { headers: { Authorization: `Bearer ${token}` } }); }

describe('audit hardening regressions', () => {
    it('upgrades a partly migrated database, records each migration and safely restarts', () => {
        const db = new Database(':memory:');
        try {
            db.exec('CREATE TABLE blossom_upload_tokens (token_hash TEXT PRIMARY KEY, content_hash TEXT)');
            const sql = readFileSync(new URL('../../database/migrations/v2.14.0_bound_upload_tokens.sql', import.meta.url), 'utf8');
            applyMigrations(db, [{ name: 'v2.14.0', sql }]);
            applyMigrations(db, [{ name: 'v2.14.0', sql }]);
            assert.deepEqual(db.prepare('PRAGMA table_info(blossom_upload_tokens)').all().map(x => x.name),
                ['token_hash', 'content_hash', 'max_bytes', 'used_at']);
            assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, 1);
            assert.throws(() => applyMigrations(db, [{ name: 'v2.14.0', sql: sql + '\n-- changed' }]), /migration failed/i);
        } finally { db.close(); }
    });
    it('rolls back real migration failures and does not record them as applied', () => {
        const db = new Database(':memory:');
        try {
            assert.throws(() => applyMigrations(db, [{ name: 'broken', sql: 'CREATE TABLE half (id TEXT); BAD SQL;' }]), /migration failed/i);
            assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='half'").get().n, 0);
            assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, 0);
        } finally { db.close(); }
    });
    it('applies the complete migration set to a fresh initialized database twice', () => {
        const db = new Database(':memory:');
        try {
            db.exec(init);
            const directory = new URL('../../database/migrations/', import.meta.url);
            const migrations = readdirSync(directory).filter(x => x.endsWith('.sql')).map(name => ({ name, sql: readFileSync(new URL(name, directory), 'utf8') }));
            applyMigrations(db, migrations); applyMigrations(db, migrations);
            assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, migrations.length);
        } finally { db.close(); }
    });
    it('denies a child after parent deletion, including revocation during body reception', async () => {
        const e = env();
        try {
            const parent = await createApiToken(getDatabase(e), 'issuer', ['issue_upload_token'], 'owner', null, false, 'service');
            const issued = await issueUploadToken(e, { subject, contentHash: hash, maxBytes: 50, parentTokenId: parent.id });
            const auth = await authenticateUploadToken(req(issued.token), e);
            await deleteApiToken(getDatabase(e), parent.id);
            await assert.rejects(authenticateUploadToken(req(issued.token), e), /revoked_upload_token_parent/);
            await assert.rejects(consumeBoundUploadToken(e, auth, hash, 50), /revoked_upload_token_parent/);
        } finally { e.img_d1.db.close(); }
    });
    it('denies children when parent permission is removed or expiry is invalid', async () => {
        const e = env();
        try {
            const parent = await createApiToken(getDatabase(e), 'issuer', ['issue_upload_token'], 'owner', null, false, 'service');
            const issued = await issueUploadToken(e, { subject, parentTokenId: parent.id });
            const settings = JSON.parse(await getDatabase(e).get('manage@sysConfig@security'));
            settings.apiTokens.tokens[parent.id].permissions = ['upload'];
            await getDatabase(e).put('manage@sysConfig@security', JSON.stringify(settings));
            await assert.rejects(authenticateUploadToken(req(issued.token), e), /revoked_upload_token_parent/);
            settings.apiTokens.tokens[parent.id].permissions = ['issue_upload_token'];
            settings.apiTokens.tokens[parent.id].expiresAt = 'invalid';
            await getDatabase(e).put('manage@sysConfig@security', JSON.stringify(settings));
            await assert.rejects(authenticateUploadToken(req(issued.token), e), /revoked_upload_token_parent/);
        } finally { e.img_d1.db.close(); }
    });
    it('atomically excludes concurrent upload/delete operations and only releases the owning lock', async () => {
        const e = env();
        try {
            const results = await Promise.allSettled([acquireBlobLock(e, hash, 'upload'), acquireBlobLock(e, hash, 'delete')]);
            assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
            const lock = results.find(x => x.status === 'fulfilled').value;
            await releaseBlobLock(e, { ...lock, owner: 'wrong' });
            await assert.rejects(acquireBlobLock(e, hash, 'delete'), /operation_in_progress/);
            await releaseBlobLock(e, lock);
            await releaseBlobLock(e, await acquireBlobLock(e, hash, 'delete'));
        } finally { e.img_d1.db.close(); }
    });
    it('denies KV-only mutations rather than claiming a distributed lock exists', async () => {
        await assert.rejects(acquireBlobLock({}, hash, 'upload'), /writes_require_d1/);
    });
    it('bounds concurrent body receivers before buffering and releases only the owner slot', async () => {
        const e = { ...env(), BLOSSOM_MAX_CONCURRENT_UPLOADS: '1' };
        try {
            const results = await Promise.allSettled([acquireUploadSlot(e), acquireUploadSlot(e)]);
            assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
            const owner = results.find(x => x.status === 'fulfilled').value;
            await releaseUploadSlot(e, 'wrong');
            await assert.rejects(acquireUploadSlot(e), /concurrency_limit/);
            await releaseUploadSlot(e, owner);
            await releaseUploadSlot(e, await acquireUploadSlot(e));
        } finally { e.img_d1.db.close(); }
    });
    it('cancels a stalled body after the configured idle deadline', async () => {
        let cancelled = false;
        const request = new Request('https://x/upload', { method: 'PUT', duplex: 'half',
            body: new ReadableStream({ cancel() { cancelled = true; } }) });
        await assert.rejects(readAndHashRequest(request, 50, { timeoutMs: 50, idleTimeoutMs: 10 }), /read_timeout/);
        assert.equal(cancelled, true);
    });
    it('cancels an aborted body', async () => {
        const controller = new AbortController();
        const request = new Request('https://x/upload', { method: 'PUT', duplex: 'half', signal: controller.signal,
            body: new ReadableStream() });
        const reading = readAndHashRequest(request, 50);
        controller.abort();
        await assert.rejects(reading, /upload_aborted/);
    });
    it('limits token minting atomically across concurrent requests', async () => {
        const e = { ...env(), BLOSSOM_TOKEN_ISSUES_PER_MINUTE: '1' };
        try {
            const results = await Promise.allSettled([reserveTokenIssue(e, 'issuer', 100), reserveTokenIssue(e, 'issuer', 100)]);
            assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
            assert.match(results.find(x => x.status === 'rejected').reason.message, /rate_limited/);
            await reserveTokenIssue(e, 'issuer', 160);
        } finally { e.img_d1.db.close(); }
    });
    it('rejects oversized chunked JSON at the issuer', async () => {
        const e = env();
        try {
            const parent = await createApiToken(getDatabase(e), 'issuer', ['issue_upload_token'], 'owner', null, false, 'service');
            const request = new Request('https://x/api/service/upload-token', { method: 'POST', duplex: 'half',
                headers: { Authorization: `Bearer ${parent.token}` },
                body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(8193)); c.close(); } }) });
            assert.equal((await onRequestPost({ request, env: e })).status, 413);
        } finally { e.img_d1.db.close(); }
    });
    it('rejects non-string content bindings before database insertion', async () => {
        const e = env();
        try {
            await assert.rejects(issueUploadToken(e, { subject, contentHash: [hash], maxBytes: 10 }), /invalid_upload_binding/);
        } finally { e.img_d1.db.close(); }
    });
    it('supports explicit retirement of unbound tokens without breaking the default rollout', async () => {
        const e = env();
        try {
            const legacy = await issueUploadToken(e, { subject });
            assert.equal((await authenticateUploadToken(req(legacy.token), e)).authorized, true);
            e.BLOSSOM_REQUIRE_BOUND_UPLOAD_TOKENS = 'true';
            await assert.rejects(authenticateUploadToken(req(legacy.token), e), /binding_required/);
            await assert.rejects(issueUploadToken(e, { subject }), /binding_required/);
            const bound = await issueUploadToken(e, { subject, contentHash: hash, maxBytes: 10 });
            assert.equal((await authenticateUploadToken(req(bound.token), e)).authorized, true);
        } finally { e.img_d1.db.close(); }
    });
    it('does not reveal internal error details in response body or X-Reason', async () => {
        const old = console.error; console.error = () => {};
        try {
            const response = errorResponse(new Error('database password sensitive'));
            assert.equal(response.status, 500);
            assert.equal(await response.text(), 'Internal Server Error');
            assert.equal(response.headers.get('X-Reason'), 'Internal Server Error');
        } finally { console.error = old; }
    });
    it('blocks an upload while deletion is in flight, then accepts after deletion completes', async () => {
        const e = env();
        let continueDelete; const gate = new Promise(resolve => { continueDelete = resolve; });
        let deleteEntered; const entered = new Promise(resolve => { deleteEntered = resolve; });
        let uploads = 0;
        try {
            await putBlob(e, { sha256: hash, imgbedId: 'old', size: 1, type: 'text/plain', uploaded: 1 });
            await addOwnership(e, hash, subject, 1);
            const deletion = createDeleteHandler({ isEnabled: async () => true, authenticate: () => ({ pubkey: subject }),
                isPubkeyAllowed: async () => true, deleteViaImgBed: async () => { deleteEntered(); await gate; return true; } });
            const pending = deletion({ env: e, request: new Request(`https://x/${hash}`, { method: 'DELETE' }) }, hash);
            await entered;
            const upload = createUploadHandler({ isEnabled: async () => true, authenticate: () => ({ pubkey: subject }),
                isPubkeyAllowed: async () => true, readAndHash: async () => ({ sha256: hash, size: 1, buffer: new Uint8Array(1).buffer }),
                uploadViaImgBed: async () => { uploads++; return 'new'; } });
            const ctx = () => ({ env: e, request: new Request('https://x/upload', { method: 'PUT', headers: { 'X-SHA-256': hash }, body: 'x' }) });
            assert.equal((await upload(ctx(), () => {})).status, 409);
            assert.equal(uploads, 0);
            continueDelete(); assert.equal((await pending).status, 204);
            assert.equal((await upload(ctx(), () => {})).status, 201);
            assert.equal(uploads, 1);
            assert.equal(await hasOwnership(e, hash, subject), true);
        } finally { continueDelete(); e.img_d1.db.close(); }
    });
    it('restores ownership and releases the lock when the delete pipeline throws', async () => {
        const e = env(); const old = console.error; console.error = () => {};
        try {
            await putBlob(e, { sha256: hash, imgbedId: 'old', size: 1, type: 'text/plain', uploaded: 1 });
            await addOwnership(e, hash, subject, 1);
            const deletion = createDeleteHandler({ isEnabled: async () => true, authenticate: () => ({ pubkey: subject }),
                isPubkeyAllowed: async () => true, deleteViaImgBed: async () => { throw new Error('backend failed'); } });
            assert.equal((await deletion({ env: e, request: new Request(`https://x/${hash}`, { method: 'DELETE' }) }, hash)).status, 500);
            assert.equal(await hasOwnership(e, hash, subject), true);
            await releaseBlobLock(e, await acquireBlobLock(e, hash, 'upload'));
        } finally { console.error = old; e.img_d1.db.close(); }
    });
});
