require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const FritzAuth = require('./src/fritzbox/auth');
const FritzHosts = require('./src/fritzbox/hosts');
const FritzFilter = require('./src/fritzbox/filter');
const FritzMonitor = require('./src/fritzbox/monitor');

const FAVORITES_FILE = path.join(__dirname, 'favorites.json');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Auth guard: all /api/* routes except login and status require a valid session
app.use('/api', (req, res, next) => {
  const openRoutes = ['/login', '/logout', '/status'];
  if (openRoutes.includes(req.path)) return next();
  if (!fritzAuth || !fritzAuth.isSessionValid()) {
    return res.status(401).json({ success: false, error: 'Not connected' });
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
    const host = req.body.host || process.env.FRITZ_HOST || '192.168.178.1';
    const username = req.body.username || process.env.FRITZ_USER || '';
    const password = req.body.password || process.env.FRITZ_PASSWORD || '';

    if (!password) {
      return res.status(400).json({ success: false, error: 'Password is required' });
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

// POST /api/filters/block - Block/unblock a device via parental controls
app.post('/api/filters/block', async (req, res) => {
  try {
    const { uid, blocked } = req.body;
    if (!uid) return res.status(400).json({ success: false, error: 'uid is required' });
    await fritzFilter.setDeviceBlocked(uid, blocked);
    res.json({ success: true, message: `Device ${uid} ${blocked ? 'blocked' : 'unblocked'}` });
  } catch (err) {
    console.error('[Filters] Block error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/filters/profile - Change access profile for a device
app.post('/api/filters/profile', async (req, res) => {
  try {
    const { uid, profileId } = req.body;
    if (!uid || !profileId) return res.status(400).json({ success: false, error: 'uid and profileId are required' });
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
    const { name, mac } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Device name is required' });
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
    const newId = await fritzFilter.saveProfile(null, req.body);
    res.json({ success: true, id: newId });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.put('/api/profiles/:id', async (req, res) => {
  try {
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

// POST /api/monitor/start - Start monitoring
app.post('/api/monitor/start', (req, res) => {
  fritzMonitor.start();
  res.json({ success: true, message: 'Monitor started' });
});

// POST /api/monitor/stop - Stop monitoring
app.post('/api/monitor/stop', (req, res) => {
  fritzMonitor.stop();
  res.json({ success: true, message: 'Monitor stopped' });
});

// GET /api/monitor/status - Get monitoring data
app.get('/api/monitor/status', (req, res) => {
  const status = fritzMonitor.getStatus();
  res.json({ success: true, data: status });
});

// GET /api/monitor/profile/:profileId - Get monitoring data for a specific profile
app.get('/api/monitor/profile/:profileId', (req, res) => {
  const status = fritzMonitor.getProfileStats(req.params.profileId);
  res.json({ success: true, data: status });
});

// POST /api/monitor/reset - Reset monitoring data
app.post('/api/monitor/reset', (req, res) => {
  fritzMonitor.resetData();
  res.json({ success: true, message: 'Monitor data reset' });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  Fritz!Box Control Panel`);
  console.log(`  =======================`);
  console.log(`  Server running at http://localhost:${PORT}`);
  console.log(`  Fritz!Box target: ${process.env.FRITZ_HOST || '192.168.178.1'}\n`);
});
