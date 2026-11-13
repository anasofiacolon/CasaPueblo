// Shared by every protected admin screen: session check, logout and small helpers.
// The server already redirects unauthenticated visitors away from these pages;
// this is the client half (expired sessions, the user chip, the logout link).
window.CPAdmin = (function () {
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c]);

  function toLogin() {
    window.location.replace('login.html');
  }

  async function api(path, options = {}) {
    const init = { credentials: 'same-origin', ...options };
    if (options.body !== undefined && typeof options.body !== 'string') {
      init.body = JSON.stringify(options.body);
      init.headers = { 'content-type': 'application/json', ...(options.headers || {}) };
    }
    const res = await fetch(path, init);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      toLogin();
      throw new Error('Tu sesión expiró.');
    }
    if (!res.ok) throw Object.assign(new Error(data.error || 'No se pudo completar la solicitud.'), { status: res.status });
    return data;
  }

  // SQLite timestamps are UTC ("YYYY-MM-DD HH:MM:SS").
  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(String(value).replace(' ', 'T') + 'Z');
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('es-PR', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  const STATUS = { pending: 'Pendiente', approved: 'Aprobada', rejected: 'Rechazada' };
  const statusBadge = (status) => `<span class="status ${esc(status)}">${STATUS[status] || esc(status)}</span>`;

  const initials = (name) => String(name || '').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || 'A';

  const ready = api('/api/auth/me').then(({ admin }) => {
    const chipName = document.querySelector('.admin-user-chip strong');
    if (chipName) chipName.textContent = admin.full_name;
    const avatar = document.querySelector('.admin-avatar');
    if (avatar) avatar.textContent = initials(admin.full_name);
    const label = document.querySelector('[data-admin-name]');
    if (label) label.textContent = admin.full_name;
    return admin;
  });
  ready.catch(() => {});

  document.querySelectorAll('a.logout').forEach((link) =>
    link.addEventListener('click', async (event) => {
      event.preventDefault();
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
      toLogin();
    }),
  );

  // Highlight the current section in the sidebar.
  const page = location.pathname.split('/').pop().replace(/\.html$/, '');
  document.querySelectorAll('.sidebar nav a').forEach((a) => {
    if (a.getAttribute('href').replace(/\.html$/, '') === page) a.classList.add('active');
  });

  return { api, esc, formatDate, statusBadge, initials, ready };
})();
