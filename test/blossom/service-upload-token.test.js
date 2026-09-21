import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createApiToken } from '../../functions/api/manage/apiTokens.js';
import { onRequestPost as issueRoute } from '../../functions/api/service/upload-token.js';
import {
    authenticateUploadToken, hashUploadToken, issueUploadToken,
} from '../../functions/blossom/upload-token.js';
import { getDatabase } from '../../functions/utils/databaseAdapter.js';
import { validateApiToken } from '../../functions/utils/auth/tokenValidator.js';
import { authenticate, AUTH_SCOPE } from '../../functions/utils/auth/authCore.js';
import { SqliteD1 } from '../../deploy/server/sqliteD1.js';

const initSql = readFileSync(new URL('../../database/init.sql', import.meta.url), 'utf8');
const PUBKEY = '1'.repeat(64);

function env() {
    const img_d1 = new SqliteD1(':memory:');
    img_d1.exec(initSql);
    return { img_d1 };
}

function issuerRequest(token, body = { subject: PUBKEY, ttl: 3600 }) {
    return new Request('https://blossom.example/api/service/upload-token', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('service-issued Blossom upload tokens', () => {
    it('issues a hashed, subject-bound upload token through a permitted service API token', async () => {
        const testEnv = env();
        const service = await createApiToken(
            getDatabase(testEnv), 'HaiNei Backend', ['issue_upload_token'], 'hainei-worker', null, false, 'service'
        );
        const response = await issueRoute({ env: testEnv, request: issuerRequest(service.token) });
        assert.equal(response.status, 201);
        const issued = await response.json();
        assert.match(issued.token, /^imgbed_upload_[0-9a-f]{64}$/);
        assert.equal(issued.subject, PUBKEY);
        assert.equal(issued.scope, 'upload');

        const row = await testEnv.img_d1.prepare(
            'SELECT * FROM blossom_upload_tokens WHERE token_hash = ?'
        ).bind(await hashUploadToken(issued.token)).first();
        assert.equal(row.subject_pubkey, PUBKEY);
        assert.equal(row.parent_token_id, service.id);
        assert.equal(JSON.stringify(row).includes(issued.token), false);

        const auth = await authenticateUploadToken(new Request('https://blossom.example/upload', {
            headers: { Authorization: `Bearer ${issued.token}` },
        }), testEnv, issued.issuedAt);
        assert.equal(auth.pubkey, PUBKEY);
        assert.equal(auth.scope, 'upload');
    });

    it('denies service tokens without permission and non-service API tokens', async () => {
        const testEnv = env();
        const missing = await createApiToken(getDatabase(testEnv), 'No issuer', ['upload'], 'service', null, false, 'service');
        assert.equal((await issueRoute({ env: testEnv, request: issuerRequest(missing.token) })).status, 403);
        const user = await createApiToken(getDatabase(testEnv), 'User issuer', ['issue_upload_token'], 'user');
        assert.equal((await issueRoute({ env: testEnv, request: issuerRequest(user.token) })).status, 403);
    });

    it('rejects expired, revoked, and wrong-scope tokens', async () => {
        const testEnv = env();
        const expired = await issueUploadToken(testEnv, { subject: PUBKEY, ttl: 60 }, 100);
        await assert.rejects(
            authenticateUploadToken(new Request('https://x/upload', { headers: { Authorization: `Bearer ${expired.token}` } }), testEnv, 160),
            error => error.status === 401 && /expired/.test(error.message),
        );

        const revoked = await issueUploadToken(testEnv, { subject: PUBKEY, ttl: 60 }, 200);
        await testEnv.img_d1.prepare('UPDATE blossom_upload_tokens SET revoked_at = 201 WHERE token_hash = ?')
            .bind(await hashUploadToken(revoked.token)).run();
        await assert.rejects(
            authenticateUploadToken(new Request('https://x/upload', { headers: { Authorization: `Bearer ${revoked.token}` } }), testEnv, 202),
            error => error.status === 401 && /revoked/.test(error.message),
        );

        const wrong = await issueUploadToken(testEnv, { subject: PUBKEY, ttl: 60 }, 300);
        await testEnv.img_d1.prepare("UPDATE blossom_upload_tokens SET scope = 'delete' WHERE token_hash = ?")
            .bind(await hashUploadToken(wrong.token)).run();
        await assert.rejects(
            authenticateUploadToken(new Request('https://x/upload', { headers: { Authorization: `Bearer ${wrong.token}` } }), testEnv, 301),
            error => error.status === 403 && /scope/.test(error.message),
        );
    });

    it('does not treat a short-lived upload token as an API token or token issuer', async () => {
        const testEnv = env();
        const issued = await issueUploadToken(testEnv, { subject: PUBKEY, ttl: 60 }, 100);
        const request = issuerRequest(issued.token);
        assert.equal((await validateApiToken(request, getDatabase(testEnv), null)).valid, false);
        assert.equal((await issueRoute({ env: testEnv, request })).status, 401);
        const adminAuth = await authenticate({
            env: testEnv, request, requiredPermission: 'manage', authScope: AUTH_SCOPE.ADMIN,
        });
        assert.equal(adminAuth.authorized, false);
    });

    it('keeps normal API-token permissions explicit and reports api_token identity', async () => {
        const testEnv = env();
        const token = await createApiToken(getDatabase(testEnv), 'Uploader', ['upload'], 'alice');
        const request = new Request('https://blossom.example/upload', {
            headers: { Authorization: `Bearer ${token.token}` },
        });
        const valid = await validateApiToken(request, getDatabase(testEnv), 'upload');
        assert.equal(valid.valid, true);
        assert.equal(valid.tokenData.id, token.id);
        assert.equal(valid.tokenData.type, 'user');
        assert.equal((await validateApiToken(request, getDatabase(testEnv), 'delete')).valid, false);
        assert.equal((await validateApiToken(request, getDatabase(testEnv), 'list')).valid, false);

        const auth = await authenticate({
            env: testEnv, request, requiredPermission: 'upload', authScope: AUTH_SCOPE.EITHER,
        });
        assert.equal(auth.authType, 'api_token');
        assert.deepEqual(auth.permissions, ['upload']);
    });
});
