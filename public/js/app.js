(function() {
'use strict';

// === Global state ===
const state = {
  connected: false,
  devices: [],
  filters: null,
};

// === API endpoints ===
const API = {
  LOGIN: '/api/login',
  LOGOUT: '/api/logout',
  DEVICES: '/api/devices',
  DEVICE_STATUS: (ip) => `/api/devices/${encodeURIComponent(ip)}/status`,
  DEVICE_BLOCK: (ip) => `/api/devices/${encodeURIComponent(ip)}/block`,
  DEVICE_UNBLOCK: (ip) => `/api/devices/${encodeURIComponent(ip)}/unblock`,
  DEVICES_CLEANUP: '/api/devices/cleanup',
  DEVICES_REMOVE: '/api/devices/remove',
  FAVORITES: '/api/favorites',
  FILTERS: '/api/filters',
  FILTERS_BLOCK: '/api/filters/block',
  FILTERS_PROFILE: '/api/filters/profile',
  PROFILES: '/api/profiles',
  PROFILES_META: '/api/profiles/meta',
  PROFILE: (id) => `/api/profiles/${encodeURIComponent(id)}`,
  PROFILES_WEBSITES: (type) => `/api/profiles/websites/${encodeURIComponent(type)}`,
  MONITOR_STATUS: '/api/monitor/status',
  MONITOR_START: '/api/monitor/start',
  MONITOR_STOP: '/api/monitor/stop',
};

// === API helper ===
async function api(method, url, body = null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
  };
  if (body) opts.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error('Requete expirée (timeout)');
    throw err;
  }
  clearTimeout(timeout);

  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// === Shared action guard (disable btn, catch → toast error, re-enable) ===
async function withBtnGuard(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    await fn();
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 'error');
    if (btn) btn.disabled = false;
  }
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

    await api('POST', API.LOGIN, { host, username, password });

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
  cleanupMonitor();

  // Server-side cleanup (stop monitor, clear session)
  try { await api('POST', API.LOGOUT); } catch { /* ignore */ }

  state.connected = false;
  state.devices = [];
  state.filters = null;
  document.getElementById('main-screen').classList.remove('active');
  document.getElementById('main-screen').classList.add('hidden');
  document.getElementById('login-screen').classList.add('active');
  document.getElementById('password').value = '';
  showToast('Déconnecté', 'info');
});

// === Unhandled promise rejection handler ===
window.addEventListener('unhandledrejection', (e) => {
  console.error('Unhandled promise rejection:', e.reason);
  e.preventDefault();
});

// === Debounce utility ===
function debounce(fn, ms = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// === Skeleton loading placeholders ===
function skeletonCards(count = 3) {
  const card = `<div class="skeleton-card">
    <div class="skeleton-circle"></div>
    <div style="flex:1;display:flex;flex-direction:column;gap:8px">
      <div class="skeleton-line wide"></div>
      <div class="skeleton-line medium"></div>
    </div>
  </div>`;
  return `<div class="skeleton-list">${card.repeat(count)}</div>`;
}

// Expose shared API for other modules
window.state = state;
window.API = API;
window.api = api;
window.showToast = showToast;
window.withBtnGuard = withBtnGuard;
window.debounce = debounce;
window.skeletonCards = skeletonCards;
})();
