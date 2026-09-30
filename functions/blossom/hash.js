import { BlossomError } from './errors.js';
import { SHA256_PATTERN } from './types.js';

export function assertSha256(value, message = 'Malformed SHA-256 hash') {
    if (!SHA256_PATTERN.test(value || '')) throw new BlossomError(400, message);
    return value;
}

export async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function readAndHashRequest(request, maxBytes = 25 * 1024 * 1024) {
    if (Number(request.headers.get('Content-Length')) > maxBytes) throw new BlossomError(413, 'file_too_large');
    const reader = request.body?.getReader();
    if (!reader) throw new BlossomError(400, 'empty_upload');
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) {
                await reader.cancel();
                throw new BlossomError(413, 'file_too_large');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return { buffer: bytes.buffer, sha256: await sha256Hex(bytes.buffer), size };
}
