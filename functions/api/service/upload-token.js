import { reserveTokenIssue } from '../../blossom/request-limits.js';
import { readRequestBytes } from '../../blossom/hash.js';
import { issueUploadToken } from '../../blossom/upload-token.js';
import { BlossomError, errorResponse, jsonResponse } from '../../blossom/errors.js';
import { getDatabase } from '../../utils/databaseAdapter.js';
import { validateApiToken } from '../../utils/auth/tokenValidator.js';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Cache-Control': 'no-store',
};

export async function onRequestOptions() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost({ request, env }) {
    try {
        const validation = await validateApiToken(request, getDatabase(env), 'issue_upload_token');
        if (!validation.valid) {
            const status = validation.errorCode === 'missing_permission' ? 403 : 401;
            return jsonResponse(
                {
                    error: status === 403 ? 'forbidden' : 'unauthorized',
                    message: validation.error,
                },
                status,
                CORS_HEADERS,
            );
        }
        if (validation.tokenData.type !== 'service') {
            throw new BlossomError(403, 'issue_upload_token requires a service API token');
        }

        await reserveTokenIssue(env, validation.tokenData.id);
        let body;
        try {
            body = JSON.parse(new TextDecoder().decode(await readRequestBytes(request, 8192, { timeoutMs: 10000, idleTimeoutMs: 5000 })));
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid_json');
        } catch (error) {
            if (error instanceof BlossomError) throw error;
            throw new BlossomError(400, 'invalid_json');
        }
        const result = await issueUploadToken(env, {
            subject: body?.subject,
            contentHash: body?.contentHash,
            maxBytes: body?.maxBytes,
            ttl: body?.ttl,
            issuedBy: validation.tokenData.owner || null,
            parentTokenId: validation.tokenData.id,
        });
        return jsonResponse(result, 201, CORS_HEADERS);
    } catch (error) {
        return errorResponse(error, CORS_HEADERS);
    }
}

export function onRequest() {
    return jsonResponse({ error: 'method_not_allowed' }, 405, CORS_HEADERS);
}
