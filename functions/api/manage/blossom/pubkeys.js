import {
    addAllowedPubkey, AllowlistValidationError, listAllowedPubkeys,
} from '../../../blossom/allowlist.js';
import { validateBlossomAdmin } from '../../../blossom/adminAuth.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(value, status = 200) {
    return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

async function requireAdmin(env, request) {
    try {
        const result = await validateBlossomAdmin(env, request);
        return result.authorized ? null : json({ error: result.reason }, 401);
    } catch (error) {
        console.error('Blossom admin authentication failed:', error);
        return json({ error: 'admin_auth_unavailable' }, 503);
    }
}

export async function onRequestGet({ env, request }) {
    const unauthorized = await requireAdmin(env, request);
    if (unauthorized) return unauthorized;
    return json(await listAllowedPubkeys(env));
}

export async function onRequestPost({ request, env }) {
    const unauthorized = await requireAdmin(env, request);
    if (unauthorized) return unauthorized;
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
