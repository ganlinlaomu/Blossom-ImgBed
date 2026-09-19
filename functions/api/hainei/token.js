import { BlossomError } from '../../blossom/errors.js';
import { exchangeHaiNeiChallengeForUploadToken } from '../../blossom/hainei-access.js';

const JSON_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
};

function json(value, status = 200) {
    return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

export async function onRequestPost({ request, env }) {
    try {
        const contentLengthHeader = request.headers.get('Content-Length');
        if (contentLengthHeader === null || contentLengthHeader === '') {
            return json({ error: 'content_length_required' }, 411);
        }
        if (!/^\d+$/.test(contentLengthHeader)) {
            return json({ error: 'invalid_content_length' }, 400);
        }
        const contentLength = Number(contentLengthHeader);
        if (!Number.isSafeInteger(contentLength) || contentLength > 65536) {
            return json({ error: 'request_too_large' }, 413);
        }

        const raw = await request.text();
        if (raw.length > 65536) return json({ error: 'request_too_large' }, 413);
        const body = raw ? JSON.parse(raw) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return json({ error: 'invalid_json_object' }, 400);
        }
        return json(await exchangeHaiNeiChallengeForUploadToken(request, env, body), 201);
    } catch (error) {
        if (error instanceof BlossomError) return json({ error: error.message }, error.status);
        if (error instanceof SyntaxError) return json({ error: 'invalid_json' }, 400);
        throw error;
    }
}

export function onRequestOptions() {
    return new Response(null, { status: 204, headers: JSON_HEADERS });
}

export function onRequest() {
    return json({ error: 'method_not_allowed' }, 405);
}
