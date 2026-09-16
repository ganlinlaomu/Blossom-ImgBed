import { BlossomError, blossomHeaders, errorResponse } from './errors.js';
import { assertSha256 } from './hash.js';
import { getBlob } from './metadata.js';
import { readViaImgBed } from './imgbed.js';

function applyBlobHeaders(response, blob, request) {
    const headers = blossomHeaders(response.headers);
    headers.set('Content-Type', blob.type || 'application/octet-stream');
    headers.set('ETag', `"${blob.sha256}"`);
    headers.set('Accept-Ranges', 'bytes');
    if (request.method === 'HEAD' || (request.method === 'GET' && response.status === 200)) {
        headers.set('Content-Length', String(blob.size));
    }
    return new Response(request.method === 'HEAD' ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

export function createBlobHandler(dependencies = {}) {
    const deps = { getBlob, readViaImgBed, ...dependencies };
    return async function handleBlob(context, sha256) {
        try {
            assertSha256(sha256);
            const blob = await deps.getBlob(context.env, sha256);
            if (!blob) throw new BlossomError(404, 'Blob not found');

            const ifNoneMatch = context.request.headers.get('If-None-Match');
            if (ifNoneMatch === `"${sha256}"` || ifNoneMatch === sha256) {
                return new Response(null, { status: 304, headers: blossomHeaders({ ETag: `"${sha256}"` }) });
            }
            const response = await deps.readViaImgBed(context, blob);
            if (!response.ok && response.status !== 206 && response.status !== 304) {
                return new Response(response.body, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: blossomHeaders(response.headers),
                });
            }
            return applyBlobHeaders(response, blob, context.request);
        } catch (error) {
            return errorResponse(error);
        }
    };
}

export const handleBlossomBlob = createBlobHandler();
