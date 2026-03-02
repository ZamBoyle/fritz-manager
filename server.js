require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const FritzAuth = require('./src/fritzbox/auth');
const FritzHosts = require('./src/fritzbox/hosts');
const FritzFilter = require('./src/fritzbox/filter');
const FritzMonitor = require('./src/fritzbox/monitor');

const FAVORITES_FILE = path.join(__dirname, 'favorites.json');

// Rate limiter for login (in-memory, 5 attempts per minute per IP)
const loginAttempts = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 5;

function checkLoginRate(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record || now > record.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  record.count++;
  return record.count <= RATE_LIMIT_MAX;
}

// Cleanup stale rate-limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of loginAttempts) {
    if (now > record.resetAt) loginAttempts.delete(ip);
  }
}, 300000).unref();

// Input sanitization helper
function sanitizeString(str, maxLen = 200) {
  if (typeof str !== 'string') return null;
  return str.trim().substring(0, maxLen);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Security headers via helmet (CSP disabled - we set a custom one below)
app.use(helmet({ contentSecurityPolicy: false }));

// Custom Content Security Policy
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; " +
    "connect-src 'self'; " +
    "font-src 'self'"
  );
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Auth guard: all /api/* routes except login and status require a valid session
// Auto-refreshes the Fritz!Box SID if it's about to expire
app.use('/api', async (req, res, next) => {
  const openRoutes = ['/login', '/logout', '/status'];
  if (openRoutes.includes(req.path)) return next();
  if (!fritzAuth) {
    return res.status(401).json({ success: false, error: 'Not connected' });
  }
  try {
    await fritzAuth.ensureSession();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Session expired. Please reconnect.' });
  }
  next();
});

// Fritz!Box instances (initialized on login)
let fritzAuth = null;
let fritzHosts = null;
let fritzFilter = null;
let fritzMonitor = null;

// POST /api/login - Connect to Fritz!Box
app.post('/api/login', async (req, res) => {
  try {
    // Rate limiting
    if (!checkLoginRate(req.ip)) {
      return res.status(429).json({ success: false, error: 'Trop de tentatives. Réessayez dans 1 minute.' });
    }

    const host = sanitizeString(req.body.host) || process.env.FRITZ_HOST || '192.168.178.1';
    const username = sanitizeString(req.body.username) || process.env.FRITZ_USER || '';
    const password = sanitizeString(req.body.password, 500) || process.env.FRITZ_PASSWORD || '';

    if (!host || !password) {
      return res.status(400).json({ success: false, error: 'Invalid input' });
    }

    if (fritzAuth && fritzAuth.isSessionValid()) {
      console.warn(`[Server] Overwriting existing session (host: ${fritzAuth.host})`);
    }

    fritzAuth = new FritzAuth(host, username, password);
    const sid = await fritzAuth.getSessionId();

    fritzHosts = new FritzHosts(host, username, password);
    fritzFilter = new FritzFilter(fritzAuth);

    // Stop previous monitor if any
    if (fritzMonitor) fritzMonitor.stop();
    fritzMonitor = new FritzMonitor(fritzFilter, fritzHosts);

    console.log(`[Server] Connected to Fritz!Box at ${host}`);
    res.json({ success: true, message: 'Connected to Fritz!Box', sid: sid.substring(0, 8) + '...' });
  } catch (err) {
    console.error('[Server] Login failed:', err.message);
    res.status(401).json({ success: false, error: err.message });
  }
});

// GET /api/status
app.get('/api/status', (req, res) => {
  const connected = fritzAuth && fritzAuth.isSessionValid();
  res.json({ connected, host: fritzAuth ? fritzAuth.host : null });
});

// === Devices API ===

// POST /api/logout - Disconnect and clean up
app.post('/api/logout', (req, res) => {
  if (fritzMonitor) fritzMonitor.stop();
  fritzAuth = null;
  fritzHosts = null;
  fritzFilter = null;
  fritzMonitor = null;
  console.log('[Server] Session closed');
  res.json({ success: true });
});

// GET /api/devices
app.get('/api/devices', async (req, res) => {
  try {
    const hosts = await fritzHosts.getHostListXml();
    res.json({ success: true, devices: hosts.map(h => ({ ...h, blocked: false })) });
  } catch (err) {
    console.error('[Devices] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/devices/:ip/status - Get WAN access status for one device
app.get('/api/devices/:ip/status', async (req, res) => {
  try {
    const access = await fritzHosts.getWANAccessByIP(req.params.ip);
    res.json({ success: true, blocked: access.disallowed });
  } catch (err) {
    res.json({ success: true, blocked: false });
  }
});

// POST /api/devices/:ip/block
app.post('/api/devices/:ip/block', async (req, res) => {
  try {
    await fritzHosts.disallowWANAccess(req.params.ip);
    res.json({ success: true, message: `Device ${req.params.ip} blocked` });
  } catch (err) {
    console.error('[Devices] Block error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/devices/:ip/unblock
app.post('/api/devices/:ip/unblock', async (req, res) => {
  try {
    await fritzHosts.allowWANAccess(req.params.ip);
    res.json({ success: true, message: `Device ${req.params.ip} unblocked` });
  } catch (err) {
    console.error('[Devices] Unblock error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// === Filters API ===

// GET /api/filters - Get parental controls data
app.get('/api/filters', async (req, res) => {
  try {
    const result = await fritzFilter.getParentalControls();
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[Filters] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/filters/block - Block/unblock device(s) via parental controls
// Accepts { uids: [...], blocked: bool } — multiple UIDs for Fritz!Box duplicate entries
app.post('/api/filters/block', async (req, res) => {
  try {
    const uids = (Array.isArray(req.body.uids) ? req.body.uids : [req.body.uid]).map(s => sanitizeString(s)).filter(Boolean);
    const blocked = req.body.blocked;
    if (uids.length === 0 || typeof blocked !== 'boolean') {
      return res.status(400).json({ success: false, error: 'Invalid input' });
    }

    for (const uid of uids) {
      await fritzFilter.setDeviceBlocked(uid, blocked);
    }

    // When unblocking, Fritz!Box may have created extra user* entries during blocking
    // that the frontend doesn't know about. Use the device name (sent by frontend) to find them.
    if (!blocked && req.body.name) {
      const name = sanitizeString(req.body.name);
      const data = await fritzFilter.getParentalControls(true);
      const remaining = data.devices.filter(d => d.name === name && d.blocked && !uids.includes(d.uid));
      for (const dup of remaining) {
        await fritzFilter.setDeviceBlocked(dup.uid, false);
        console.log(`[Filters] Also unblocked ${dup.uid} for "${dup.name}"`);
      }
    }

    res.json({ success: true, message: `${uids.length} device(s) ${blocked ? 'blocked' : 'unblocked'}` });
  } catch (err) {
    console.error('[Filters] Block error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/filters/profile - Change access profile for a device
app.post('/api/filters/profile', async (req, res) => {
  try {
    const uid = sanitizeString(req.body.uid);
    const profileId = sanitizeString(req.body.profileId);
    if (!uid || !profileId) {
      return res.status(400).json({ success: false, error: 'Invalid input' });
    }
    await fritzFilter.setDeviceProfile(uid, profileId);
    res.json({ success: true, message: `Profile changed for ${uid}` });
  } catch (err) {
    console.error('[Filters] Profile error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/devices/remove - Remove a device from Fritz!Box
app.post('/api/devices/remove', async (req, res) => {
  try {
    const name = sanitizeString(req.body.name);
    const mac = sanitizeString(req.body.mac);
    if (!name || !mac) {
      return res.status(400).json({ success: false, error: 'Invalid input' });
    }
    const result = await fritzFilter.removeDevice(name, mac);
    res.json({ success: true, message: `Device "${name}" removed`, ...result });
  } catch (err) {
    console.error('[Devices] Remove error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/devices/cleanup - Remove all inactive devices (Fritz!Box built-in cleanup)
app.post('/api/devices/cleanup', async (req, res) => {
  try {
    const result = await fritzFilter.cleanupDevices();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Devices] Cleanup error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// === Profiles API ===

const PROFILE_META_FILE = path.join(__dirname, 'profile-meta.json');

// Static routes first (before :id param routes)
app.get('/api/profiles/meta', (req, res) => {
  try {
    const data = fs.existsSync(PROFILE_META_FILE) ? JSON.parse(fs.readFileSync(PROFILE_META_FILE, 'utf8')) : {};
    res.json({ success: true, meta: data });
  } catch { res.json({ success: true, meta: {} }); }
});

app.post('/api/profiles/meta', (req, res) => {
  try {
    fs.writeFileSync(PROFILE_META_FILE, JSON.stringify(req.body.meta || {}, null, 2));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/profiles/websites/:type', async (req, res) => {
  if (req.params.type !== 'black' && req.params.type !== 'white') {
    return res.status(400).json({ success: false, error: 'type must be "black" or "white"' });
  }
  try {
    const data = await fritzFilter.getWebsiteList(req.params.type);
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.put('/api/profiles/websites/:type', async (req, res) => {
  if (req.params.type !== 'black' && req.params.type !== 'white') {
    return res.status(400).json({ success: false, error: 'type must be "black" or "white"' });
  }
  try {
    const { urls } = req.body;
    if (!Array.isArray(urls)) return res.status(400).json({ success: false, error: 'urls must be an array' });
    await fritzFilter.saveWebsiteList(req.params.type, urls);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// CRUD routes
app.get('/api/profiles', async (req, res) => {
  try {
    const data = await fritzFilter.getProfiles();
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/profiles/:id', async (req, res) => {
  try {
    const data = await fritzFilter.getProfileDetails(req.params.id);
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/profiles', async (req, res) => {
  try {
    if (!sanitizeString(req.body.name)) {
      return res.status(400).json({ success: false, error: 'Invalid input' });
    }
    const newId = await fritzFilter.saveProfile(null, req.body);
    res.json({ success: true, id: newId });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.put('/api/profiles/:id', async (req, res) => {
  try {
    if (!sanitizeString(req.body.name)) {
      return res.status(400).json({ success: false, error: 'Invalid input' });
    }
    await fritzFilter.saveProfile(req.params.id, req.body);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/api/profiles/:id', async (req, res) => {
  try {
    await fritzFilter.deleteProfile(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// === Favorites API ===

// GET /api/favorites - Get favorite MACs
app.get('/api/favorites', (req, res) => {
  try {
    const data = fs.existsSync(FAVORITES_FILE)
      ? JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf8'))
      : [];
    res.json({ success: true, favorites: data });
  } catch {
    res.json({ success: true, favorites: [] });
  }
});

// POST /api/favorites - Save favorite MACs
app.post('/api/favorites', (req, res) => {
  try {
    const { favorites } = req.body;
    fs.writeFileSync(FAVORITES_FILE, JSON.stringify(favorites || [], null, 2));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// === Monitor API ===

// Monitor guard helper (fritzMonitor can be null after logout race)
function requireMonitor(req, res, next) {
  if (!fritzMonitor) return res.status(400).json({ success: false, error: 'Monitor not initialized' });
  next();
}

// POST /api/monitor/start - Start monitoring
app.post('/api/monitor/start', requireMonitor, (req, res) => {
  fritzMonitor.start();
  res.json({ success: true, message: 'Monitor started' });
});

// POST /api/monitor/stop - Stop monitoring
app.post('/api/monitor/stop', requireMonitor, (req, res) => {
  fritzMonitor.stop();
  res.json({ success: true, message: 'Monitor stopped' });
});

// GET /api/monitor/status - Get monitoring data
app.get('/api/monitor/status', requireMonitor, (req, res) => {
  const status = fritzMonitor.getStatus();
  res.json({ success: true, data: status });
});

// GET /api/monitor/profile/:profileId - Get monitoring data for a specific profile
app.get('/api/monitor/profile/:profileId', requireMonitor, (req, res) => {
  const status = fritzMonitor.getProfileStats(req.params.profileId);
  res.json({ success: true, data: status });
});

// POST /api/monitor/reset - Reset monitoring data
app.post('/api/monitor/reset', requireMonitor, (req, res) => {
  fritzMonitor.resetData();
  res.json({ success: true, message: 'Monitor data reset' });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler (prevents stack trace leaks)
app.use((err, req, res, _next) => {
  console.error('[Server] Unhandled error:', err.message);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`\n  Fritz!Box Control Panel`);
  console.log(`  =======================`);
  console.log(`  Server running at http://localhost:${PORT}`);
  console.log(`  Fritz!Box target: ${process.env.FRITZ_HOST || '192.168.178.1'}\n`);
});
