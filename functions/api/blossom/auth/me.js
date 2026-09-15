import { isBlossomEnabled } from '../../../blossom/auth.js';
import { isPubkeyAllowed } from '../../../blossom/allowlist.js';
import { destroySession, validateSession } from '../../../utils/auth/sessionManager.js';
import { authenticatedIdentity, json } from './responses.js';

export function createMeHandler(dependencies = {}) {
    const deps = { isPubkeyAllowed, validateSession, destroySession, ...dependencies };
    return async function handleMe({ env, request }) {
        if (!isBlossomEnabled(env)) return json({ authenticated: false }, 200);
        const result = await deps.validateSession(env, request, 'blossom');
        if (!result.valid || !result.session?.pubkey) return json({ authenticated: false });
        if (!await deps.isPubkeyAllowed(env, result.session.pubkey)) {
            const cookie = await deps.destroySession(env, request, 'blossom');
            return json({ authenticated: false }, 200, { 'Set-Cookie': cookie });
        }
        return json(authenticatedIdentity(result.session.pubkey));
    };
}

export const onRequestGet = createMeHandler();

export function onRequest() {
    return json({ error: 'method_not_allowed' }, 405);
}
