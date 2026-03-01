const express = require('express');

function createFiltersRouter(fritzFilter) {
  const router = express.Router();

  // GET /api/filters - Get current URL filter lists
  router.get('/', async (req, res) => {
    try {
      const filters = await fritzFilter.getUrlList();
      res.json({ success: true, filters });
    } catch (err) {
      console.error('[Filters] Error getting filters:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/filters - Add a URL to the blacklist
  router.post('/', async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) {
        return res.status(400).json({ success: false, error: 'URL is required' });
      }
      await fritzFilter.addUrlToBlacklist(url);
      res.json({ success: true, message: `URL ${url} added to blacklist` });
    } catch (err) {
      console.error('[Filters] Error adding filter:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // DELETE /api/filters - Remove a URL from the blacklist
  router.delete('/', async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) {
        return res.status(400).json({ success: false, error: 'URL is required' });
      }
      await fritzFilter.removeUrlFromBlacklist(url);
      res.json({ success: true, message: `URL ${url} removed from blacklist` });
    } catch (err) {
      console.error('[Filters] Error removing filter:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/filters/profiles - Get access profiles
  router.get('/profiles', async (req, res) => {
    try {
      const profiles = await fritzFilter.getAccessProfiles();
      res.json({ success: true, profiles });
    } catch (err) {
      console.error('[Filters] Error getting profiles:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

module.exports = createFiltersRouter;
