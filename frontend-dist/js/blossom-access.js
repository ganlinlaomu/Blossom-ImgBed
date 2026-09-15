const endpoint = '/api/manage/blossom/pubkeys';
const form = document.querySelector('#add-form');
const message = document.querySelector('#message');
const loading = document.querySelector('#loading');
const empty = document.querySelector('#empty');
const table = document.querySelector('#pubkeys');
const tbody = table.querySelector('tbody');

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'include', ...options });
  let body;
  try { body = await response.json(); } catch { body = {}; }
  if (response.status === 401) {
    window.location.assign('/adminLogin');
    throw new Error('Administrator login required');
  }
  if (!response.ok) throw new Error(body.message || body.error || `Request failed (${response.status})`);
  return body;
}

function setMessage(text, type = '') {
  message.textContent = text;
  message.className = `message ${type}`;
}

function render(entries) {
  tbody.replaceChildren();
  loading.hidden = true;
  empty.hidden = entries.length !== 0;
  table.hidden = entries.length === 0;
  for (const entry of entries) {
    const row = document.createElement('tr');
    const key = document.createElement('td');
    key.className = 'key';
    const npub = document.createElement('code');
    npub.textContent = entry.npub;
    npub.title = entry.npub;
    const hex = document.createElement('small');
    hex.textContent = `${entry.pubkey.slice(0, 12)}…${entry.pubkey.slice(-8)}`;
    key.append(npub, hex);

    const note = document.createElement('td');
    note.textContent = entry.note || '—';
    const added = document.createElement('td');
    added.textContent = new Date(entry.createdAt * 1000).toLocaleString();
    const action = document.createElement('td');
    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      if (!window.confirm('Remove this pubkey from Blossom write access? Existing blobs will remain.')) return;
      remove.disabled = true;
      try {
        await api(`${endpoint}/${encodeURIComponent(entry.pubkey)}`, { method: 'DELETE' });
        setMessage('Pubkey removed. Existing blobs were not deleted.', 'success');
        await load();
      } catch (error) {
        setMessage(error.message, 'error');
        remove.disabled = false;
      }
    });
    action.append(remove);
    row.append(key, note, added, action);
    tbody.append(row);
  }
}

async function load() {
  loading.hidden = false;
  try { render(await api(endpoint)); }
  catch (error) { loading.hidden = true; setMessage(error.message, 'error'); }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  setMessage('');
  try {
    const result = await api(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pubkey: form.pubkey.value, note: form.note.value }),
    });
    setMessage(result.created ? 'Pubkey added.' : 'Pubkey was already allowed.', 'success');
    if (result.created) form.reset();
    await load();
  } catch (error) {
    setMessage(error.message, 'error');
  } finally {
    submit.disabled = false;
  }
});

document.querySelector('#refresh').addEventListener('click', load);
load();
