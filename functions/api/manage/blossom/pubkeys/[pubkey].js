import {
    AllowlistValidationError, removeAllowedPubkey,
} from '../../../../blossom/allowlist.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(value, status = 200) {
    return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

export async function onRequestDelete({ env, params }) {
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
