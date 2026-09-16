import { fetchSecurityConfig } from '../utils/sysConfig.js';
import { validateSession } from '../utils/auth/sessionManager.js';

/**
 * Blossom allowlist management is deliberately stricter than the legacy
 * management fallback: an administrator must be configured and must have a
 * valid admin session. API tokens and an unconfigured/open admin console are
 * not sufficient for changing the Blossom write allowlist.
 */
export async function validateBlossomAdmin(env, request) {
    const securityConfig = await fetchSecurityConfig(env, { throwOnError: true });
    const username = securityConfig.auth.admin.adminUsername;
    const password = securityConfig.auth.admin.adminPassword;
    const configured = !!(username && username.trim()) || !!(password && password.trim());

    if (!configured) {
        return { authorized: false, reason: 'admin_not_configured' };
    }

    const session = await validateSession(env, request, 'admin');
    return session.valid
        ? { authorized: true, session: session.session }
        : { authorized: false, reason: 'admin_login_required' };
}
