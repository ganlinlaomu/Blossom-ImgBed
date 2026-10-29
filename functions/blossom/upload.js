import { acquireBlobLock, releaseBlobLock, releaseBlobLockStatement, acquireUploadSlot, releaseUploadSlot } from './blob-lock.js';
import { changed, d1Batch } from './d1.js';
import { authenticateBud11, isBlossomEnabled } from './auth.js';
import { BlossomError, blossomHeaders, errorResponse, jsonResponse } from './errors.js';
import { assertSha256, readAndHashRequest } from './hash.js';
import {
    addOwnership, addOwnershipStatement, deleteBlob, getBlob, getBlobStatement, putBlob, putBlobStatement, rowToBlob,
} from './metadata.js';
import { getImgBedRecord, uploadViaImgBed } from './imgbed.js';
import { isPubkeyAllowed } from './allowlist.js';
import { authenticateUploadToken, consumeBoundUploadToken, consumeBoundUploadTokenStatement } from './upload-token.js';
import {
    uploadQuotaPolicy, assertUploadQuota, releaseUploadQuota, reserveUploadQuota, reserveUploadQuotaStatement,
} from './upload-quota.js';

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
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'video/mp4': 'mp4',
        'audio/mpeg': 'mp3',
        'application/pdf': 'pdf',
        'text/plain': 'txt',
        'application/json': 'json',
        'application/octet-stream': 'bin',
    };
    return (
        known[type] ||
        type
            .split('/')[1]
            .replace(/[^a-z0-9]/g, '')
            .slice(0, 16) ||
        'bin'
    );
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
        authenticateUploadToken,
        consumeBoundUploadToken,
        isPubkeyAllowed,
        isEnabled: isBlossomEnabled,
        assertUploadQuota,
        ...dependencies,
    };

    return async function handleUploadPreflight(context) {
        try {
            if (!(await deps.isEnabled(context.env))) {
                return jsonResponse({ error: 'blossom_disabled' }, 403, {
                    'Cache-Control': 'no-store',
                });
            }

            const authorizedHash = assertSha256(
                context.request.headers.get('X-SHA-256'),
                'HEAD /upload requires a lowercase X-SHA-256 header',
            );
            const uploadTokenAuth = await deps.authenticateUploadToken(context.request, context.env);
            if (!uploadTokenAuth.authorized) {
                const { pubkey } = deps.authenticate(context.request, context.env, {
                    action: 'upload',
                    sha256: authorizedHash,
                    requireHash: true,
                });
                if (!(await deps.isPubkeyAllowed(context.env, pubkey))) {
                    return jsonResponse({ error: 'pubkey_not_allowed' }, 403, {
                        'Cache-Control': 'no-store',
                    });
                }
            }

            const contentLength = parseLength(context.request.headers.get('X-Content-Length'), 'X-Content-Length', {
                required: true,
            });
            if (uploadTokenAuth.authorized) {
                if (
                    uploadTokenAuth.contentHash &&
                    (authorizedHash !== uploadTokenAuth.contentHash || contentLength > uploadTokenAuth.maxBytes)
                )
                    throw new BlossomError(409, 'upload_binding_mismatch');
                await deps.assertUploadQuota(context.env, uploadTokenAuth.pubkey, contentLength);
            }
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

// D1 sits in one region, so every statement is a long round trip for most
// users. With batch support, consume the token, charge the quota and look up
// the blob in one trip, and record the blob, its owner and the lock release
// in another. Without it (test doubles) the step-by-step dependencies run.
function canBatch(env) {
    return typeof env?.img_d1?.batch === 'function';
}

async function admitBatched(env, tokenAuth, pubkey, body) {
    const statements = [];
    let tokenStatement = null;
    let quota = null;
    if (tokenAuth.authorized) {
        tokenStatement = await consumeBoundUploadTokenStatement(env, tokenAuth, body.sha256, body.size);
        quota = reserveUploadQuotaStatement(env, pubkey, body.size);
        if (tokenStatement) statements.push(tokenStatement);
        statements.push(quota.statement);
    }
    statements.push(getBlobStatement(env, body.sha256));
    const results = await d1Batch(env.img_d1, statements);
    const blob = rowToBlob(results.at(-1)?.results?.[0]);
    if (!quota) return { blob, usageDate: null };
    const tokenConsumed = !tokenStatement || changed(results[0]);
    const quotaCharged = changed(results[tokenStatement ? 1 : 0]);
    if (!tokenConsumed) {
        if (quotaCharged) await releaseUploadQuota(env, pubkey, body.size, quota.reservedDate);
        throw new BlossomError(401, 'upload_token_already_used');
    }
    if (!quotaCharged) throw new BlossomError(429, 'daily_upload_quota_exceeded');
    return { blob, usageDate: quota.reservedDate };
}

export function createUploadHandler(dependencies = {}) {
    const deps = {
        acquireUploadSlot,
        releaseUploadSlot,
        acquireBlobLock,
        releaseBlobLock,
        authenticate: authenticateBud11,
        authenticateUploadToken,
        consumeBoundUploadToken,
        readAndHash: readAndHashRequest,
        getBlob,
        putBlob,
        deleteBlob,
        addOwnership,
        getImgBedRecord,
        uploadViaImgBed,
        isPubkeyAllowed,
        isEnabled: isBlossomEnabled,
        assertUploadQuota,
        reserveUploadQuota,
        releaseUploadQuota,
        ...dependencies,
    };

    return async function handleUpload(context, processFileUpload) {
        let quotaReservation = null;
        let blobLock = null;
        let uploadSlot = null;
        try {
            if (!(await deps.isEnabled(context.env))) {
                return jsonResponse({ error: 'blossom_disabled' }, 403, {
                    'Cache-Control': 'no-store',
                });
            }

            const hashHeader = context.request.headers.get('X-SHA-256');
            const authorizedHash =
                hashHeader === null
                    ? null
                    : assertSha256(hashHeader, 'PUT /upload X-SHA-256 header must be a lowercase SHA-256 hash');
            const uploadTokenAuth = await deps.authenticateUploadToken(context.request, context.env);
            let pubkey;
            let event = null;
            if (uploadTokenAuth.authorized) {
                pubkey = uploadTokenAuth.pubkey;
            } else {
                ({ event, pubkey } = deps.authenticate(context.request, context.env, {
                    action: 'upload',
                    ...(authorizedHash ? { sha256: authorizedHash, requireHash: true } : { requireHash: false }),
                }));
                if (!(await deps.isPubkeyAllowed(context.env, pubkey))) {
                    return jsonResponse({ error: 'pubkey_not_allowed' }, 403, {
                        'Cache-Control': 'no-store',
                    });
                }
            }

            const declaredLength = parseLength(context.request.headers.get('Content-Length'), 'Content-Length');

            const type = normalizeMimeType(context.request.headers.get('Content-Type'));
            const maximum = uploadTokenAuth.maxBytes || uploadQuotaPolicy(context.env).maxFileSize;
            uploadSlot = await deps.acquireUploadSlot(context.env, Math.min(declaredLength ?? maximum, maximum));
            const body = await deps.readAndHash(context.request, maximum);
            if (authorizedHash && body.sha256 !== authorizedHash) {
                throw new BlossomError(409, 'X-SHA-256 and BUD-11 hash do not match the uploaded blob');
            }
            if (!authorizedHash && !uploadTokenAuth.authorized) {
                const signedHashes = event.tags.filter((tag) => tag[0] === 'x').map((tag) => tag[1]);
                if (!signedHashes.includes(body.sha256)) {
                    throw new BlossomError(401, 'Nostr authorization does not cover the uploaded blob hash');
                }
            }
            if (declaredLength !== null && declaredLength !== body.size) {
                throw new BlossomError(400, 'Content-Length does not match the uploaded blob');
            }
            blobLock = await deps.acquireBlobLock(context.env, body.sha256, 'upload');
            const batched = canBatch(context.env);
            let blob;
            if (batched) {
                const admitted = await admitBatched(context.env, uploadTokenAuth, pubkey, body);
                blob = admitted.blob;
                if (admitted.usageDate) quotaReservation = { pubkey, size: body.size, usageDate: admitted.usageDate };
            } else {
                if (uploadTokenAuth.authorized) {
                    await deps.consumeBoundUploadToken(context.env, uploadTokenAuth, body.sha256, body.size);
                    const usageDate = await deps.reserveUploadQuota(context.env, pubkey, body.size);
                    quotaReservation = { pubkey, size: body.size, usageDate };
                }
                blob = await deps.getBlob(context.env, body.sha256);
            }
            if (blob && (await deps.getImgBedRecord(context.env, blob.imgbedId))) {
                const now = Math.floor(Date.now() / 1000);
                if (batched) {
                    await d1Batch(context.env.img_d1, [
                        addOwnershipStatement(context.env, blob.sha256, pubkey, now),
                        releaseBlobLockStatement(context.env, blobLock),
                    ]);
                    blobLock = null;
                } else {
                    await deps.addOwnership(context.env, blob.sha256, pubkey, now);
                }
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
            if (batched) {
                await d1Batch(context.env.img_d1, [
                    putBlobStatement(context.env, blob),
                    addOwnershipStatement(context.env, blob.sha256, pubkey, blob.uploaded),
                    releaseBlobLockStatement(context.env, blobLock),
                ]);
                blobLock = null;
            } else {
                await deps.putBlob(context.env, blob);
                await deps.addOwnership(context.env, blob.sha256, pubkey, blob.uploaded);
            }
            return jsonResponse(blobDescriptor(context.request, blob), 201);
        } catch (error) {
            if (quotaReservation) {
                try {
                    await deps.releaseUploadQuota(
                        context.env,
                        quotaReservation.pubkey,
                        quotaReservation.size,
                        quotaReservation.usageDate,
                    );
                } catch (releaseError) {
                    console.error('Failed to release reserved HaiNei upload quota', releaseError);
                }
            }
            return errorResponse(error);
        } finally {
            if (uploadSlot) {
                try { await deps.releaseUploadSlot(context.env, uploadSlot); }
                catch (error) { console.error('Failed to release Blossom upload slot:', error); }
            }
            if (blobLock) {
                try { await deps.releaseBlobLock(context.env, blobLock); }
                catch (error) { console.error('Failed to release Blossom operation lock:', error); }
            }
        }
    };
}

export const handleBlossomUpload = createUploadHandler();
export const handleBlossomUploadPreflight = createUploadPreflightHandler();
