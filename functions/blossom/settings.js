import { getDatabase } from '../utils/databaseAdapter.js';

export const BLOSSOM_ENABLED_KEY = 'blossom_enabled';
export const BLOSSOM_ALLOW_HAINEI_CLIENTS_WITHOUT_ALLOWLIST_KEY = 'blossom_allow_hainei_clients_without_allowlist';
export const BLOSSOM_REQUIRE_ALLOWLIST_FOR_NON_HAINEI_CLIENTS_KEY = 'blossom_require_allowlist_for_non_hainei_clients';

const DEFAULT_BLOSSOM_SETTINGS = {
    enabled: false,
    allowHaiNeiClientsWithoutAllowlist: true,
    requireAllowlistForNonHaiNeiClients: true,
};

function parseBooleanSetting(value, fallback) {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return fallback;
}

export async function getBlossomSettings(env, request) {
    const database = getDatabase(env);
    const [enabled, allowHaiNeiClientsWithoutAllowlist, requireAllowlistForNonHaiNeiClients] = await Promise.all([
        database.getSetting(BLOSSOM_ENABLED_KEY),
        database.getSetting(BLOSSOM_ALLOW_HAINEI_CLIENTS_WITHOUT_ALLOWLIST_KEY),
        database.getSetting(BLOSSOM_REQUIRE_ALLOWLIST_FOR_NON_HAINEI_CLIENTS_KEY),
    ]);
    return {
        enabled: parseBooleanSetting(enabled, DEFAULT_BLOSSOM_SETTINGS.enabled),
        allowHaiNeiClientsWithoutAllowlist: parseBooleanSetting(
            allowHaiNeiClientsWithoutAllowlist,
            DEFAULT_BLOSSOM_SETTINGS.allowHaiNeiClientsWithoutAllowlist,
        ),
        requireAllowlistForNonHaiNeiClients: parseBooleanSetting(
            requireAllowlistForNonHaiNeiClients,
            DEFAULT_BLOSSOM_SETTINGS.requireAllowlistForNonHaiNeiClients,
        ),
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
        allowHaiNeiClientsWithoutAllowlist: typeof settings?.allowHaiNeiClientsWithoutAllowlist === 'boolean'
            ? settings.allowHaiNeiClientsWithoutAllowlist
            : current.allowHaiNeiClientsWithoutAllowlist,
        requireAllowlistForNonHaiNeiClients: typeof settings?.requireAllowlistForNonHaiNeiClients === 'boolean'
            ? settings.requireAllowlistForNonHaiNeiClients
            : current.requireAllowlistForNonHaiNeiClients,
    };
    const database = getDatabase(env);
    await Promise.all([
        database.putSetting(BLOSSOM_ENABLED_KEY, next.enabled ? 'true' : 'false', 'blossom'),
        database.putSetting(
            BLOSSOM_ALLOW_HAINEI_CLIENTS_WITHOUT_ALLOWLIST_KEY,
            next.allowHaiNeiClientsWithoutAllowlist ? 'true' : 'false',
            'blossom',
        ),
        database.putSetting(
            BLOSSOM_REQUIRE_ALLOWLIST_FOR_NON_HAINEI_CLIENTS_KEY,
            next.requireAllowlistForNonHaiNeiClients ? 'true' : 'false',
            'blossom',
        ),
    ]);
    return next;
}
