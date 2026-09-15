const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function createUploadAuthorization({ sha256, hostname = window.location.hostname, nowSeconds } = {}) {
  if (!SHA256_PATTERN.test(sha256 || '')) throw new Error('A lowercase SHA-256 hash is required');
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  return {
    kind: 24242,
    created_at: now,
    content: 'Authorize Blossom blob upload',
    tags: [
      ['t', 'upload'],
      ['expiration', String(now + 300)],
      ['x', sha256],
      ['server', hostname.toLowerCase()],
    ],
  };
}

export async function signUploadAuthorization(signer, options) {
  if (!signer?.signEvent) throw new Error('No NIP-07 compatible signer detected.');
  return signer.signEvent(createUploadAuthorization(options));
}

export function buildAuthorizationHeader(event) {
  const bytes = new TextEncoder().encode(JSON.stringify(event));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Nostr ${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

export async function sha256File(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function uploadBlossomBlob({ file, event, sha256, fetchImpl = fetch }) {
  return fetchImpl('/upload', {
    method: 'PUT',
    credentials: 'include',
    headers: {
      Authorization: buildAuthorizationHeader(event),
      'X-SHA-256': sha256,
      'Content-Type': file.type || 'application/octet-stream',
    },
    body: file,
  });
}
