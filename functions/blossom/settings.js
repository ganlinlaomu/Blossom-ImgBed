import { getDatabase } from '../utils/databaseAdapter.js';

export const BLOSSOM_ENABLED_KEY = 'blossom_enabled';
const DEFAULT_BLOSSOM_SETTINGS = {
    enabled: false,
};

function parseBooleanSetting(value, fallback) {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return fallback;
}

export async function getBlossomSettings(env, request) {
    const database = getDatabase(env);
    const enabled = await database.getSetting(BLOSSOM_ENABLED_KEY);
    return {
        enabled: parseBooleanSetting(enabled, DEFAULT_BLOSSOM_SETTINGS.enabled),
        serverUrl: request ? new URL(request.url).origin : null,
    };
}

export async function setBlossomEnabled(env, enabled) {
    await getDatabase(env).putSetting(BLOSSOM_ENABLED_KEY, enabled ? 'true' : 'false', 'blossom');
    return enabled;
}

export async function setBlossomSettings(env, settings) {
    const current = await getBlossomSettings(env);
    const next = {
        enabled: typeof settings?.enabled === 'boolean' ? settings.enabled : current.enabled,
    };
    const database = getDatabase(env);
    await database.putSetting(BLOSSOM_ENABLED_KEY, next.enabled ? 'true' : 'false', 'blossom');
    return next;
}
