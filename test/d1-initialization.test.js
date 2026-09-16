import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { onRequestPost as adminLogin } from '../functions/api/auth/adminLogin.js';
import { onRequestGet as databaseStatus } from '../functions/api/system/database-status.js';
import { getUploadConfig } from '../functions/api/manage/sysConfig/upload.js';
import {
    checkDatabaseInitialization,
    getDatabase,
    REQUIRED_D1_TABLES,
} from '../functions/utils/databaseAdapter.js';
import { checkDatabaseConfig as databaseMiddleware } from '../functions/utils/middleware.js';
import { SqliteD1 } from '../deploy/server/sqliteD1.js';

const initSql = readFileSync(new URL('../database/init.sql', import.meta.url), 'utf8');
const metadataMigration = readFileSync(
    new URL('../database/migrations/v2.8.0_add_blossom_metadata.sql', import.meta.url),
    'utf8',
);
const allowlistMigration = readFileSync(
    new URL('../database/migrations/v2.9.0_add_blossom_allowlist.sql', import.meta.url),
    'utf8',
);
const settingsMigration = readFileSync(
    new URL('../database/migrations/v2.10.0_add_blossom_settings.sql', import.meta.url),
    'utf8',
);

function loginRequest(username = 'admin', password = 'secret') {
    return new Request('https://img.example/api/auth/adminLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
    });
}

function initializedEnv(extra = {}) {
    const img_d1 = new SqliteD1(':memory:');
    img_d1.exec(initSql);
    return { img_d1, BASIC_USER: 'admin', BASIC_PASS: 'secret', ...extra };
}

