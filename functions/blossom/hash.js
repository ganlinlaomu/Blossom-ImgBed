import { BlossomError } from './errors.js';
import { SHA256_PATTERN } from './types.js';

export function assertSha256(value, message = 'Malformed SHA-256 hash') {
    if (!SHA256_PATTERN.test(value || '')) throw new BlossomError(400, message);
    return value;
}

export async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function readAndHashRequest(request) {
    const buffer = await request.arrayBuffer();
    return { buffer, sha256: await sha256Hex(buffer), size: buffer.byteLength };
}
