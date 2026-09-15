import { isBlossomEnabled } from '../../../blossom/auth.js';
import { isPubkeyAllowed } from '../../../blossom/allowlist.js';
import { verifyAndConsumeLoginEvent } from '../../../blossom/webAuth.js';
import { createSession } from '../../../utils/auth/sessionManager.js';
import { authenticatedIdentity, authError, json } from './responses.js';

export function createLoginHandler(dependencies = {}) {
    const deps = {
        verifyLogin: verifyAndConsumeLoginEvent,
        isPubkeyAllowed,
        createSession,
        ...dependencies,
    };

    return async function handleLogin({ env, request }) {
        if (!isBlossomEnabled(env)) return json({ error: 'blossom_disabled' }, 404);
        try {
            const contentLength = Number(request.headers.get('Content-Length') || 0);
            if (contentLength > 16384) return json({ error: 'request_too_large' }, 413);
            const body = await request.json();
            const { pubkey } = await deps.verifyLogin(env, request, body?.event);
            if (!await deps.isPubkeyAllowed(env, pubkey)) {
                return json({ error: 'pubkey_not_allowed' }, 403);
            }
            const session = await deps.createSession(env, 'blossom', pubkey);
            return json(authenticatedIdentity(pubkey), 200, { 'Set-Cookie': session.cookie });
        } catch (error) {
            if (error instanceof SyntaxError) return json({ error: 'invalid_json' }, 400);
            return authError(error);
        }
    };
}

export const onRequestPost = createLoginHandler();

export function onRequest() {
    return json({ error: 'method_not_allowed' }, 405);
}
