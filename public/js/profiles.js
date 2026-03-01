(function() {
'use strict';

let profilesMeta = {};
let profilesList = [];
let editingProfile = null;
let _scheduleState = null;
let _scheduleMouseDown = false;
let _schedulePaintMode = null;
let _scheduleAbort = null;
let _selectedProfileIcon = null;
const _originalModalBodyHtml = document.querySelector('#profile-editor-modal .modal-body')?.innerHTML || '';

const PROFILE_ICONS = [
  { emoji: '\u{1F6E1}\uFE0F', label: 'Standard' },
  { emoji: '\u{1F3AE}', label: 'Jeux' },
  { emoji: '\u{1F4F1}', label: 'Mobile' },
  { emoji: '\u{1F476}', label: 'Enfant' },
  { emoji: '\u{1F4DA}', label: 'Ecole' },
  { emoji: '\u{1F3AC}', label: 'Video' },
  { emoji: '\u{1F3E0}', label: 'Maison' },
  { emoji: '\u2B50', label: 'VIP' },
  { emoji: '\u{1F512}', label: 'Restreint' },
  { emoji: '\u{1F310}', label: 'Internet' },
  { emoji: '\u{1F3B5}', label: 'Musique' },
  { emoji: '\u{1F4BC}', label: 'Travail' },
];

function getDefaultIcon(profile) {
  if (profile.id === 'filtprof3') return '\u{1F513}';
  if (profile.id === 'filtprof2') return '\u{1F464}';
  if (profile.id === 'filtprof1') return '\u{1F6E1}\uFE0F';
  return '\u{1F4CB}';
}

// === Sub-tab switching ===

function switchFilterSubTab(tab) {
  document.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.subtab-content').forEach(c => c.classList.remove('active'));
  document.querySelector(`[data-subtab="${tab}"]`).classList.add('active');
  document.getElementById(`subtab-${tab}`).classList.add('active');
  if (tab === 'profiles') loadProfiles();
  if (tab === 'devices') loadFilters();
}

// === Profile Cards ===

async function loadProfiles() {
  const container = document.getElementById('profiles-grid');
  container.innerHTML = '<div class="loading">Chargement des profils...</div>';
  try {
    const [profilesRes, metaRes] = await Promise.all([
      api('GET', '/api/profiles'),
      api('GET', '/api/profiles/meta'),
    ]);
    profilesList = profilesRes.data;
    profilesMeta = metaRes.meta || {};
    renderProfileCards();
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Erreur : ${escapeHtml(err.message)}</div>`;
  }
}

function buildProfileSummary(profile) {
  const parts = [];
  if (profile.onlineTime === 'unlimited') parts.push('Acces illimite');
  else if (profile.onlineTime === 'never' || profile.onlineTime === 'blocked') parts.push('Acces bloque');
  else parts.push('Horaires limites');
  if (profile.budget && profile.budget !== '\u2014' && profile.budget !== ' \u2014 ') parts.push('Budget: ' + profile.budget);
  if (profile.filter && profile.filter !== '\u2014' && profile.filter !== ' \u2014 ') parts.push(profile.filter);
  return parts.join(' \u00B7 ');
}

function renderProfileCards() {
  const container = document.getElementById('profiles-grid');
  container.innerHTML = profilesList.map(profile => {
    const meta = profilesMeta[profile.id] || {};
    const icon = meta.icon || getDefaultIcon(profile);
    const isReadOnly = profile.id === 'filtprof3';
    const summary = buildProfileSummary(profile);

    return `
      <div class="profile-card${profile.deletable ? ' custom' : ' system'}" data-profile-id="${escapeAttr(profile.id)}">
        <div class="profile-card-header">
          <div class="profile-card-icon">${escapeHtml(icon)}</div>
          <div class="profile-card-info">
            <div class="profile-card-name">${escapeHtml(profile.name)}</div>
            <div class="profile-card-summary">${escapeHtml(summary)}</div>
          </div>
        </div>
        <div class="profile-card-actions">
          ${!isReadOnly ? `<button class="btn-edit-profile" onclick="openProfileEditor('${escapeAttr(profile.id)}')">Modifier</button>` : ''}
          ${profile.deletable ? `<button class="btn-delete-profile" onclick="deleteProfile('${escapeAttr(profile.id)}', '${escapeAttr(profile.name)}')">Supprimer</button>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

// === Profile Editor Modal ===

async function openProfileEditor(profileId = null) {
  const modal = document.getElementById('profile-editor-modal');
  const title = document.getElementById('profile-editor-title');

  // Remember what had focus before opening (to restore on close)
  modal._previousFocus = document.activeElement;

  if (profileId) {
    title.textContent = 'Modifier le profil';
    modal.classList.remove('hidden');
    document.querySelector('.modal-body').innerHTML = '<div class="loading">Chargement...</div>';
    try {
      const res = await api('GET', `/api/profiles/${profileId}`);
      editingProfile = res.data;
      rebuildModalBody();
      populateProfileForm(editingProfile);
    } catch (err) {
      showToast(`Erreur: ${err.message}`, 'error');
      modal.classList.add('hidden');
      return;
    }
  } else {
    title.textContent = 'Nouveau profil';
    editingProfile = null;
    modal.classList.remove('hidden');
    rebuildModalBody();
    resetProfileForm();
  }

  // Focus first input inside modal
  const firstInput = modal.querySelector('input:not([disabled]), button:not(.modal-close):not([disabled])');
  if (firstInput) firstInput.focus();
}

function rebuildModalBody() {
  const body = document.querySelector('#profile-editor-modal .modal-body');
  if (body && !document.getElementById('profile-name')) {
    body.innerHTML = _originalModalBodyHtml;
  }
  renderIconPicker();
  updateFormSections();
}

function closeProfileEditor() {
  const modal = document.getElementById('profile-editor-modal');
  modal.classList.add('hidden');
  editingProfile = null;
  _scheduleState = null;
  _websiteListCache = {};
  if (_scheduleAbort) { _scheduleAbort.abort(); _scheduleAbort = null; }
  // Restore focus to the element that opened the modal
  if (modal._previousFocus) { modal._previousFocus.focus(); modal._previousFocus = null; }
}

function populateProfileForm(data) {
  document.getElementById('profile-name').value = data.name || '';

  const timeRadio = document.querySelector(`input[name="profile-time"][value="${data.time}"]`);
  if (timeRadio) timeRadio.checked = true;

  const budgetRadio = document.querySelector(`input[name="profile-budget"][value="${data.budget}"]`);
  if (budgetRadio) budgetRadio.checked = true;

  document.getElementById('profile-share-budget').checked = data.shareBudget;
  document.getElementById('profile-disallow-guest').checked = data.disallowGuest;
  document.getElementById('profile-parental').checked = data.parental;

  const filterRadio = document.querySelector(`input[name="profile-filtertype"][value="${data.filterType}"]`);
  if (filterRadio) filterRadio.checked = true;

  _scheduleState = initScheduleFromTimerItems(data.timerItems || []);
  renderBudgetDays(data.budgetPerDay);
  updateFormSections();
  if (data.time === 'limited') renderScheduleGrid();
}

function resetProfileForm() {
  document.getElementById('profile-name').value = '';
  document.querySelector('input[name="profile-time"][value="unlimited"]').checked = true;
  document.querySelector('input[name="profile-budget"][value="unlimited"]').checked = true;
  document.getElementById('profile-share-budget').checked = false;
  document.getElementById('profile-disallow-guest').checked = false;
  document.getElementById('profile-parental').checked = false;
  const blackRadio = document.querySelector('input[name="profile-filtertype"][value="black"]');
  if (blackRadio) blackRadio.checked = true;
  _scheduleState = Array.from({ length: 7 }, () => Array(24).fill(true));
  renderBudgetDays({});
  updateFormSections();
}

function updateFormSections() {
  const time = document.querySelector('input[name="profile-time"]:checked')?.value;
  const budget = document.querySelector('input[name="profile-budget"]:checked')?.value;
  const parental = document.getElementById('profile-parental').checked;

  document.getElementById('schedule-section').classList.toggle('hidden', time !== 'limited');
  document.getElementById('budget-section').classList.toggle('hidden', budget !== 'limited');
  document.getElementById('filter-section').classList.toggle('hidden', !parental);

  if (time === 'limited') renderScheduleGrid();
  if (parental) loadWebsiteList();
}

function toggleFilterSection() {
  updateFormSections();
}

// Close modal on Escape key + focus trap
document.addEventListener('keydown', (e) => {
  const modal = document.getElementById('profile-editor-modal');
  if (modal.classList.contains('hidden')) return;

  if (e.key === 'Escape') {
    closeProfileEditor();
    return;
  }

  // Focus trap: keep Tab/Shift+Tab inside modal
  if (e.key === 'Tab') {
    const focusable = modal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
});

// Listen for radio changes to show/hide sections and reload website list
document.addEventListener('change', (e) => {
  if (e.target.name === 'profile-time' || e.target.name === 'profile-budget') {
    updateFormSections();
  }
  if (e.target.name === 'profile-filtertype') loadWebsiteList();
});

// === Icon Picker ===

function renderIconPicker() {
  const picker = document.getElementById('icon-picker');
  if (!picker) return;
  const currentIcon = editingProfile
    ? (profilesMeta[editingProfile.id]?.icon || getDefaultIcon(editingProfile))
    : PROFILE_ICONS[0].emoji;
  _selectedProfileIcon = currentIcon;

  picker.innerHTML = PROFILE_ICONS.map(({ emoji, label }) => `
    <button type="button" class="icon-option${emoji === currentIcon ? ' selected' : ''}"
            onclick="selectIcon(this, '${emoji}')" title="${label}">${emoji}</button>
  `).join('');
}

function selectIcon(btn, emoji) {
  document.querySelectorAll('.icon-option').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  _selectedProfileIcon = emoji;
}

// === Website List ===

let _websiteListCache = {};

async function loadWebsiteList() {
  const listEl = document.getElementById('website-list');
  const titleEl = document.getElementById('website-list-title');
  const countEl = document.getElementById('website-list-count');
  if (!listEl) return;

  const filterType = document.querySelector('input[name="profile-filtertype"]:checked')?.value || 'black';
  titleEl.textContent = filterType === 'black' ? 'Sites bloques' : 'Sites autorises';

  if (_websiteListCache[filterType]) {
    renderWebsiteList(_websiteListCache[filterType], filterType);
    return;
  }

  listEl.innerHTML = '<div class="loading-small">Chargement...</div>';
  countEl.textContent = '';
  try {
    const res = await api('GET', `/api/profiles/websites/${filterType}`);
    const data = res.data || { list: [] };
    _websiteListCache[filterType] = data;
    renderWebsiteList(data, filterType);
  } catch (err) {
    listEl.innerHTML = `<div class="website-list-empty">Erreur: ${escapeHtml(err.message)}</div>`;
  }
}

function renderWebsiteList(data, filterType) {
  const listEl = document.getElementById('website-list');
  const countEl = document.getElementById('website-list-count');
  if (!listEl) return;
  const urls = data.list || [];
  countEl.textContent = urls.length > 0 ? `(${urls.length})` : '';

  if (urls.length === 0) {
    listEl.innerHTML = `<div class="website-list-empty">${filterType === 'black' ? 'Aucun site bloque' : 'Aucun site autorise'}</div>`;
    return;
  }

  listEl.innerHTML = urls.map(entry =>
    `<span class="website-tag ${filterType === 'white' ? 'allowed' : ''}">` +
    `${escapeHtml(entry.url)}` +
    `<button type="button" class="website-tag-remove" onclick="removeWebsiteEntry('${escapeAttr(entry.url)}')" title="Supprimer">&times;</button>` +
    `</span>`
  ).join('');
}

async function addWebsiteEntry() {
  const input = document.getElementById('website-add-input');
  const url = (input.value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!url || !url.includes('.')) {
    showToast('Entrez un domaine valide (ex: tiktok.com)', 'error');
    return;
  }

  const filterType = document.querySelector('input[name="profile-filtertype"]:checked')?.value || 'black';

  const cached = _websiteListCache[filterType];
  const currentUrls = (cached?.list || []).map(e => e.url);
  if (currentUrls.includes(url)) {
    showToast('Ce site est deja dans la liste', 'error');
    return;
  }

  const newUrls = [...currentUrls, url];
  input.disabled = true;

  try {
    await api('PUT', `/api/profiles/websites/${filterType}`, { urls: newUrls });
    input.value = '';
    delete _websiteListCache[filterType];
    await loadWebsiteList();
    showToast(`${url} ajoute`, 'success');
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 'error');
  } finally {
    input.disabled = false;
    input.focus();
  }
}

let _removeWebsitePending = false;
async function removeWebsiteEntry(url) {
  if (_removeWebsitePending) return;
  _removeWebsitePending = true;
  const filterType = document.querySelector('input[name="profile-filtertype"]:checked')?.value || 'black';
  const cached = _websiteListCache[filterType];
  const currentUrls = (cached?.list || []).map(e => e.url);
  const newUrls = currentUrls.filter(u => u !== url);

  try {
    await api('PUT', `/api/profiles/websites/${filterType}`, { urls: newUrls });
    delete _websiteListCache[filterType];
    await loadWebsiteList();
    showToast(`${url} supprime`, 'success');
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 'error');
  } finally {
    _removeWebsitePending = false;
  }
}

// === Schedule Grid ===

function initScheduleFromTimerItems(timerItems) {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(false));

  if (timerItems.length === 0) {
    return Array.from({ length: 7 }, () => Array(24).fill(true));
  }

  const sorted = [...timerItems].sort((a, b) => {
    const ta = parseInt(a.time.substring(0, 2)) * 60 + parseInt(a.time.substring(2));
    const tb = parseInt(b.time.substring(0, 2)) * 60 + parseInt(b.time.substring(2));
    return ta - tb;
  });

  for (let dayBit = 0; dayBit < 7; dayBit++) {
    let mode = false;
    let curHour = 0;
    for (const item of sorted) {
      if (!(item.days & (1 << dayBit))) continue;
      const itemHour = parseInt(item.time.substring(0, 2));
      for (let h = curHour; h < itemHour && h < 24; h++) grid[dayBit][h] = mode;
      mode = item.mode === 1;
      curHour = itemHour;
    }
    for (let h = curHour; h < 24; h++) grid[dayBit][h] = mode;
  }
  return grid;
}

function scheduleGridToTimerItems(grid) {
  const items = [];
  for (let h = 0; h < 24; h++) {
    let allowedDays = 0;
    let blockedDays = 0;
    for (let d = 0; d < 7; d++) {
      const prev = h > 0 ? grid[d][h - 1] : false;
      const curr = grid[d][h];
      if (curr && !prev) allowedDays |= (1 << d);
      if (!curr && prev) blockedDays |= (1 << d);
    }
    const timeStr = h.toString().padStart(2, '0') + '00';
    if (allowedDays) items.push({ time: timeStr, mode: 1, days: allowedDays });
    if (blockedDays) items.push({ time: timeStr, mode: 0, days: blockedDays });
  }
  return items;
}

function renderScheduleGrid() {
  const grid = document.getElementById('schedule-grid');
  if (!grid) return;
  if (!_scheduleState) _scheduleState = Array.from({ length: 7 }, () => Array(24).fill(true));

  const dayLabels = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

  let html = '<div class="schedule-header"><div class="schedule-label"></div>';
  for (let h = 0; h < 24; h++) {
    html += `<div class="schedule-hour-label">${h}</div>`;
  }
  html += '</div>';

  for (let d = 0; d < 7; d++) {
    html += `<div class="schedule-row"><div class="schedule-label">${dayLabels[d]}</div>`;
    for (let h = 0; h < 24; h++) {
      const allowed = _scheduleState[d][h];
      html += `<div class="schedule-cell ${allowed ? 'allowed' : 'blocked'}"
                    data-day="${d}" data-hour="${h}"></div>`;
    }
    html += '</div>';
  }

  grid.innerHTML = html;

  if (_scheduleAbort) _scheduleAbort.abort();
  _scheduleAbort = new AbortController();
  const signal = _scheduleAbort.signal;

  grid.addEventListener('mousedown', onScheduleMouseDown, { signal });
  grid.addEventListener('mouseover', onScheduleMouseOver, { signal });
  document.addEventListener('mouseup', onScheduleMouseUp, { signal });
  grid.addEventListener('touchstart', onScheduleTouchStart, { passive: false, signal });
  grid.addEventListener('touchmove', onScheduleTouchMove, { passive: false, signal });
  grid.addEventListener('touchend', onScheduleMouseUp, { signal });
}

function onScheduleMouseDown(e) {
  const cell = e.target.closest('.schedule-cell');
  if (!cell) return;
  e.preventDefault();
  _scheduleMouseDown = true;
  const d = parseInt(cell.dataset.day);
  const h = parseInt(cell.dataset.hour);
  _schedulePaintMode = !_scheduleState[d][h];
  _scheduleState[d][h] = _schedulePaintMode;
  cell.className = `schedule-cell ${_schedulePaintMode ? 'allowed' : 'blocked'}`;
}

function onScheduleMouseOver(e) {
  if (!_scheduleMouseDown) return;
  const cell = e.target.closest('.schedule-cell');
  if (!cell) return;
  const d = parseInt(cell.dataset.day);
  const h = parseInt(cell.dataset.hour);
  _scheduleState[d][h] = _schedulePaintMode;
  cell.className = `schedule-cell ${_schedulePaintMode ? 'allowed' : 'blocked'}`;
}

function onScheduleMouseUp() {
  _scheduleMouseDown = false;
  _schedulePaintMode = null;
}

function onScheduleTouchStart(e) {
  const touch = e.touches[0];
  const cell = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('.schedule-cell');
  if (!cell) return;
  e.preventDefault();
  _scheduleMouseDown = true;
  const d = parseInt(cell.dataset.day);
  const h = parseInt(cell.dataset.hour);
  _schedulePaintMode = !_scheduleState[d][h];
  _scheduleState[d][h] = _schedulePaintMode;
  cell.className = `schedule-cell ${_schedulePaintMode ? 'allowed' : 'blocked'}`;
}

function onScheduleTouchMove(e) {
  if (!_scheduleMouseDown) return;
  e.preventDefault();
  const touch = e.touches[0];
  const cell = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('.schedule-cell');
  if (!cell) return;
  const d = parseInt(cell.dataset.day);
  const h = parseInt(cell.dataset.hour);
  _scheduleState[d][h] = _schedulePaintMode;
  cell.className = `schedule-cell ${_schedulePaintMode ? 'allowed' : 'blocked'}`;
}

// === Budget Days ===

function renderBudgetDays(budgetData) {
  const container = document.getElementById('budget-days');
  if (!container) return;
  const data = budgetData || {};
  const days = [
    { key: 'monday', label: 'Lun' }, { key: 'tuesday', label: 'Mar' },
    { key: 'wednesday', label: 'Mer' }, { key: 'thursday', label: 'Jeu' },
    { key: 'friday', label: 'Ven' }, { key: 'saturday', label: 'Sam' },
    { key: 'sunday', label: 'Dim' },
  ];

  container.innerHTML = days.map(d => {
    const hours = data[d.key]?.hours ?? 2;
    const minutes = data[d.key]?.minutes ?? 0;
    return `
      <div class="budget-day">
        <span class="budget-day-label">${d.label}</span>
        <div class="budget-day-inputs">
          <input type="number" class="budget-input" data-day="${d.key}" data-unit="hours" min="0" max="24" value="${hours}">h
          <input type="number" class="budget-input" data-day="${d.key}" data-unit="minutes" min="0" max="59" value="${minutes}">min
        </div>
      </div>
    `;
  }).join('');
}

// === Save Profile ===

async function saveProfileForm() {
  const btn = document.getElementById('btn-save-profile');
  btn.disabled = true;
  btn.textContent = 'Enregistrement...';

  try {
    const name = document.getElementById('profile-name').value.trim();
    if (!name) { showToast('Le nom du profil est requis', 'error'); return; }

    const time = document.querySelector('input[name="profile-time"]:checked')?.value || 'unlimited';
    const budget = document.querySelector('input[name="profile-budget"]:checked')?.value || 'unlimited';

    const budgetPerDay = {};
    document.querySelectorAll('.budget-input').forEach(inp => {
      const day = inp.dataset.day;
      const unit = inp.dataset.unit;
      if (!budgetPerDay[day]) budgetPerDay[day] = { hours: 0, minutes: 0 };
      budgetPerDay[day][unit] = parseInt(inp.value) || 0;
    });

    const timerItems = time === 'limited' && _scheduleState ? scheduleGridToTimerItems(_scheduleState) : [];

    const formData = {
      name,
      time,
      budget,
      budgetPerDay,
      shareBudget: document.getElementById('profile-share-budget').checked,
      disallowGuest: document.getElementById('profile-disallow-guest').checked,
      parental: document.getElementById('profile-parental').checked,
      filterType: document.querySelector('input[name="profile-filtertype"]:checked')?.value || 'black',
      netAppsChosen: editingProfile?.netAppsChosen || '',
      timerItems,
    };

    let savedId;
    if (editingProfile) {
      await api('PUT', `/api/profiles/${editingProfile.id}`, formData);
      savedId = editingProfile.id;
    } else {
      const res = await api('POST', '/api/profiles', formData);
      savedId = res.id;
    }

    if (savedId && _selectedProfileIcon) {
      profilesMeta[savedId] = { icon: _selectedProfileIcon };
      await api('POST', '/api/profiles/meta', { meta: profilesMeta });
    }

    showToast(editingProfile ? 'Profil modifie' : 'Profil cree', 'success');
    closeProfileEditor();
    state.filters = null;
    await loadProfiles();
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Enregistrer';
  }
}

// === Delete Profile ===

let _deleteProfilePending = false;
async function deleteProfile(profileId, name) {
  if (_deleteProfilePending) return;
  if (!confirm(`Supprimer le profil "${name}" ?\nLes appareils seront reassignes au profil Standard.`)) return;
  _deleteProfilePending = true;
  try {
    await api('DELETE', `/api/profiles/${profileId}`);
    delete profilesMeta[profileId];
    await api('POST', '/api/profiles/meta', { meta: profilesMeta });
    showToast(`Profil "${name}" supprime`, 'success');
    state.filters = null;
    await loadProfiles();
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 'error');
  } finally {
    _deleteProfilePending = false;
  }
}

// Expose public API
window.loadProfiles = loadProfiles;
window.openProfileEditor = openProfileEditor;
window.closeProfileEditor = closeProfileEditor;
window.saveProfileForm = saveProfileForm;
window.deleteProfile = deleteProfile;
window.switchFilterSubTab = switchFilterSubTab;
window.selectIcon = selectIcon;
window.toggleFilterSection = toggleFilterSection;
window.addWebsiteEntry = addWebsiteEntry;
window.removeWebsiteEntry = removeWebsiteEntry;
})();
