const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', '..', 'monitor-data.json');
const POLL_INTERVAL = 30000; // 30 seconds

class FritzMonitor {
  constructor(fritzFilter, fritzHosts) {
    this.fritzFilter = fritzFilter;
    this.fritzHosts = fritzHosts;
    this.timer = null;
    this.running = false;
    this._polling = false;

    // { "device-uid": { name, profileId, profileName, sessions: [{ start, end }], totalToday: ms, totalAll: ms } }
    this.deviceData = {};
    // Track currently online devices
    this.onlineDevices = new Set();
    // Last poll timestamp
    this.lastPoll = null;

    this._loadData();
  }

  start() {
    if (this.running) return;
    this.running = true;
    console.log('[Monitor] Started (polling every 30s)');
    this._poll();
    this.timer = setInterval(() => this._poll(), POLL_INTERVAL);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Close all open sessions
    const now = Date.now();
    for (const uid of this.onlineDevices) {
      this._endSession(uid, now);
    }
    this.onlineDevices.clear();
    this._saveData();
    console.log('[Monitor] Stopped');
  }

  async _poll() {
    if (this._polling) return;
    this._polling = true;
    try {
      const now = Date.now();

      // Get active devices from TR-064
      const hosts = await this.fritzHosts.getHostListXml();
      const hostByName = new Map(hosts.map(h => [h.hostname, h]));

      // Get parental control data
      const kidData = await this.fritzFilter.getParentalControls();
      const devices = kidData.devices || [];

      // Check which monitored devices are currently online
      const currentlyOnline = new Set();

      for (const dev of devices) {
        // Check if this device is online by matching hostname to active hosts
        const host = hostByName.get(dev.name);
        const isOnline = host ? host.active : false;

        // Initialize device data if needed
        if (!this.deviceData[dev.uid]) {
          this.deviceData[dev.uid] = {
            name: dev.name,
            uid: dev.uid,
            profileId: dev.profileId,
            profileName: dev.profileName,
            sessions: [],
            dailyHistory: {},
          };
        }

        const dd = this.deviceData[dev.uid];
        dd.name = dev.name;
        dd.profileId = dev.profileId;
        dd.profileName = dev.profileName;

        if (isOnline) {
          currentlyOnline.add(dev.uid);

          if (!this.onlineDevices.has(dev.uid)) {
            // Device just came online - start session
            this._startSession(dev.uid, now);
          }
        } else {
          if (this.onlineDevices.has(dev.uid)) {
            // Device just went offline - end session
            this._endSession(dev.uid, now);
          }
        }
      }

      // Handle devices that disappeared from the list
      for (const uid of this.onlineDevices) {
        if (!currentlyOnline.has(uid)) {
          this._endSession(uid, now);
        }
      }

      this.onlineDevices = currentlyOnline;
      this.lastPoll = now;
      this._saveData();
    } catch (err) {
      console.error('[Monitor] Poll error:', err.message);
    } finally {
      this._polling = false;
    }
  }

  _startSession(uid, timestamp) {
    const dd = this.deviceData[uid];
    if (!dd) return;
    dd.sessions.push({ start: timestamp, end: null });
    console.log(`[Monitor] ${dd.name} came ONLINE`);
  }

  _endSession(uid, timestamp) {
    const dd = this.deviceData[uid];
    if (!dd) return;

    const openSession = dd.sessions.find(s => s.end === null);
    if (openSession) {
      openSession.end = timestamp;
      const duration = timestamp - openSession.start;

      // Add to daily history
      const day = new Date(timestamp).toISOString().split('T')[0];
      dd.dailyHistory[day] = (dd.dailyHistory[day] || 0) + duration;

      const mins = Math.round(duration / 60000);
      console.log(`[Monitor] ${dd.name} went OFFLINE (session: ${mins} min)`);
    }
  }

  getStatus() {
    const now = Date.now();
    const today = new Date().toISOString().split('T')[0];

    const devices = Object.values(this.deviceData).map(dd => {
      const isOnline = this.onlineDevices.has(dd.uid);

      // Calculate today's total
      let todayMs = dd.dailyHistory[today] || 0;

      // Add current open session duration
      if (isOnline) {
        const openSession = dd.sessions.find(s => s.end === null);
        if (openSession) {
          todayMs += now - openSession.start;
        }
      }

      // Calculate total all time
      let totalMs = Object.values(dd.dailyHistory).reduce((sum, ms) => sum + ms, 0);
      if (isOnline) {
        const openSession = dd.sessions.find(s => s.end === null);
        if (openSession) {
          totalMs += now - openSession.start;
        }
      }

      return {
        name: dd.name,
        uid: dd.uid,
        profileId: dd.profileId,
        profileName: dd.profileName,
        isOnline,
        todayMs,
        todayFormatted: this._formatDuration(todayMs),
        totalMs,
        totalFormatted: this._formatDuration(totalMs),
        dailyHistory: dd.dailyHistory,
        currentSessionStart: isOnline ? dd.sessions.find(s => s.end === null)?.start : null,
      };
    });

    // Sort: online first, then by today's usage desc
    devices.sort((a, b) => {
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
      return b.todayMs - a.todayMs;
    });

    return {
      running: this.running,
      lastPoll: this.lastPoll,
      onlineCount: this.onlineDevices.size,
      devices,
    };
  }

  // Get stats filtered by profile
  getProfileStats(profileId) {
    const status = this.getStatus();
    return {
      ...status,
      devices: status.devices.filter(d => d.profileId === profileId),
    };
  }

  resetData() {
    this.deviceData = {};
    this.onlineDevices.clear();
    this._saveData();
    console.log('[Monitor] Data reset');
  }

  _formatDuration(ms) {
    if (ms < 60000) return '< 1 min';
    const totalMin = Math.floor(ms / 60000);
    const hours = Math.floor(totalMin / 60);
    const mins = totalMin % 60;
    if (hours === 0) return `${mins} min`;
    return `${hours}h ${mins.toString().padStart(2, '0')}min`;
  }

  _loadData() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        const saved = JSON.parse(raw);
        this.deviceData = saved.deviceData || {};
        // Clean up old sessions (close any that were left open)
        for (const dd of Object.values(this.deviceData)) {
          for (const session of dd.sessions) {
            if (session.end === null) {
              session.end = session.start; // Close stale sessions with 0 duration
            }
          }
          // Keep only last 30 days of history
          const cutoff = new Date();
          cutoff.setDate(cutoff.getDate() - 30);
          const cutoffStr = cutoff.toISOString().split('T')[0];
          for (const day of Object.keys(dd.dailyHistory)) {
            if (day < cutoffStr) delete dd.dailyHistory[day];
          }
          // Keep only last 100 sessions
          if (dd.sessions.length > 100) {
            dd.sessions = dd.sessions.slice(-100);
          }
        }
        console.log(`[Monitor] Loaded data for ${Object.keys(this.deviceData).length} devices`);
      }
    } catch (err) {
      console.warn('[Monitor] Could not load data:', err.message);
    }
  }

  _saveData() {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify({ deviceData: this.deviceData }, null, 2));
    } catch (err) {
      console.warn('[Monitor] Could not save data:', err.message);
    }
  }
}

module.exports = FritzMonitor;
