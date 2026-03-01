// === Devices management ===

let currentFilter = 'all';

// === Favorites (server-side) ===
let _favorites = new Set();

async function loadFavorites() {
  try {
    const data = await api('GET', '/api/favorites');
    _favorites = new Set(data.favorites || []);
  } catch {
    _favorites = new Set();
  }
}

function getFavorites() {
  return _favorites;
}

function isFavorite(mac) {
  return _favorites.has(mac);
}

async function toggleFavorite(mac) {
  if (_favorites.has(mac)) _favorites.delete(mac);
  else _favorites.add(mac);
  renderDevices();
  await api('POST', '/api/favorites', { favorites: [..._favorites] });
}

async function loadDevices() {
  const container = document.getElementById('devices-list');
  container.innerHTML = '<div class="loading">Chargement des appareils...</div>';

  try {
    const [data] = await Promise.all([api('GET', '/api/devices'), loadFavorites()]);
    state.devices = data.devices;
    renderDevices();

    // Load WAN access status in background for active devices
    loadWanStatusInBackground();
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Erreur : ${escapeHtml(err.message)}</div>`;
  }
}

async function loadWanStatusInBackground() {
  const activeDevices = state.devices.filter(d => d.active && d.ip);
  for (const device of activeDevices) {
    try {
      const res = await fetch(`/api/devices/${encodeURIComponent(device.ip)}/status`);
      const data = await res.json();
      if (data.success) {
        device.blocked = data.blocked;
      }
    } catch {
      // ignore
    }
  }
  renderDevices();
}

function renderDevices() {
  const container = document.getElementById('devices-list');
  const search = document.getElementById('device-search').value.toLowerCase();

  let filtered = state.devices.filter(d => d.ip !== '192.168.178.1');

  // Apply search
  if (search) {
    filtered = filtered.filter(d =>
      (d.hostname || '').toLowerCase().includes(search) ||
      (d.ip || '').includes(search) ||
      (d.mac || '').toLowerCase().includes(search)
    );
  }

  // Apply filter
  if (currentFilter === 'online') {
    filtered = filtered.filter(d => d.active);
  } else if (currentFilter === 'blocked') {
    filtered = filtered.filter(d => d.blocked);
  } else if (currentFilter === 'favorites') {
    filtered = filtered.filter(d => isFavorite(d.mac));
  }

  // Sort: favorites first, then online, then by name
  const favs = getFavorites();
  filtered.sort((a, b) => {
    const aFav = favs.has(a.mac);
    const bFav = favs.has(b.mac);
    if (aFav !== bFav) return aFav ? -1 : 1;
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (a.hostname || '').localeCompare(b.hostname || '');
  });

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-state">Aucun appareil trouvé</div>';
    return;
  }

  container.innerHTML = filtered.map(device => {
    const statusClass = device.active ? 'online' : 'offline';
    const fav = isFavorite(device.mac);
    const cardClass = `device-card${device.blocked ? ' blocked' : ''}${!device.active ? ' offline' : ''}${fav ? ' favorite' : ''}`;
    const connType = device.interfaceType === 'Ethernet' ? 'Ethernet' :
                     device.interfaceType === '802.11' ? 'Wi-Fi' :
                     device.interfaceType || '?';

    return `
      <div class="${cardClass}" data-ip="${escapeAttr(device.ip)}">
        <div class="device-info">
          <div class="device-name">
            <button class="btn-favorite${fav ? ' active' : ''}" onclick="event.stopPropagation(); toggleFavorite('${escapeAttr(device.mac)}')" title="Favori">${fav ? '\u2605' : '\u2606'}</button>
            <span class="device-status ${statusClass}"></span>
            ${escapeHtml(device.hostname || device.ip || 'Inconnu')}
          </div>
          <div class="device-details">
            <span>IP: ${escapeHtml(device.ip)}</span>
            <span>MAC: ${escapeHtml(device.mac)}</span>
            <span>${escapeHtml(connType)}</span>
            ${device.speed && device.speed !== '0' ? `<span>${device.speed} Mbit/s</span>` : ''}
            ${device.blocked ? '<span style="color:var(--danger)">BLOQUE</span>' : ''}
          </div>
          ${!device.active && device.lastSeen ? `<div class="last-seen">Vu: ${formatLastSeen(device.lastSeen)}</div>` : ''}
        </div>
        <div class="device-actions">
          ${device.active && device.ip ? (
            device.blocked
              ? `<button class="btn-unblock" onclick="unblockDevice('${escapeAttr(device.ip)}')">Débloquer</button>`
              : `<button class="btn-block" onclick="blockDevice('${escapeAttr(device.ip)}')">Bloquer</button>`
          ) : ''}
          ${!device.active ? `<button class="btn-remove" onclick="removeDevice('${escapeAttr(device.hostname || device.ip)}', '${escapeAttr(device.mac)}')">Supprimer</button>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

async function blockDevice(ip) {
  const btn = document.querySelector(`[data-ip="${ip}"] .btn-block`);
  if (btn) btn.disabled = true;

  try {
    await api('POST', `/api/devices/${encodeURIComponent(ip)}/block`);
    showToast(`Appareil ${ip} bloqué`, 'success');
    await loadDevices();
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 'error');
    if (btn) btn.disabled = false;
  }
}

async function unblockDevice(ip) {
  const btn = document.querySelector(`[data-ip="${ip}"] .btn-unblock`);
  if (btn) btn.disabled = true;

  try {
    await api('POST', `/api/devices/${encodeURIComponent(ip)}/unblock`);
    showToast(`Appareil ${ip} débloqué`, 'success');
    await loadDevices();
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 'error');
    if (btn) btn.disabled = false;
  }
}

function formatLastSeen(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `il y a ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `il y a ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'hier';
  if (days < 30) return `il y a ${days} jours`;
  return new Date(ts).toLocaleDateString('fr-FR');
}

async function removeAllOffline() {
  const offlineDevices = state.devices.filter(d => !d.active);
  if (offlineDevices.length === 0) {
    showToast('Aucun appareil hors ligne à supprimer', 'info');
    return;
  }

  if (!confirm(`Supprimer ${offlineDevices.length} appareil(s) hors ligne de la Fritz!Box ?\n(Utilise le nettoyage intégré Fritz!Box)`)) return;

  const btn = document.querySelector('.btn-purge');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Nettoyage...';
  }

  try {
    const result = await api('POST', '/api/devices/cleanup');
    state.filters = null;
    showToast(`${result.removed} appareil(s) supprimé(s) (${result.countBefore} → ${result.countAfter})`, 'success');
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 'error');
  }

  if (btn) {
    btn.disabled = false;
    btn.textContent = 'Supprimer les hors ligne';
  }

  await loadDevices();
}

let _removeDevicePending = false;
async function removeDevice(name, mac) {
  if (_removeDevicePending) return;
  if (!confirm(`Supprimer l'appareil "${name}" (${mac}) de la Fritz!Box ?`)) return;

  _removeDevicePending = true;
  try {
    await api('POST', '/api/devices/remove', { name, mac });
    showToast(`Appareil "${name}" supprimé`, 'success');
    state.filters = null;
    await loadDevices();
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 'error');
  } finally {
    _removeDevicePending = false;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return String(str).replace(/[&"'<>]/g, c => ({
    '&': '&amp;', '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;'
  })[c]);
}

// === Search ===
document.getElementById('device-search').addEventListener('input', renderDevices);

// === Filter buttons ===
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    renderDevices();
  });
});
