import {
    addAllowedPubkey, AllowlistValidationError, listAllowedPubkeys,
} from '../../../blossom/allowlist.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(value, status = 200) {
    return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

export async function onRequestGet({ env }) {
    return json(await listAllowedPubkeys(env));
}

export async function onRequestPost({ request, env }) {
    try {
        const contentLength = Number(request.headers.get('Content-Length') || 0);
        if (contentLength > 4096) return json({ error: 'request_too_large' }, 413);
        const body = await request.json();
        const result = await addAllowedPubkey(env, body?.pubkey, body?.note);
        return json(result, result.created ? 201 : 200);
    } catch (error) {
        if (error instanceof AllowlistValidationError) {
            return json({ error: 'invalid_request', message: error.message }, 400);
        }
        if (error instanceof SyntaxError) return json({ error: 'invalid_json' }, 400);
        throw error;
    }
}

export function onRequest() {
    return json({ error: 'method_not_allowed' }, 405);
}
