import { fetchSecurityConfig } from "../../utils/sysConfig.js";
import { verifyPassword, rehashIfNeeded } from "../../utils/auth/passwordHash.js";
import { createSession } from "../../utils/auth/sessionManager.js";
import { checkDatabaseInitialization, getDatabase } from "../../utils/databaseAdapter.js";

const JSON_HEADERS = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
};

function json(value, status) {
    return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

export async function onRequestPost(context) {
    const { request, env } = context;

    const { username, password } = await request.json();

    const database = await checkDatabaseInitialization(env);
    if (!database.configured) {
        return json({
            error: 'database_not_configured',
            message: 'D1 database is not configured. Bind a D1 database to "img_d1".',
        }, 503);
    }
    if (!database.initialized) {
        return json({
            error: 'database_not_initialized',
            message: 'D1 database is empty or incomplete. Run database/init.sql.',
            missingTables: database.missingTables,
        }, 503);
    }

    // 读取安全设置
    let securityConfig;
    try {
        securityConfig = await fetchSecurityConfig(env, { throwOnError: true });
    } catch (error) {
        console.error('Admin login blocked because security config could not be loaded:', error);
        return json({
            error: 'database_unavailable',
            message: 'Database configuration could not be read.',
        }, 503);
    }
    const adminUsername = securityConfig.auth.admin.adminUsername;
    const adminPassword = securityConfig.auth.admin.adminPassword;

    const usernameConfigured = !!(adminUsername && adminUsername.trim());
    const passwordConfigured = !!(adminPassword && adminPassword.trim());
    const adminConfigured = usernameConfigured || passwordConfigured;

    // 管理员未配置，无需认证，直接创建会话
    if (!adminConfigured) {
        const { cookie } = await createSession(env, 'admin');
        return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Set-Cookie': cookie,
            },
        });
    }

    // 如果设置了用户名，则验证用户名
    if (usernameConfigured && username !== adminUsername) {
        return json({ error: 'unauthorized' }, 401);
    }

    // 如果设置了密码，则验证密码
    if (passwordConfigured) {
        const passwordMatch = await verifyPassword(password, adminPassword);
        if (!passwordMatch) {
            return json({ error: 'unauthorized' }, 401);
        }

        // 登录成功后，自动升级旧版哈希为 PBKDF2
        await rehashIfNeeded(getDatabase(env), password, adminPassword, 'auth.admin.adminPassword');
    }

    // 创建会话并通过 HttpOnly Cookie 返回
    const { cookie } = await createSession(env, 'admin');

    return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': cookie,
        },
    });
}
