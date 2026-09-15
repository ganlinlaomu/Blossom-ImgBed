export function createLoginEvent({ challenge, expiresAt, location = window.location, nowSeconds } = {}) {
  if (!/^[0-9a-f]{64}$/.test(challenge || '')) throw new Error('The server returned a malformed login challenge');
  if (!Number.isSafeInteger(expiresAt)) throw new Error('The server returned a malformed challenge expiration');
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  return {
    kind: 27235,
    created_at: now,
    content: 'Authenticate with Blossom ImgBed',
    tags: [
      ['challenge', challenge],
      ['domain', location.hostname.toLowerCase()],
      ['expiration', String(expiresAt)],
      ['u', new URL('/api/blossom/auth/login', location.origin).toString()],
      ['method', 'POST'],
    ],
  };
}

export async function loginWithNip07(signer = window.nostr) {
  if (!signer?.getPublicKey || !signer?.signEvent) {
    throw new Error('No NIP-07 compatible signer detected.');
  }
  const pubkey = await signer.getPublicKey();
  const challengeResponse = await fetch('/api/blossom/auth/challenge', { credentials: 'include' });
  const challenge = await challengeResponse.json();
  if (!challengeResponse.ok) throw new Error(challenge.message || challenge.error || 'Unable to get login challenge');
  const event = await signer.signEvent(createLoginEvent(challenge));
  if (event.pubkey !== pubkey) throw new Error('The signer returned a different public key');

  const response = await fetch('/api/blossom/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event }),
  });
  const identity = await response.json();
  if (!response.ok) throw new Error(identity.message || identity.error || 'Nostr login failed');
  return identity;
}
