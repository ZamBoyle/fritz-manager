// === Global state ===
const state = {
  connected: false,
  devices: [],
  filters: null,
};

// === API helper ===
async function api(method, url, body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const data = await res.json();

  if (!res.ok || !data.success) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// === Toast notifications ===
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// === Tab switching ===
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    const target = document.getElementById(`tab-${tab.dataset.tab}`);
    target.classList.add('active');

    // Load data when switching tabs
    if (tab.dataset.tab === 'devices') loadDevices();
    if (tab.dataset.tab === 'filters') {
      const activeSubTab = document.querySelector('.sub-tab.active')?.dataset.subtab;
      if (activeSubTab === 'devices') loadFilters();
      else loadProfiles();
    }
    if (tab.dataset.tab === 'monitor') loadMonitorData();
  });
});

// === Login ===
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const errorEl = document.getElementById('login-error');

  btn.disabled = true;
  btn.textContent = 'Connexion...';
  errorEl.classList.add('hidden');

  try {
    const host = document.getElementById('host').value;
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;

    await api('POST', '/api/login', { host, username, password });

    state.connected = true;
    document.getElementById('header-host').textContent = host;
    document.getElementById('login-screen').classList.remove('active');
    document.getElementById('main-screen').classList.remove('hidden');
    document.getElementById('main-screen').classList.add('active');

    showToast('Connecté à la Fritz!Box', 'success');
    loadDevices();
    // Preload filters in background (uses shared promise, no duplicate calls)
    loadFilters();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Se connecter';
  }
});

// === Refresh ===
document.getElementById('refresh-btn').addEventListener('click', () => {
  const activeTab = document.querySelector('.tab.active').dataset.tab;
  if (activeTab === 'devices') loadDevices();
  if (activeTab === 'filters') {
    const activeSubTab = document.querySelector('.sub-tab.active')?.dataset.subtab;
    if (activeSubTab === 'devices') loadFilters();
    else loadProfiles();
  }
  if (activeTab === 'monitor') loadMonitorData();
  showToast('Actualisation...', 'info');
});

// === Logout ===
document.getElementById('logout-btn').addEventListener('click', async () => {
  // Clear monitor auto-refresh timer
  if (typeof monitorRefreshTimer !== 'undefined' && monitorRefreshTimer) {
    clearInterval(monitorRefreshTimer);
    monitorRefreshTimer = null;
  }

  // Server-side cleanup (stop monitor, clear session)
  try { await api('POST', '/api/logout'); } catch { /* ignore */ }

  state.connected = false;
  state.devices = [];
  state.filters = null;
  document.getElementById('main-screen').classList.remove('active');
  document.getElementById('main-screen').classList.add('hidden');
  document.getElementById('login-screen').classList.add('active');
  document.getElementById('password').value = '';
  showToast('Déconnecté', 'info');
});
