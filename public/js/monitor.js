(function() {
'use strict';

let monitorRefreshTimer = null;
let _monitorPolling = false;

async function loadMonitorData() {
  try {
    const res = await api('GET', API.MONITOR_STATUS);
    const data = res.data;

    updateMonitorUI(data);

    // Also populate profile filter dropdown if needed
    populateProfileFilter();

    // Auto-refresh every 15s if monitoring is running
    clearInterval(monitorRefreshTimer);
    if (data.running) {
      monitorRefreshTimer = setInterval(async () => {
        const activeTab = document.querySelector('.tab.active')?.dataset.tab;
        if (activeTab !== 'monitor') {
          clearInterval(monitorRefreshTimer);
          return;
        }
        if (_monitorPolling) return;
        _monitorPolling = true;
        try {
          const r = await api('GET', API.MONITOR_STATUS);
          updateMonitorUI(r.data);
        } catch (e) { /* ignore */ }
        finally { _monitorPolling = false; }
      }, 15000);
    }
  } catch (err) {
    document.getElementById('monitor-devices').innerHTML =
      `<div class="empty-state">Erreur : ${escapeHtml(err.message)}</div>`;
  }
}

function updateMonitorUI(data) {
  const btn = document.getElementById('monitor-toggle-btn');
  const statusText = document.getElementById('monitor-status-text');
  const summary = document.getElementById('monitor-summary');
  const container = document.getElementById('monitor-devices');

  if (data.running) {
    btn.textContent = 'Arrêter le monitoring';
    btn.className = 'btn-monitor-stop';
    statusText.textContent = 'En cours...';
    statusText.className = 'monitor-status-text running';
  } else {
    btn.textContent = 'Démarrer le monitoring';
    btn.className = 'btn-monitor-start';
    statusText.textContent = 'Arrêté';
    statusText.className = 'monitor-status-text';
  }

  const profileFilter = document.getElementById('monitor-profile-filter').value;
  let devices = data.devices || [];
  if (profileFilter !== 'all') {
    devices = devices.filter(d => d.profileId === profileFilter);
  }

  if (devices.length === 0) {
    summary.classList.add('hidden');
    container.innerHTML = data.running
      ? '<div class="empty-state">Aucun appareil détecté pour le moment. Les données apparaîtront au prochain sondage.</div>'
      : '<div class="empty-state">Démarrez le monitoring pour suivre le temps en ligne des appareils</div>';
    return;
  }

  const onlineCount = devices.filter(d => d.isOnline).length;
  const totalTodayMs = devices.reduce((sum, d) => sum + d.todayMs, 0);
  summary.classList.remove('hidden');
  summary.innerHTML = `
    <div class="summary-stat">
      <span class="summary-value">${onlineCount}</span>
      <span class="summary-label">En ligne</span>
    </div>
    <div class="summary-stat">
      <span class="summary-value">${devices.length}</span>
      <span class="summary-label">Appareils suivis</span>
    </div>
    <div class="summary-stat">
      <span class="summary-value">${formatDuration(totalTodayMs)}</span>
      <span class="summary-label">Temps total aujourd'hui</span>
    </div>
    ${data.lastPoll ? `<div class="summary-stat">
      <span class="summary-value">${new Date(data.lastPoll).toLocaleTimeString('fr-FR')}</span>
      <span class="summary-label">Dernier sondage</span>
    </div>` : ''}
  `;

  container.innerHTML = devices.map(device => {
    const onlineClass = device.isOnline ? 'monitor-online' : '';
    const sessionInfo = device.isOnline && device.currentSessionStart
      ? `<span class="session-live">Session en cours : ${formatDuration(Date.now() - device.currentSessionStart)}</span>`
      : '';

    const historyHtml = buildHistoryBars(device.dailyHistory);

    return `
      <div class="device-card monitor-card ${onlineClass}">
        <div class="device-info">
          <div class="device-name">
            <span class="device-status ${device.isOnline ? 'online' : 'offline'}"></span>
            ${escapeHtml(device.name)}
          </div>
          <div class="device-details">
            <span>Profil: <strong>${escapeHtml(device.profileName)}</strong></span>
            ${device.isOnline ? '<span class="badge-online">EN LIGNE</span>' : ''}
          </div>
          <div class="monitor-times">
            <div class="time-row">
              <span class="time-label">Aujourd'hui</span>
              <span class="time-value">${device.todayFormatted}</span>
            </div>
            <div class="time-row">
              <span class="time-label">Total (30 jours)</span>
              <span class="time-value">${device.totalFormatted}</span>
            </div>
            ${sessionInfo}
          </div>
          ${historyHtml}
        </div>
      </div>
    `;
  }).join('');
}

function buildHistoryBars(dailyHistory) {
  if (!dailyHistory || Object.keys(dailyHistory).length === 0) return '';

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    const dayName = d.toLocaleDateString('fr-FR', { weekday: 'short' });
    days.push({ key, dayName, ms: dailyHistory[key] || 0 });
  }

  const maxMs = Math.max(...days.map(d => d.ms), 3600000);

  const bars = days.map(day => {
    const pct = Math.max((day.ms / maxMs) * 100, 2);
    const label = day.ms > 0 ? formatDuration(day.ms) : '';
    return `
      <div class="history-bar-col">
        <div class="history-bar-track">
          <div class="history-bar-fill" style="height:${pct}%" title="${day.dayName}: ${label || '0'}"></div>
        </div>
        <span class="history-bar-day">${day.dayName}</span>
      </div>
    `;
  }).join('');

  return `<div class="history-bars">${bars}</div>`;
}

function formatDuration(ms) {
  if (ms < 60000) return '< 1 min';
  const totalMin = Math.floor(ms / 60000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours === 0) return `${mins} min`;
  return `${hours}h ${mins.toString().padStart(2, '0')}min`;
}

async function toggleMonitor() {
  const btn = document.getElementById('monitor-toggle-btn');
  const isRunning = btn.className === 'btn-monitor-stop';
  btn.disabled = true;

  try {
    if (isRunning) {
      await api('POST', API.MONITOR_STOP);
      showToast('Monitoring arrêté', 'info');
      clearInterval(monitorRefreshTimer);
    } else {
      await api('POST', API.MONITOR_START);
      showToast('Monitoring démarré', 'success');
    }
    await loadMonitorData();
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

function cleanupMonitor() {
  if (monitorRefreshTimer) {
    clearInterval(monitorRefreshTimer);
    monitorRefreshTimer = null;
  }
  _monitorPolling = false;
}

async function populateProfileFilter() {
  const select = document.getElementById('monitor-profile-filter');
  if (select.options.length > 1) return;

  try {
    if (state.filters && state.filters.profiles) {
      state.filters.profiles.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        select.appendChild(opt);
      });
    } else {
      const res = await api('GET', API.FILTERS);
      if (res.data && res.data.profiles) {
        res.data.profiles.forEach(p => {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = p.name;
          select.appendChild(opt);
        });
      }
    }
  } catch (e) { /* ignore */ }
}

// Expose public API
window.loadMonitorData = loadMonitorData;
window.toggleMonitor = toggleMonitor;
window.cleanupMonitor = cleanupMonitor;
})();
