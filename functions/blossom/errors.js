const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Content-Length, X-SHA-256, X-Content-Type, X-Content-Length, Range, If-None-Match',
    'Access-Control-Allow-Methods': 'GET, HEAD, PUT, DELETE, OPTIONS',
    'Access-Control-Expose-Headers': 'X-Reason',
    'Access-Control-Max-Age': '86400',
};

export class BlossomError extends Error {
    constructor(status, message) {
        super(message);
        this.name = 'BlossomError';
        this.status = status;
    }
}

export function blossomHeaders(headers = {}) {
    const result = new Headers(CORS_HEADERS);
    const supplied = new Headers(headers);
    for (const [name, value] of supplied) result.set(name, value);
    return result;
}

export function errorResponse(error) {
    const status = error instanceof BlossomError ? error.status : 500;
    const reason = error instanceof Error ? error.message : 'Internal Server Error';

    if (!(error instanceof BlossomError)) {
        console.error('Blossom request failed:', error);
    }

    return new Response(reason, {
        status,
        headers: blossomHeaders({
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Reason': reason,
        }),
    });
}

export function jsonResponse(value, status = 200, headers = {}) {
    return new Response(JSON.stringify(value), {
        status,
        headers: blossomHeaders({
            'Content-Type': 'application/json',
            ...headers,
        }),
    });
}

export function optionsResponse() {
    return new Response(null, { status: 204, headers: blossomHeaders() });
}
