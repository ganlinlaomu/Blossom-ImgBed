import { validateBlossomAdmin } from './blossom/adminAuth.js';

const NO_STORE = 'private, no-store, max-age=0';

function redirectToAdminLogin(request) {
    const loginUrl = new URL('/adminLogin', request.url);
    loginUrl.searchParams.set('redirect', '/blossom-access.html');
    return Response.redirect(loginUrl.toString(), 302);
}

function withNoStore(response) {
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', NO_STORE);
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

/**
 * Protect the Blossom allowlist UI itself, not only its backing API.
 * Workers serve the asset through ASSETS; Pages Functions continue to the
 * static asset handler with context.next().
 */
export async function onRequest(context) {
    if (context.request.method !== 'GET' && context.request.method !== 'HEAD') {
        return new Response('Method Not Allowed', {
            status: 405,
            headers: { Allow: 'GET, HEAD', 'Cache-Control': NO_STORE },
        });
    }

    const result = await validateBlossomAdmin(context.env, context.request);

    if (!result.authorized) {
        return redirectToAdminLogin(context.request);
    }

    const response = context.env.ASSETS
        ? await context.env.ASSETS.fetch(context.request)
        : await context.next();
    return withNoStore(response);
}
