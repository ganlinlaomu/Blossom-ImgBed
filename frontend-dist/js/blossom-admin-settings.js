(() => {
  const settingsEndpoint = '/api/manage/blossom/settings';
  const pubkeysEndpoint = '/api/manage/blossom/pubkeys';
  const adminPaths = new Set(['/dashboard', '/customerConfig', '/systemConfig']);
  let loading = false;

  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'include', ...options });
    let body = {};
    try { body = await response.json(); } catch { /* empty response */ }
    if (response.status === 401) {
      window.location.assign('/adminLogin');
      throw new Error('Administrator login required');
    }
    if (!response.ok) throw new Error(body.message || body.error || `Request failed (${response.status})`);
    return body;
  }

  function setMessage(text, type = '') {
    const message = document.querySelector('#blossom-message');
    if (!message) return;
    message.textContent = text;
    message.className = `blossom-message ${type}`;
  }

  function renderPubkeys(entries) {
    const list = document.querySelector('#blossom-pubkey-list');
    if (!list) return;
    list.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.className = 'blossom-empty';
      empty.textContent = 'No Nostr pubkeys have been allowed yet.';
      list.append(empty);
      return;
    }

    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'blossom-pubkey-row';
      const identity = document.createElement('div');
      identity.className = 'blossom-pubkey-identity';
      const npub = document.createElement('code');
      npub.textContent = entry.npub;
      npub.title = entry.npub;
      const meta = document.createElement('span');
      const date = new Date(entry.createdAt * 1000).toLocaleString();
      meta.textContent = `${entry.note || 'No note'} · ${date}`;
      identity.append(npub, meta);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'blossom-button danger';
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        if (!window.confirm('Remove this pubkey from Blossom write access? Existing media will remain.')) return;
        remove.disabled = true;
        try {
          await api(`${pubkeysEndpoint}/${encodeURIComponent(entry.pubkey)}`, { method: 'DELETE' });
          setMessage('Pubkey removed. Existing media was not deleted.', 'success');
          renderPubkeys(await api(pubkeysEndpoint));
        } catch (error) {
          setMessage(error.message, 'error');
          remove.disabled = false;
        }
      });
      row.append(identity, remove);
      list.append(row);
    }
  }

  async function loadSettings() {
    if (loading) return;
    loading = true;
    try {
      const [settings, entries] = await Promise.all([api(settingsEndpoint), api(pubkeysEndpoint)]);
      const enabled = document.querySelector('#blossom-enabled');
      const serverUrl = document.querySelector('#blossom-server-url');
      if (enabled) enabled.checked = settings.enabled;
      if (serverUrl) serverUrl.value = settings.serverUrl;
      renderPubkeys(entries);
    } catch (error) {
      setMessage(error.message, 'error');
    } finally {
      loading = false;
    }
  }

  function buildPanel() {
    const panel = document.createElement('main');
    panel.id = 'blossom-settings';
    panel.className = 'main-container blossom-settings-panel';
    panel.setAttribute('data-v-7e9e1ae0', '');
    panel.innerHTML = `
      <div class="blossom-settings-inner">
        <div class="blossom-heading">
          <div><p class="blossom-kicker">Nostr protocol</p><h1>Blossom</h1></div>
          <p>Manage BUD-11 write access. Nostr users never receive access to this dashboard.</p>
        </div>
        <section class="blossom-card">
          <div class="blossom-setting-row">
            <div><h2>Enable Blossom</h2><p>Allow signed, allowlisted BUD-11 upload and delete requests.</p></div>
            <label class="blossom-switch"><input id="blossom-enabled" type="checkbox"><span></span></label>
          </div>
          <div class="blossom-field-group">
            <label for="blossom-server-url">Server URL</label>
            <div class="blossom-copy-row"><input id="blossom-server-url" readonly><button id="blossom-copy" class="blossom-button" type="button">Copy</button></div>
            <p>Configure this URL in a compatible Nostr client.</p>
          </div>
        </section>
        <section class="blossom-card">
          <div class="blossom-section-title"><div><h2>Allowed Nostr Pubkeys</h2><p>Allowlist membership grants Blossom write access only—not Admin access.</p></div><button id="blossom-refresh" class="blossom-button" type="button">Refresh</button></div>
          <form id="blossom-add-form" class="blossom-add-form">
            <div><label for="blossom-pubkey">Nostr pubkey</label><input id="blossom-pubkey" name="pubkey" required autocomplete="off" spellcheck="false" placeholder="npub1… or 64-character hex"></div>
            <div><label for="blossom-note">Note <span>(optional)</span></label><input id="blossom-note" name="note" maxlength="200" autocomplete="off" placeholder="Client or owner"></div>
            <button class="blossom-button primary" type="submit">Add</button>
          </form>
          <div id="blossom-pubkey-list" class="blossom-pubkey-list"><p class="blossom-empty">Loading…</p></div>
        </section>
        <p id="blossom-message" class="blossom-message" role="status" aria-live="polite"></p>
      </div>`;

    panel.querySelector('#blossom-enabled').addEventListener('change', async event => {
      const input = event.currentTarget;
      input.disabled = true;
      try {
        const settings = await api(settingsEndpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: input.checked }),
        });
        input.checked = settings.enabled;
        setMessage(settings.enabled ? 'Blossom write access enabled.' : 'Blossom write access disabled.', 'success');
      } catch (error) {
        input.checked = !input.checked;
        setMessage(error.message, 'error');
      } finally { input.disabled = false; }
    });
    panel.querySelector('#blossom-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(panel.querySelector('#blossom-server-url').value);
        setMessage('Server URL copied.', 'success');
      } catch { setMessage('Copy failed. Select and copy the URL manually.', 'error'); }
    });
    panel.querySelector('#blossom-refresh').addEventListener('click', async () => {
      try { renderPubkeys(await api(pubkeysEndpoint)); } catch (error) { setMessage(error.message, 'error'); }
    });
    panel.querySelector('#blossom-add-form').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        const result = await api(pubkeysEndpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pubkey: form.pubkey.value, note: form.note.value }),
        });
        setMessage(result.created ? 'Pubkey added.' : 'Pubkey was already allowed.', 'success');
        if (result.created) form.reset();
        renderPubkeys(await api(pubkeysEndpoint));
      } catch (error) { setMessage(error.message, 'error'); }
      finally { submit.disabled = false; }
    });
    return panel;
  }

  function sync() {
    const onAdminPage = adminPaths.has(window.location.pathname);
    let shortcut = document.querySelector('#blossom-admin-shortcut');
    if (!onAdminPage) {
      shortcut?.remove();
      return;
    }

    const headerAction = document.querySelector('.admin-header-content .header-action');
    if (headerAction && !shortcut) {
      shortcut = document.createElement('a');
      shortcut.id = 'blossom-admin-shortcut';
      shortcut.className = 'blossom-admin-shortcut';
      shortcut.href = '/systemConfig#blossom';
      shortcut.textContent = 'Blossom';
      shortcut.title = 'Blossom Settings and Nostr pubkey allowlist';
      headerAction.prepend(shortcut);
    }

    if (window.location.pathname !== '/systemConfig') return;
    const container = document.querySelector('.container');
    const menu = document.querySelector('.sidebar-container .menu-list');
    if (!container || !menu) return;

    let menuItem = document.querySelector('#blossom-settings-menu');
    if (!menuItem) {
      menuItem = document.createElement('div');
      menuItem.id = 'blossom-settings-menu';
      menuItem.className = 'menu-item blossom-menu-item';
      menuItem.innerHTML = '<span class="blossom-menu-icon">✦</span><span class="menu-text">Blossom</span>';
      menuItem.setAttribute('data-v-418ec867', '');
      for (const child of menuItem.children) child.setAttribute('data-v-418ec867', '');
      menuItem.addEventListener('click', () => { window.location.hash = 'blossom'; });
      menu.append(menuItem);
    }

    let panel = document.querySelector('#blossom-settings');
    if (!panel) {
      panel = buildPanel();
      container.append(panel);
    }
    const active = window.location.hash === '#blossom';
    menuItem.classList.toggle('is-active', active);
    panel.hidden = !active;
    for (const main of container.querySelectorAll('.main-container:not(.blossom-settings-panel)')) main.hidden = active;
    if (active && panel.dataset.loaded !== 'true') {
      panel.dataset.loaded = 'true';
      loadSettings();
    }
  }

  const observer = new MutationObserver(sync);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('hashchange', sync);
  window.addEventListener('popstate', sync);
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      queueMicrotask(sync);
      return result;
    };
  }
  sync();
})();
