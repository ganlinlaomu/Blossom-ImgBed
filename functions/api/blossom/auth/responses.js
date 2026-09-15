import { nip19 } from 'nostr-tools';
import { BlossomError } from '../../../blossom/errors.js';

export const JSON_HEADERS = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
};

export function json(value, status = 200, headers = {}) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { ...JSON_HEADERS, ...headers },
    });
}

export function authError(error) {
    if (error instanceof BlossomError) return json({ error: 'invalid_login', message: error.message }, error.status);
    console.error('Blossom web authentication failed:', error);
    return json({ error: 'internal_error' }, 500);
}

export function authenticatedIdentity(pubkey) {
    return { authenticated: true, pubkey, npub: nip19.npubEncode(pubkey) };
}
