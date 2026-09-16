import { authenticateBud11, isBlossomEnabled } from './auth.js';
import { BlossomError, errorResponse, blossomHeaders } from './errors.js';
import { assertSha256 } from './hash.js';
import {
    addOwnership, countOwnerships, deleteBlob, getBlob, hasOwnership, removeOwnership,
} from './metadata.js';
import { deleteViaImgBed } from './imgbed.js';
import { isPubkeyAllowed } from './allowlist.js';
import { jsonResponse } from './errors.js';

export function createDeleteHandler(dependencies = {}) {
    const deps = {
        authenticate: authenticateBud11,
        getBlob,
        hasOwnership,
        removeOwnership,
        countOwnerships,
        addOwnership,
        deleteBlob,
        deleteViaImgBed,
        isPubkeyAllowed,
        isEnabled: isBlossomEnabled,
        ...dependencies,
    };

    return async function handleDelete(context, sha256) {
        try {
            if (!await deps.isEnabled(context.env)) {
                return jsonResponse({ error: 'blossom_disabled' }, 403, { 'Cache-Control': 'no-store' });
            }
            assertSha256(sha256);
            const { pubkey } = deps.authenticate(context.request, context.env, {
                action: 'delete', sha256, requireHash: true,
            });
            if (!await deps.isPubkeyAllowed(context.env, pubkey)) {
                return jsonResponse({ error: 'pubkey_not_allowed' }, 403, { 'Cache-Control': 'no-store' });
            }
            const blob = await deps.getBlob(context.env, sha256);
            if (!blob) throw new BlossomError(404, 'Blob not found');
            if (!await deps.hasOwnership(context.env, sha256, pubkey)) {
                throw new BlossomError(403, 'The authenticated pubkey does not own this blob');
            }

            await deps.removeOwnership(context.env, sha256, pubkey);
            if (await deps.countOwnerships(context.env, sha256) > 0) {
                return new Response(null, { status: 204, headers: blossomHeaders() });
            }

            if (!await deps.deleteViaImgBed(context, blob)) {
                await deps.addOwnership(context.env, sha256, pubkey, Math.floor(Date.now() / 1000));
                throw new BlossomError(502, 'ImgBed delete pipeline failed');
            }
            await deps.deleteBlob(context.env, sha256);
            return new Response(null, { status: 204, headers: blossomHeaders() });
        } catch (error) {
            return errorResponse(error);
        }
    };
}

export const handleBlossomDelete = createDeleteHandler();
