(() => {
  function update() {
    const existing = document.querySelector('#blossom-upload-link');
    if (window.location.pathname !== '/') { existing?.remove(); return; }
    if (existing) return;
    const link = document.createElement('a');
    link.id = 'blossom-upload-link';
    link.href = '/blossom-upload.html';
    link.textContent = 'Blossom Upload';
    Object.assign(link.style, {
      position: 'fixed', left: '18px', bottom: '18px', zIndex: '2000', padding: '10px 14px',
      borderRadius: '999px', background: '#6d4aff', color: '#fff', textDecoration: 'none',
      font: '600 14px system-ui, sans-serif', boxShadow: '0 6px 24px rgba(30,25,60,.25)',
    });
    document.body.append(link);
  }
  const pushState = history.pushState;
  history.pushState = function (...args) { pushState.apply(this, args); queueMicrotask(update); };
  window.addEventListener('popstate', update);
  window.addEventListener('DOMContentLoaded', update);
  update();
})();
