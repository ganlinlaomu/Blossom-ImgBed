import { fetchSecurityConfig, fetchUploadConfig } from '../utils/sysConfig.js';
import { getDatabase } from '../utils/databaseAdapter.js';
import { removeFileFromIndex } from '../utils/indexManager.js';
import { deleteFile } from '../api/manage/delete/[[path]].js';
import { onRequest as readFile } from '../file/[[path]].js';
import { getUploadIp, isBlockedUploadIp, resolveFileExt } from '../upload/uploadTools.js';
import { BlossomError } from './errors.js';

function safeExtension(fileName, type) {
    const extension = resolveFileExt(fileName, type).toLowerCase().replace(/[^a-z0-9]/g, '');
    return extension.slice(0, 16) || 'bin';
}

function cloneContext(context, overrides = {}) {
    return {
        ...context,
        data: context.data || {},
        waitUntil: context.waitUntil || (promise => promise),
        ...overrides,
    };
}

export async function getImgBedRecord(env, imgbedId) {
    return getDatabase(env).getWithMetadata(imgbedId);
}

export async function uploadViaImgBed(context, file, sha256, processFileUpload) {
    const uploadIp = getUploadIp(context.request);
    if (await isBlockedUploadIp(context.env, uploadIp)) {
        throw new BlossomError(403, 'Your IP is blocked by the ImgBed upload policy');
    }

    const type = file.type || 'application/octet-stream';
    const extension = safeExtension(file.name, type);
    const formdata = new FormData();
    formdata.set('file', file, `${sha256}.${extension}`);
    formdata.set('sha256', sha256);

    const url = new URL(context.request.url);
    url.searchParams.set('uploadNameType', 'origin');
    url.searchParams.set('uploadFolder', 'blossom');
    url.searchParams.set('autoRetry', 'true');

    const uploadContext = cloneContext(context, {
        url,
        formdata,
        specifiedChannelName: null,
        securityConfig: await fetchSecurityConfig(context.env),
    });
    uploadContext.uploadConfig = await fetchUploadConfig(context.env, uploadContext);

    const response = await processFileUpload(uploadContext, formdata);
    if (!response.ok) {
        throw new BlossomError(response.status >= 400 && response.status < 500 ? response.status : 502,
            `ImgBed upload pipeline failed: ${await response.text()}`);
    }

    let payload;
    try {
        payload = await response.json();
    } catch {
        throw new BlossomError(502, 'ImgBed upload pipeline returned an invalid response');
    }
    const src = payload?.[0]?.src;
    if (typeof src !== 'string' || !src.includes('/file/')) {
        throw new BlossomError(502, 'ImgBed upload pipeline did not return a file id');
    }
    return decodeURIComponent(src.slice(src.indexOf('/file/') + 6));
}

export async function readViaImgBed(context, blob) {
    const fileUrl = new URL(`/file/${blob.imgbedId.split('/').map(encodeURIComponent).join('/')}`, context.request.url);
    fileUrl.search = new URL(context.request.url).search;
    const request = new Request(fileUrl, context.request);
    return readFile(cloneContext(context, {
        request,
        params: { path: encodeURIComponent(blob.imgbedId) },
    }));
}

export async function deleteViaImgBed(context, blob) {
    const url = new URL(context.request.url);
    const cdnUrl = `${url.origin}/file/${blob.imgbedId.split('/').map(encodeURIComponent).join('/')}`;
    const deleted = await deleteFile(context.env, blob.imgbedId, cdnUrl, url);
    if (!deleted) return false;

    const indexPromise = removeFileFromIndex(context, blob.imgbedId);
    if (context.waitUntil) context.waitUntil(indexPromise);
    else await indexPromise;
    return true;
}
