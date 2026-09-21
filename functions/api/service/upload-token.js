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
            return jsonResponse({ error: status === 403 ? 'forbidden' : 'unauthorized', message: validation.error }, status, CORS_HEADERS);
        }
        if (validation.tokenData.type !== 'service') {
            throw new BlossomError(403, 'issue_upload_token requires a service API token');
        }

        let body;
        try {
            body = await request.json();
        } catch {
            throw new BlossomError(400, 'invalid_json');
        }
        const result = await issueUploadToken(env, {
            subject: body?.subject,
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
