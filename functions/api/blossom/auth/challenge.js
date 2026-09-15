import { isBlossomEnabled } from '../../../blossom/auth.js';
import { createLoginChallenge } from '../../../blossom/webAuth.js';
import { json } from './responses.js';

export function createChallengeHandler(dependencies = {}) {
    const createChallenge = dependencies.createChallenge || createLoginChallenge;
    return async function handleChallenge({ env, request }) {
        if (!isBlossomEnabled(env)) return json({ error: 'blossom_disabled' }, 404);
        return json(await createChallenge(env, request));
    };
}

export const onRequestGet = createChallengeHandler();

export function onRequest() {
    return json({ error: 'method_not_allowed' }, 405);
}
