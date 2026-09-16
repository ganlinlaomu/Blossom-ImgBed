import { handleBlossomBlob } from './blossom/blob.js';
import { handleBlossomDelete } from './blossom/delete.js';
import { optionsResponse } from './blossom/errors.js';

function parseHashParam(context) {
    const raw = String(context.params?.sha256 || '');
    const match = /^([0-9a-f]{64})(?:\.[A-Za-z0-9]{1,16})?$/.exec(raw);
    return match?.[1] || null;
}

async function passThrough(context) {
    if (context.env?.ASSETS) return context.env.ASSETS.fetch(context.request);
    return context.next();
}

export async function onRequest(context) {
    const hash = parseHashParam(context);
    if (!hash) return passThrough(context);

    switch (context.request.method) {
        case 'GET':
        case 'HEAD':
            return handleBlossomBlob(context, hash);
        case 'DELETE':
            return handleBlossomDelete(context, hash);
        case 'OPTIONS':
            return optionsResponse();
        default:
            return new Response('Method Not Allowed', { status: 405 });
    }
}
