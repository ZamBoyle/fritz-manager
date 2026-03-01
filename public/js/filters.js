(function() {
'use strict';

let _filtersLoading = null; // Shared promise to avoid duplicate calls

async function loadFilters(forceRefresh = false) {
  const container = document.getElementById('filters-list');
  const infoPanel = document.getElementById('filters-info');

  // If data already loaded and no refresh needed, render immediately
  if (!forceRefresh && state.filters && state.filters.devices) {
    renderFilters();
    return;
  }

  // If a request is already in flight, wait for it
  if (_filtersLoading) {
    container.innerHTML = '<div class="loading">Chargement du contrôle parental...</div>';
    infoPanel.classList.add('hidden');
    try {
      await _filtersLoading;
      renderFilters();
    } catch (err) {
      container.innerHTML = `<div class="empty-state">Erreur : ${escapeHtml(err.message)}</div>`;
    }
    return;
  }

  container.innerHTML = '<div class="loading">Chargement du contrôle parental...</div>';
  infoPanel.classList.add('hidden');

  _filtersLoading = api('GET', '/api/filters').then(res => {
    state.filters = res.data;
  });

  try {
    await _filtersLoading;
    renderFilters();
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Erreur : ${escapeHtml(err.message)}</div>`;
  } finally {
    _filtersLoading = null;
  }
}

function renderFilters() {
  const container = document.getElementById('filters-list');
  const infoPanel = document.getElementById('filters-info');
  const data = state.filters;

  if (!data || !data.devices || data.devices.length === 0) {
    container.innerHTML = '<div class="empty-state">Aucun appareil trouvé dans le contrôle parental</div>';
    return;
  }

  const search = document.getElementById('filter-search').value.toLowerCase();
  const profiles = data.profiles || [];

  // Show profiles info
  infoPanel.classList.remove('hidden');
  infoPanel.innerHTML = `<strong>Profils disponibles :</strong> ${profiles.map(p =>
    `<span class="profile-badge">${escapeHtml(p.name)}</span>`
  ).join(' ')}`;

  let devices = data.devices;
  if (search) {
    devices = devices.filter(d => d.name.toLowerCase().includes(search));
  }

  container.innerHTML = devices.map(device => {
    const blockedClass = device.blocked ? 'blocked' : '';
    const restrictedClass = device.usage === 'Restricted' ? 'restricted' : '';

    const profileOptions = profiles.map(p =>
      `<option value="${escapeAttr(p.id)}" ${p.id === device.profileId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
    ).join('');

    return `
      <div class="device-card ${blockedClass} ${restrictedClass}" data-uid="${escapeAttr(device.uid)}">
        <div class="device-info">
          <div class="device-name">
            ${device.blocked ? '<span class="device-status offline"></span>' : '<span class="device-status online"></span>'}
            ${escapeHtml(device.name)}
          </div>
          <div class="device-details">
            <span>Profil: <strong>${escapeHtml(device.profileName)}</strong></span>
            <span>Accès: ${escapeHtml(device.usage)}</span>
            ${device.blocked ? '<span style="color:var(--danger)">BLOQUE</span>' : ''}
          </div>
        </div>
        <div class="device-actions">
          <select class="profile-select" onchange="changeProfile('${escapeAttr(device.uid)}', this.value)">
            ${profileOptions}
          </select>
          ${device.blocked
            ? `<button class="btn-unblock" onclick="toggleKidBlock('${escapeAttr(device.uid)}', false)">Débloquer</button>`
            : `<button class="btn-block" onclick="toggleKidBlock('${escapeAttr(device.uid)}', true)">Bloquer</button>`
          }
        </div>
      </div>
    `;
  }).join('');
}

async function toggleKidBlock(uid, block) {
  const card = document.querySelector(`[data-uid="${uid}"]`);
  const btn = card?.querySelector('.btn-block, .btn-unblock');
  if (btn) btn.disabled = true;

  try {
    await api('POST', '/api/filters/block', { uid, blocked: block });
    showToast(`Appareil ${block ? 'bloqué' : 'débloqué'}`, 'success');
    await loadFilters(true);
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 'error');
    if (btn) btn.disabled = false;
  }
}

let _changeProfilePending = false;
async function changeProfile(uid, profileId) {
  if (_changeProfilePending) return;
  _changeProfilePending = true;
  try {
    await api('POST', '/api/filters/profile', { uid, profileId });
    showToast('Profil modifié', 'success');
    await loadFilters(true);
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 'error');
    await loadFilters(true);
  } finally {
    _changeProfilePending = false;
  }
}

// Search
document.getElementById('filter-search').addEventListener('input', renderFilters);

// Expose public API
window.loadFilters = loadFilters;
window.toggleKidBlock = toggleKidBlock;
window.changeProfile = changeProfile;
})();
