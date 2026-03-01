const express = require('express');

function createDevicesRouter(fritzHosts) {
  const router = express.Router();

  // GET /api/devices - List all devices
  router.get('/', async (req, res) => {
    try {
      const hosts = await fritzHosts.getHostListXml();

      // Enrich with WAN access status
      const enriched = await Promise.all(
        hosts.map(async (host) => {
          let blocked = false;
          if (host.ip) {
            try {
              const access = await fritzHosts.getWANAccessByIP(host.ip);
              blocked = access.disallowed;
            } catch {
              // Host filter service might not be available for all hosts
            }
          }
          return { ...host, blocked };
        })
      );

      res.json({ success: true, devices: enriched });
    } catch (err) {
      console.error('[Devices] Error listing devices:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/devices/:ip/block - Block a device
  router.post('/:ip/block', async (req, res) => {
    try {
      const { ip } = req.params;
      await fritzHosts.disallowWANAccess(ip);
      res.json({ success: true, message: `Device ${ip} blocked` });
    } catch (err) {
      console.error('[Devices] Error blocking device:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/devices/:ip/unblock - Unblock a device
  router.post('/:ip/unblock', async (req, res) => {
    try {
      const { ip } = req.params;
      await fritzHosts.allowWANAccess(ip);
      res.json({ success: true, message: `Device ${ip} unblocked` });
    } catch (err) {
      console.error('[Devices] Error unblocking device:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

module.exports = createDevicesRouter;
