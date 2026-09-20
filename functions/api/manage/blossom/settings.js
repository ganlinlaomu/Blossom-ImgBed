import {
    getBlossomSettings, setBlossomSettings,
} from '../../../blossom/settings.js';

const JSON_HEADERS = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store, max-age=0',
};

function json(value, status = 200) {
    return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

export async function onRequestGet({ env, request }) {
    return json(await getBlossomSettings(env, request));
}

export async function onRequestPost({ env, request }) {
    try {
        const body = await request.json();
        if (typeof body?.enabled !== 'boolean') {
            return json({ error: 'enabled_must_be_boolean' }, 400);
        }
        if (
            body.allowHaiNeiClientsWithoutAllowlist !== undefined
            && typeof body.allowHaiNeiClientsWithoutAllowlist !== 'boolean'
        ) {
            return json({ error: 'allow_hainei_clients_without_allowlist_must_be_boolean' }, 400);
        }
        if (
            body.requireAllowlistForNonHaiNeiClients !== undefined
            && typeof body.requireAllowlistForNonHaiNeiClients !== 'boolean'
        ) {
            return json({ error: 'require_allowlist_for_non_hainei_clients_must_be_boolean' }, 400);
        }
        await setBlossomSettings(env, {
            enabled: body.enabled,
            allowHaiNeiClientsWithoutAllowlist: body.allowHaiNeiClientsWithoutAllowlist,
            requireAllowlistForNonHaiNeiClients: body.requireAllowlistForNonHaiNeiClients,
        });
        return json(await getBlossomSettings(env, request));
    } catch (error) {
        if (error instanceof SyntaxError) return json({ error: 'invalid_json' }, 400);
        throw error;
    }
}

export function onRequest() {
    return json({ error: 'method_not_allowed' }, 405);
}
