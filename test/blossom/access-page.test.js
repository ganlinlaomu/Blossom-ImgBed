import assert from 'node:assert/strict';
import { onRequest } from '../../functions/blossom-access.html.js';
import { createKvEnv } from './allowlist.test.js';

function context(env, request, next = async () => new Response('asset')) {
    return { env, request, next };
}

describe('Blossom access admin page', () => {
    it('redirects a visitor without an admin session before serving the page', async () => {
        const { env } = createKvEnv();
        const request = new Request('https://img.example/blossom-access.html');
        let assetServed = false;
        env.BASIC_USER = 'admin';
        env.BASIC_PASS = 'configured';
        env.ASSETS = {
            async fetch() {
                assetServed = true;
                return new Response('private page');
            },
        };

        const response = await onRequest(context(env, request));

        assert.equal(response.status, 302);
        assert.equal(response.headers.get('Location'), 'https://img.example/adminLogin?redirect=%2Fblossom-access.html');
        assert.equal(assetServed, false);
    });

    it('serves the page only with a valid admin session and disables caching', async () => {
        const { env, values } = createKvEnv();
        env.BASIC_USER = 'admin';
        env.BASIC_PASS = 'configured';
        values.set('manage@session@valid-admin', JSON.stringify({
            authType: 'admin',
            username: 'admin',
            createdAt: Date.now(),
            expiresAt: Date.now() + 60_000,
        }));
        env.ASSETS = { fetch: async () => new Response('private page') };

        const response = await onRequest(context(env, new Request(
            'https://img.example/blossom-access.html',
            { headers: { Cookie: 'admin_session=valid-admin' } },
        )));

        assert.equal(response.status, 200);
        assert.equal(await response.text(), 'private page');
        assert.equal(response.headers.get('Cache-Control'), 'private, no-store, max-age=0');
    });
});
