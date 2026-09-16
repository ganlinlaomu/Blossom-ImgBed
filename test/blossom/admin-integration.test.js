import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createDeleteHandler } from '../../functions/blossom/delete.js';
import { createBlobHandler } from '../../functions/blossom/blob.js';
import { createUploadHandler } from '../../functions/blossom/upload.js';
import { getBlossomSettings, setBlossomEnabled } from '../../functions/blossom/settings.js';
import {
    onRequestGet as getSettings, onRequestPost as saveSettings,
} from '../../functions/api/manage/blossom/settings.js';
import { onRequest as manageMiddleware } from '../../functions/api/manage/_middleware.js';
import { createKvEnv } from './allowlist.test.js';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

describe('Blossom product integration', () => {
    it('ships a landing-only public homepage and conditionally boots the existing Admin SPA', () => {
        const html = read('frontend-dist/index.html');
        assert.match(html, /<title>Blossom-ImgBed<\/title>/);
        assert.match(html, /Admin Login/);
        assert.match(html, /CloudFlare-ImgBed storage engine/);
        assert.match(html, /window\.location\.pathname === '\/'/);
        assert.doesNotMatch(html, /blossom-access-link|blossom-upload-link|NIP-07|User Login|authCode/);
        assert.doesNotMatch(html, /href="\/login"|href="\/blossom-upload\.html"|href="\/blossom-access\.html"/);
    });

    it('integrates Blossom controls into the existing System Settings page', () => {
        const script = read('frontend-dist/js/blossom-admin-settings.js');
        assert.match(script, /pushState/);
        assert.match(script, /blossom-admin-shortcut/);
        assert.match(script, /\/systemConfig#blossom/);
        assert.match(script, /Enable Blossom/);
        assert.match(script, /Allowed Nostr Pubkeys/);
        assert.match(script, /\/api\/manage\/blossom\/settings/);
        assert.match(script, /\/api\/manage\/blossom\/pubkeys/);
    });

    it('defaults the persisted setting off and derives Server URL from the request origin', async () => {
        const { env, values } = createKvEnv();
        const request = new Request('https://media.example/api/manage/blossom/settings');
        assert.deepEqual(await getBlossomSettings(env, request), {
            enabled: false,
            serverUrl: 'https://media.example',
        });
        await setBlossomEnabled(env, true);
        assert.equal(values.get('blossom_enabled'), 'true');
        assert.equal((await getSettings({ env, request })).status, 200);
    });

    it('validates and persists settings through the Admin API handler', async () => {
        const { env } = createKvEnv();
        const url = 'https://media.example/api/manage/blossom/settings';
        const invalid = await saveSettings({ env, request: new Request(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        }) });
        assert.equal(invalid.status, 400);
        const saved = await saveSettings({ env, request: new Request(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
        }) });
        assert.deepEqual(await saved.json(), { enabled: true, serverUrl: 'https://media.example' });
    });

    it('denies an unauthenticated request to both Blossom management endpoints', async () => {
        const { env } = createKvEnv();
        env.BASIC_USER = 'admin';
        env.BASIC_PASS = 'secret';
        for (const path of ['/api/manage/blossom/settings', '/api/manage/blossom/pubkeys']) {
            let reached = false;
            const response = await manageMiddleware[1]({
                env,
                request: new Request(`https://media.example${path}`),
                next: async () => { reached = true; return new Response('unexpected'); },
            });
            assert.equal(response.status, 401);
            assert.equal(reached, false);
        }
    });

    it('rejects upload and delete while disabled before authentication or storage', async () => {
        const { env } = createKvEnv();
        let authenticated = 0;
        let stored = 0;
        const upload = createUploadHandler({
            authenticate: () => { authenticated++; return { pubkey: '1'.repeat(64) }; },
            uploadViaImgBed: async () => { stored++; },
        });
        const uploadResponse = await upload({
            env,
            request: new Request('https://media.example/upload', {
                method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'data',
            }),
        }, async () => {});
        assert.equal(uploadResponse.status, 403);
        assert.deepEqual(await uploadResponse.json(), { error: 'blossom_disabled' });

        const remove = createDeleteHandler({
            authenticate: () => { authenticated++; return { pubkey: '1'.repeat(64) }; },
            deleteViaImgBed: async () => { stored++; },
        });
        const deleteResponse = await remove({
            env,
            request: new Request(`https://media.example/${'a'.repeat(64)}`, { method: 'DELETE' }),
        }, 'a'.repeat(64));
        assert.equal(deleteResponse.status, 403);
        assert.deepEqual(await deleteResponse.json(), { error: 'blossom_disabled' });
        assert.equal(authenticated, 0);
        assert.equal(stored, 0);
    });

    it('continues serving existing blobs while writes are disabled', async () => {
        const { env } = createKvEnv();
        const hash = 'b'.repeat(64);
        const handler = createBlobHandler({
            getBlob: async () => ({
                sha256: hash, imgbedId: 'existing.bin', size: 4,
                type: 'application/octet-stream', uploaded: 1,
            }),
            readViaImgBed: async () => new Response('data'),
        });
        const response = await handler({
            env, request: new Request(`https://media.example/${hash}`),
        }, hash);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), 'data');
    });
});