describe('D1 initialization diagnostics', () => {
    it('reports a missing database binding clearly from admin login and middleware', async () => {
        const response = await adminLogin({ env: {}, request: loginRequest() });
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), {
            error: 'database_not_configured',
            message: 'D1 database is not configured. Bind a D1 database to "img_d1".',
        });

        const middlewareResponse = await databaseMiddleware({
            env: {},
            request: loginRequest(),
            next: async () => new Response('unexpected'),
        });
        assert.equal(middlewareResponse.status, 503);
        assert.equal((await middlewareResponse.json()).error, 'database_not_configured');

        const statusThroughMiddleware = await databaseMiddleware({
            env: {},
            request: new Request('https://img.example/api/system/database-status'),
            next: () => databaseStatus({ env: {} }),
        });
        assert.deepEqual(await statusThroughMiddleware.json(), {
            database: { configured: false, initialized: false, type: null },
        });
    });

    it('reports every required table when an empty D1 is bound', async () => {
        const env = { img_d1: new SqliteD1(':memory:') };
        const response = await adminLogin({ env, request: loginRequest() });

        assert.equal(response.status, 503);
        const body = await response.json();
        assert.equal(body.error, 'database_not_initialized');
        assert.deepEqual(body.missingTables, [...REQUIRED_D1_TABLES]);
    });

    it('initializes a fresh D1 completely and remains idempotent without data loss', async () => {
        const img_d1 = new SqliteD1(':memory:');
        img_d1.exec(initSql);

        const firstStatus = await checkDatabaseInitialization({ img_d1 });
        assert.deepEqual(firstStatus, {
            configured: true,
            initialized: true,
            type: 'd1',
            missingTables: [],
        });

        await img_d1.prepare(
            "INSERT INTO settings (key, value) VALUES ('test@preserved', 'yes')"
        ).run();
        img_d1.exec(initSql);

        const preserved = await img_d1.prepare(
            "SELECT value FROM settings WHERE key = 'test@preserved'"
        ).first();
        assert.equal(preserved.value, 'yes');
        assert.equal((await checkDatabaseInitialization({ img_d1 })).initialized, true);
        assert.doesNotMatch(initSql, /^\s*(DROP TABLE|DELETE FROM)\b/im);
    });

    it('enters normal admin authentication after initialization', async () => {
        const env = initializedEnv();
        const response = await adminLogin({ env, request: loginRequest() });

        assert.equal(response.status, 200);
        assert.equal((await response.json()).success, true);
        assert.match(response.headers.get('Set-Cookie'), /^admin_session=/);
    });

    it('uses admin/admin only as the final fresh-install credential fallback', async () => {
        const env = initializedEnv({ BASIC_USER: undefined, BASIC_PASS: undefined });
        assert.equal((await adminLogin({ env, request: loginRequest('admin', 'admin') })).status, 200);
        assert.equal((await adminLogin({ env, request: loginRequest('admin', 'wrong') })).status, 401);

        await getDatabase(env).put('manage@sysConfig@security', JSON.stringify({
            auth: { admin: { adminUsername: 'stored', adminPassword: 'stored-pass' } },
        }));
        assert.equal((await adminLogin({ env, request: loginRequest('stored', 'stored-pass') })).status, 200);
        assert.equal((await adminLogin({ env, request: loginRequest('admin', 'admin') })).status, 401);
    });

    it('keeps incorrect admin credentials distinct from database errors', async () => {
        const env = initializedEnv();
        const response = await adminLogin({ env, request: loginRequest('admin', 'wrong') });

        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { error: 'unauthorized' });
    });

    it('adds Blossom tables to an existing ImgBed database without changing existing data', async () => {
        const img_d1 = new SqliteD1(':memory:');
        img_d1.exec(`
            CREATE TABLE files (id TEXT PRIMARY KEY, value TEXT, metadata TEXT NOT NULL);
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE index_operations (id TEXT PRIMARY KEY, type TEXT NOT NULL, timestamp INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE TABLE index_metadata (key TEXT PRIMARY KEY);
            CREATE TABLE other_data (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO files (id, value, metadata) VALUES ('existing-file', 'value', '{}');
        `);

        img_d1.exec(metadataMigration);
        img_d1.exec(allowlistMigration);
        // The real ImgBed settings schema includes these columns. Add them to
        // this minimal legacy fixture before applying the settings migration.
        img_d1.exec('ALTER TABLE settings ADD COLUMN category TEXT; ALTER TABLE settings ADD COLUMN description TEXT;');
        img_d1.exec(settingsMigration);

        const preserved = await img_d1.prepare(
            "SELECT value FROM files WHERE id = 'existing-file'"
        ).first();
        assert.equal(preserved.value, 'value');
        assert.equal((await img_d1.prepare("SELECT value FROM settings WHERE key = 'blossom_enabled'").first()).value, 'false');
        assert.equal((await checkDatabaseInitialization({ img_d1 })).initialized, true);
    });

    it('exposes only safe database status details', async () => {
        const env = { img_d1: new SqliteD1(':memory:') };
        const response = await databaseStatus({ env });
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.database.configured, true);
        assert.equal(body.database.initialized, false);
        assert.equal(body.database.type, 'd1');
        assert.deepEqual(body.database.missingTables, [...REQUIRED_D1_TABLES]);
        assert.equal(JSON.stringify(body).includes('database_id'), false);
    });

    it('preserves all existing storage channel configuration readers', async () => {
        const env = initializedEnv({
            TG_BOT_TOKEN: 'tg-token',
            TG_CHAT_ID: 'chat',
            img_r2: {},
            S3_ACCESS_KEY_ID: 's3-key',
            S3_SECRET_ACCESS_KEY: 's3-secret',
            S3_BUCKET_NAME: 'bucket',
            S3_ENDPOINT: 'https://s3.example',
            DISCORD_BOT_TOKEN: 'discord-token',
            DISCORD_CHANNEL_ID: 'channel',
            HF_TOKEN: 'hf-token',
            HF_REPO: 'owner/repo',
            WEBDAV_BASE_URL: 'https://dav.example',
        });

        const config = await getUploadConfig(getDatabase(env), env);
        assert.equal(config.telegram.channels[0].type, 'telegram');
        assert.equal(config.cfr2.channels[0].type, 'cfr2');
        assert.equal(config.s3.channels[0].type, 's3');
        assert.equal(config.webdav.channels[0].type, 'webdav');
        assert.equal(config.huggingface.channels[0].type, 'huggingface');
        assert.equal(config.discord.channels[0].type, 'discord');
    });
});
