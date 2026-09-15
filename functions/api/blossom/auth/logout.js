import { destroySession } from '../../../utils/auth/sessionManager.js';
import { json } from './responses.js';

export function createLogoutHandler(dependencies = {}) {
    const destroy = dependencies.destroySession || destroySession;
    return async function handleLogout({ env, request }) {
        const cookie = await destroy(env, request, 'blossom');
        return json({ authenticated: false }, 200, { 'Set-Cookie': cookie });
    };
}

export const onRequestPost = createLogoutHandler();

export function onRequest() {
    return json({ error: 'method_not_allowed' }, 405);
}
