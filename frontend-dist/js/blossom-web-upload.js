import { sha256File, signUploadAuthorization, uploadBlossomBlob } from './nostr/blossom-auth.js';
import { loginWithNip07 } from './nostr/web-login.js';

const loggedOut = document.querySelector('#logged-out');
const loggedIn = document.querySelector('#logged-in');
const message = document.querySelector('#message');
const loginButton = document.querySelector('#login');
const warning = document.querySelector('#signer-warning');
const fileInput = document.querySelector('#file');
const fileName = document.querySelector('#file-name');
const form = document.querySelector('#upload-form');

function setMessage(text, type = '') {
  message.textContent = text;
  message.className = `message ${type}`;
}

function showIdentity(identity) {
  loggedOut.hidden = identity.authenticated;
  loggedIn.hidden = !identity.authenticated;
  if (!identity.authenticated) return;
  document.querySelector('#npub').textContent = identity.npub;
  document.querySelector('#npub').title = identity.npub;
  document.querySelector('#hex').textContent = `${identity.pubkey.slice(0, 12)}…${identity.pubkey.slice(-8)}`;
}

async function getIdentity() {
  const response = await fetch('/api/blossom/auth/me', { credentials: 'include' });
  if (!response.ok) return { authenticated: false };
  return response.json();
}

loginButton.addEventListener('click', async () => {
  if (!window.nostr) { warning.hidden = false; return; }
  loginButton.disabled = true;
  setMessage('Waiting for your signer…');
  try {
    const identity = await loginWithNip07(window.nostr);
    showIdentity(identity);
    setMessage('Signed in successfully.', 'success');
  } catch (error) {
    setMessage(error.message, 'error');
  } finally {
    loginButton.disabled = false;
  }
});

document.querySelector('#logout').addEventListener('click', async () => {
  await fetch('/api/blossom/auth/logout', { method: 'POST', credentials: 'include' });
  showIdentity({ authenticated: false });
  setMessage('Signed out.', 'success');
});

fileInput.addEventListener('change', () => {
  fileName.textContent = fileInput.files[0]?.name || 'No file selected';
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file) return;
  const uploadButton = document.querySelector('#upload');
  const resultBox = document.querySelector('#result');
  uploadButton.disabled = true;
  resultBox.hidden = true;
  try {
    const identity = await getIdentity();
    if (!identity.authenticated) {
      showIdentity(identity);
      throw new Error('Your session is no longer valid. Please log in again.');
    }
    setMessage('Hashing file…');
    const sha256 = await sha256File(file);
    setMessage('Waiting for BUD-11 upload authorization…');
    const event = await signUploadAuthorization(window.nostr, { sha256 });
    if (event.pubkey !== identity.pubkey) throw new Error('The active signer does not match this session');
    setMessage('Uploading through Blossom…');
    const response = await uploadBlossomBlob({ file, event, sha256 });
    const contentType = response.headers.get('Content-Type') || '';
    const body = contentType.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) throw new Error(typeof body === 'string' ? body : body.message || body.error || 'Upload failed');
    resultBox.replaceChildren();
    const link = document.createElement('a');
    link.href = body.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = body.url;
    resultBox.append('Uploaded: ', link);
    resultBox.hidden = false;
    setMessage(`Upload complete · ${body.sha256}`, 'success');
  } catch (error) {
    setMessage(error.message, 'error');
  } finally {
    uploadButton.disabled = false;
  }
});

warning.hidden = !!window.nostr;
showIdentity(await getIdentity());
