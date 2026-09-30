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

export async function readRequestBytes(request, maxBytes, { timeoutMs = 120000, idleTimeoutMs = 15000 } = {}) {
    if (Number(request.headers.get('Content-Length')) > maxBytes) throw new BlossomError(413, 'file_too_large');
    const reader = request.body?.getReader();
    if (!reader) throw new BlossomError(400, 'empty_upload');
    const chunks = [];
    let size = 0;
    const deadline = Date.now() + timeoutMs;
    try {
        while (true) {
            if (request.signal.aborted) throw new BlossomError(408, 'upload_aborted');
            let timer;
            let onAbort;
            const read = reader.read();
            const interrupted = new Promise((_, reject) => {
                timer = setTimeout(() => reject(new BlossomError(408, 'upload_read_timeout')),
                    Math.max(0, Math.min(idleTimeoutMs, deadline - Date.now())));
                onAbort = () => reject(new BlossomError(408, 'upload_aborted'));
                request.signal.addEventListener('abort', onAbort, { once: true });
                if (request.signal.aborted) onAbort();
            });
            let result;
            try { result = await Promise.race([read, interrupted]); }
            finally {
                clearTimeout(timer);
                request.signal.removeEventListener('abort', onAbort);
            }
            if (result.done) break;
            size += result.value.byteLength;
            if (size > maxBytes) throw new BlossomError(413, 'file_too_large');
            chunks.push(result.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
        }
        return bytes;
    } catch (error) {
        // A stalled producer must not delay the error response through cancel().
        void reader.cancel().catch(() => {});
        throw error;
    } finally {
        reader.releaseLock();
    }
}

export async function readAndHashRequest(request, maxBytes = 25 * 1024 * 1024, options) {
    const bytes = await readRequestBytes(request, maxBytes, options);
    return { buffer: bytes.buffer, sha256: await sha256Hex(bytes.buffer), size: bytes.byteLength };
}
