import { getDatabase } from '../utils/databaseAdapter.js';

export const BLOSSOM_ENABLED_KEY = 'blossom_enabled';

export async function getBlossomSettings(env, request) {
    const stored = await getDatabase(env).getSetting(BLOSSOM_ENABLED_KEY);
    return {
        enabled: stored === 'true',
        serverUrl: request ? new URL(request.url).origin : null,
    };
}

export async function setBlossomEnabled(env, enabled) {
    await getDatabase(env).putSetting(BLOSSOM_ENABLED_KEY, enabled ? 'true' : 'false', 'blossom');
    return enabled;
}
