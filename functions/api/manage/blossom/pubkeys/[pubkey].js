import {
    AllowlistValidationError, removeAllowedPubkey,
} from '../../../../blossom/allowlist.js';
import { validateBlossomAdmin } from '../../../../blossom/adminAuth.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(value, status = 200) {
    return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

export async function onRequestDelete({ env, request, params }) {
    try {
        const admin = await validateBlossomAdmin(env, request);
        if (!admin.authorized) return json({ error: admin.reason }, 401);
    } catch (error) {
        console.error('Blossom admin authentication failed:', error);
        return json({ error: 'admin_auth_unavailable' }, 503);
    }

    try {
        const result = await removeAllowedPubkey(env, params.pubkey);
        return json(result, result.removed ? 200 : 404);
    } catch (error) {
        if (error instanceof AllowlistValidationError) {
            return json({ error: 'invalid_pubkey', message: error.message }, 400);
        }
        throw error;
    }
}

export function onRequest() {
    return json({ error: 'method_not_allowed' }, 405);
}
