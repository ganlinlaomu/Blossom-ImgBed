import { authenticateBud11, isBlossomEnabled } from './auth.js';
import { BlossomError, blossomHeaders, errorResponse, jsonResponse } from './errors.js';
import { assertSha256, readAndHashRequest } from './hash.js';
import { addOwnership, deleteBlob, getBlob, putBlob } from './metadata.js';
import { getImgBedRecord, uploadViaImgBed } from './imgbed.js';
import { isPubkeyAllowed } from './allowlist.js';
import { authenticateHaiNeiUploadToken } from './hainei-access.js';

const MIME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;.*)?$/;

function normalizeMimeType(value) {
    if (!value) return 'application/octet-stream';
    if (value.length > 255 || /[\r\n\0]/.test(value) || !MIME_PATTERN.test(value)) {
        throw new BlossomError(415, 'Invalid Content-Type');
    }
    return value.split(';', 1)[0].trim().toLowerCase();
}

function extensionForType(type) {
    const known = {
        'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
        'video/mp4': 'mp4', 'audio/mpeg': 'mp3', 'application/pdf': 'pdf',
        'text/plain': 'txt', 'application/json': 'json', 'application/octet-stream': 'bin',
    };
    return known[type] || type.split('/')[1].replace(/[^a-z0-9]/g, '').slice(0, 16) || 'bin';
}

function parseLength(value, headerName, { required = false } = {}) {
    if (value === null || value === '') {
        if (required) throw new BlossomError(411, `${headerName} header is required`);
        return null;
    }
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new BlossomError(400, `Invalid ${headerName} header`);
    }
    return Number(value);
}

export function createUploadPreflightHandler(dependencies = {}) {
    const deps = {
        authenticate: authenticateBud11,
        isPubkeyAllowed,
        isEnabled: isBlossomEnabled,
        ...dependencies,
    };

    return async function handleUploadPreflight(context) {
        try {
            if (!await deps.isEnabled(context.env)) {
                return jsonResponse({ error: 'blossom_disabled' }, 403, { 'Cache-Control': 'no-store' });
            }

            const authorizedHash = assertSha256(
                context.request.headers.get('X-SHA-256'),
                'HEAD /upload requires a lowercase X-SHA-256 header'
            );
            const { pubkey } = deps.authenticate(context.request, context.env, {
                action: 'upload', sha256: authorizedHash, requireHash: true,
            });
            if (!await deps.isPubkeyAllowed(context.env, pubkey)) {
                return jsonResponse({ error: 'pubkey_not_allowed' }, 403, { 'Cache-Control': 'no-store' });
            }

            parseLength(context.request.headers.get('X-Content-Length'), 'X-Content-Length', { required: true });
            normalizeMimeType(context.request.headers.get('X-Content-Type'));

            return new Response(null, {
                status: 200,
                headers: blossomHeaders({ 'Cache-Control': 'no-store' }),
            });
        } catch (error) {
            return errorResponse(error);
        }
    };
}

export function blobDescriptor(request, blob) {
    const extension = extensionForType(blob.type);
    return {
        url: new URL(`/${blob.sha256}.${extension}`, request.url).toString(),
        sha256: blob.sha256,
        size: blob.size,
        type: blob.type,
        uploaded: blob.uploaded,
    };
}

export function createUploadHandler(dependencies = {}) {
    const deps = {
        authenticate: authenticateBud11,
        authenticateHaiNeiUpload: authenticateHaiNeiUploadToken,
        readAndHash: readAndHashRequest,
        getBlob,
        putBlob,
        deleteBlob,
        addOwnership,
        getImgBedRecord,
        uploadViaImgBed,
        isPubkeyAllowed,
        isEnabled: isBlossomEnabled,
        ...dependencies,
    };

    return async function handleUpload(context, processFileUpload) {
        try {
            if (!await deps.isEnabled(context.env)) {
                return jsonResponse({ error: 'blossom_disabled' }, 403, { 'Cache-Control': 'no-store' });
            }

            const hashHeader = context.request.headers.get('X-SHA-256');
            const authorizedHash = hashHeader === null ? null : assertSha256(
                hashHeader,
                'PUT /upload X-SHA-256 header must be a lowercase SHA-256 hash'
            );
            const haiNeiAuth = await deps.authenticateHaiNeiUpload(context.request, context.env);
            let pubkey;
            let event = null;
            if (haiNeiAuth.authorized) {
                pubkey = haiNeiAuth.pubkey;
            } else {
                ({ event, pubkey } = deps.authenticate(context.request, context.env, {
                    action: 'upload',
                    ...(authorizedHash ? { sha256: authorizedHash, requireHash: true } : { requireHash: false }),
                }));
                if (!await deps.isPubkeyAllowed(context.env, pubkey)) {
                    return jsonResponse({ error: 'pubkey_not_allowed' }, 403, { 'Cache-Control': 'no-store' });
                }
            }

            const declaredLength = parseLength(context.request.headers.get('Content-Length'), 'Content-Length');

            const type = normalizeMimeType(context.request.headers.get('Content-Type'));
            const body = await deps.readAndHash(context.request);
            if (authorizedHash && body.sha256 !== authorizedHash) {
                throw new BlossomError(409, 'X-SHA-256 and BUD-11 hash do not match the uploaded blob');
            }
            if (!authorizedHash && !haiNeiAuth.authorized) {
                const signedHashes = event.tags
                    .filter(tag => tag[0] === 'x')
                    .map(tag => tag[1]);
                if (!signedHashes.includes(body.sha256)) {
                    throw new BlossomError(401, 'Nostr authorization does not cover the uploaded blob hash');
                }
            }
            if (declaredLength !== null && declaredLength !== body.size) {
                throw new BlossomError(400, 'Content-Length does not match the uploaded blob');
            }

            let blob = await deps.getBlob(context.env, body.sha256);
            if (blob && await deps.getImgBedRecord(context.env, blob.imgbedId)) {
                await deps.addOwnership(context.env, blob.sha256, pubkey, Math.floor(Date.now() / 1000));
                return jsonResponse(blobDescriptor(context.request, blob), 200);
            }
            if (blob) await deps.deleteBlob(context.env, blob.sha256);

            const file = new File([body.buffer], `${body.sha256}.${extensionForType(type)}`, { type });
            const imgbedId = await deps.uploadViaImgBed(context, file, body.sha256, processFileUpload);
            blob = {
                sha256: body.sha256,
                imgbedId,
                size: body.size,
                type,
                uploaded: Math.floor(Date.now() / 1000),
            };
            await deps.putBlob(context.env, blob);
            await deps.addOwnership(context.env, blob.sha256, pubkey, blob.uploaded);
            return jsonResponse(blobDescriptor(context.request, blob), 201);
        } catch (error) {
            return errorResponse(error);
        }
    };
}

export const handleBlossomUpload = createUploadHandler();
export const handleBlossomUploadPreflight = createUploadPreflightHandler();
