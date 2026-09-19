import { createHaiNeiChallenge } from '../../blossom/hainei-access.js';
import { BlossomError } from '../../blossom/errors.js';

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

export async function onRequestPost({ env }) {
    try {
        return json(await createHaiNeiChallenge(env));
    } catch (error) {
        if (error instanceof BlossomError) return json({ error: error.message }, error.status);
        throw error;
    }
}

export function onRequestOptions() {
    return new Response(null, { status: 204, headers: JSON_HEADERS });
}

export function onRequest() {
    return json({ error: 'method_not_allowed' }, 405);
}
