const axios = require('axios');

class FritzFilter {
  constructor(auth) {
    this.auth = auth;
    this._cache = null;
    this._cacheTime = 0;
    this._cacheTtl = 30000; // 30s cache
  }

  get baseUrl() {
    return this.auth.baseUrl;
  }

  // Fetch the kidLis HTML page and parse devices + profiles from it
  async getParentalControls(skipCache = false) {
    // Return cached data if fresh enough
    if (!skipCache && this._cache && (Date.now() - this._cacheTime) < this._cacheTtl) {
      console.log('[Filter] Returning cached data');
      return this._cache;
    }

    const sid = await this.auth.ensureSession();

    const response = await axios.post(
      `${this.baseUrl}/data.lua`,
      new URLSearchParams({ sid, xhr: '1', page: 'kidLis' }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 30000,
        // Response is HTML, not JSON
        transformResponse: [(data) => data],
      }
    );

    const html = response.data;
    const result = this._parseKidLisHtml(html);

    // Cache the result
    this._cache = result;
    this._cacheTime = Date.now();

    return result;
  }

  _parseKidLisHtml(html) {
    const devices = [];
    const profiles = new Map();

    // Extract devices from table rows: <a class="js-device-block" data-blocked="..." data-uid="...">
    const deviceRegex = /<td class="name"[^>]*title="([^"]*)"[^>]*>.*?<\/td>\s*<td[^>]*class="block"[^>]*>.*?data-blocked="([^"]*)"[^>]*data-uid="([^"]*)"[^>]*>.*?<\/td>\s*<td[^>]*class="bar time"[^>]*>(.*?)<\/td>\s*<td[^>]*class="usage"[^>]*>.*?<span>(.*?)<\/span>.*?<\/td>\s*<td[^>]*class="profile"[^>]*>(.*?)<\/td>/gs;

    let match;
    while ((match = deviceRegex.exec(html)) !== null) {
      const name = this._decodeHtml(match[1]);
      const blocked = match[2] === 'true';
      const uid = match[3];
      const onlineTime = match[4].trim();
      const usage = match[5].trim();
      const selectHtml = match[6];

      // Extract selected profile from the select element
      const selectedMatch = selectHtml.match(/<option value="([^"]*)" selected>([^<]*)<\/option>/);
      const profileId = selectedMatch ? selectedMatch[1] : '';
      const profileName = selectedMatch ? selectedMatch[2] : '';

      // Extract all available profiles from select options
      const optionRegex = /<option value="([^"]*)"\s*(selected)?>([^<]*)<\/option>/g;
      let optMatch;
      while ((optMatch = optionRegex.exec(selectHtml)) !== null) {
        profiles.set(optMatch[1], optMatch[3]);
      }

      devices.push({ name, uid, blocked, onlineTime, usage, profileId, profileName });
    }

    // If regex didn't match (HTML structure changed), try simpler parsing
    if (devices.length === 0) {
      console.log('[Filter] Complex regex failed, trying simple parsing...');
      return this._parseKidLisSimple(html);
    }

    const profileList = Array.from(profiles.entries()).map(([id, name]) => ({ id, name }));
    console.log(`[Filter] Parsed ${devices.length} devices, ${profileList.length} profiles`);

    return { devices, profiles: profileList };
  }

  _parseKidLisSimple(html) {
    const devices = [];
    const profiles = new Map();

    // Match device blocks: data-blocked="..." data-uid="..."
    const blockRegex = /data-blocked="([^"]*)"[^>]*data-uid="([^"]*)"/g;
    // Match device names from title attributes in td.name
    const nameRegex = /<td class="name"[^>]*title="([^"]*)"/g;
    // Match usage from spans
    const usageRegex = /<td[^>]*class="usage"[^>]*>.*?<span>(.*?)<\/span>/gs;
    // Match selected profiles
    const profileSelRegex = /name="profile:([^"]*)"[^>]*>.*?<option value="([^"]*)" selected>([^<]*)<\/option>/gs;

    // Extract names
    const names = [];
    let m;
    while ((m = nameRegex.exec(html)) !== null) names.push(this._decodeHtml(m[1]));

    // Extract block info
    const blockInfo = [];
    while ((m = blockRegex.exec(html)) !== null) blockInfo.push({ blocked: m[1] === 'true', uid: m[2] });

    // Extract usage
    const usages = [];
    while ((m = usageRegex.exec(html)) !== null) usages.push(m[1].trim());

    // Extract profiles from all selects
    const optionAllRegex = /<option value="([^"]*)"\s*(selected)?>([^<]*)<\/option>/g;
    while ((m = optionAllRegex.exec(html)) !== null) {
      profiles.set(m[1], m[3]);
    }

    // Extract selected profile per device
    const selectedProfiles = [];
    while ((m = profileSelRegex.exec(html)) !== null) {
      selectedProfiles.push({ uid: m[1], profileId: m[2], profileName: m[3] });
    }

    for (let i = 0; i < blockInfo.length; i++) {
      const selProf = selectedProfiles.find(p => p.uid === blockInfo[i].uid);
      devices.push({
        name: names[i] || `Device ${i}`,
        uid: blockInfo[i].uid,
        blocked: blockInfo[i].blocked,
        onlineTime: '',
        usage: usages[i] || '',
        profileId: selProf?.profileId || '',
        profileName: selProf?.profileName || '',
      });
    }

    const profileList = Array.from(profiles.entries()).map(([id, name]) => ({ id, name }));
    console.log(`[Filter] Simple parse: ${devices.length} devices, ${profileList.length} profiles`);

    return { devices, profiles: profileList };
  }

  // Block or unblock a device via the Kindersicherung
  async setDeviceBlocked(uid, blocked) {
    const sid = await this.auth.ensureSession();

    const response = await axios.post(
      `${this.baseUrl}/data.lua`,
      new URLSearchParams({
        sid,
        xhr: '1',
        page: 'kidLis',
        toBeBlocked: uid,
        blocked: blocked ? 'true' : 'false',
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
        transformResponse: [(data) => data],
      }
    );

    this._checkResponse(response.data, 'setDeviceBlocked');
    this._cache = null;
    console.log(`[Filter] Device ${uid} ${blocked ? 'blocked' : 'unblocked'}`);
  }

  // Change access profile for a device
  async setDeviceProfile(uid, profileId) {
    const sid = await this.auth.ensureSession();

    const params = new URLSearchParams({
      sid,
      xhr: '1',
      page: 'kidLis',
      editProfiles: 'true',
      apply: '',
    });
    params.append(`profile:${uid}`, profileId);

    const response = await axios.post(
      `${this.baseUrl}/data.lua`,
      params.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
        transformResponse: [(data) => data],
      }
    );

    this._checkResponse(response.data, 'setDeviceProfile');
    this._cache = null;
    console.log(`[Filter] Device ${uid} profile changed to ${profileId}`);
  }

  // Remove a device from the Fritz!Box network list
  async removeDevice(name, mac) {
    const sid = await this.auth.ensureSession();
    const searchMac = (mac || '').toUpperCase();

    // Step 1: Query all network devices via query.lua (returns clean JSON)
    let landeviceId = null;

    try {
      const queryRes = await axios.get(
        `${this.baseUrl}/query.lua`,
        {
          params: {
            sid,
            network: 'landevice:settings/landevice/list(name,ip,mac,UID)',
          },
          timeout: 15000,
        }
      );

      const devices = queryRes.data?.network || [];
      console.log(`[Filter] query.lua returned ${devices.length} devices`);

      // Match by MAC (most reliable)
      if (searchMac) {
        const match = devices.find(d => (d.mac || '').toUpperCase() === searchMac);
        if (match) {
          landeviceId = match.UID;
          console.log(`[Filter] Found "${name}" by MAC ${searchMac} -> ${landeviceId}`);
        }
      }

      // Fallback: match by name
      if (!landeviceId) {
        const searchName = name.toLowerCase();
        const match = devices.find(d => (d.name || '').toLowerCase() === searchName);
        if (match) {
          landeviceId = match.UID;
          console.log(`[Filter] Found "${name}" by name -> ${landeviceId}`);
        }
      }
    } catch (err) {
      console.error('[Filter] query.lua failed:', err.message);
    }

    if (!landeviceId) {
      throw new Error(`Device "${name}" (${mac || 'no MAC'}) not found in Fritz!Box`);
    }

    // Step 2: Delete the device (2-step: request + confirm)
    console.log(`[Filter] Removing device "${name}" (${landeviceId})...`);
    const postOpts = {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
      transformResponse: [(data) => data],
    };

    // Step 2a: Request deletion → Fritz!Box returns confirmation prompt
    await axios.post(
      `${this.baseUrl}/data.lua`,
      new URLSearchParams({
        sid, xhr: '1', lang: 'de', no_sidrenew: '',
        page: 'netDev',
        delete: landeviceId,
      }).toString(),
      postOpts,
    );

    // Step 2b: Confirm with same request + confirmed= parameter
    await axios.post(
      `${this.baseUrl}/data.lua`,
      new URLSearchParams({
        sid, xhr: '1', lang: 'de', no_sidrenew: '',
        page: 'netDev',
        delete: landeviceId,
        confirmed: '',
      }).toString(),
      postOpts,
    );

    console.log(`[Filter] Device "${name}" (${landeviceId}) deleted`);
    return { landeviceId };
  }

  // Remove ALL inactive devices by deleting them one by one
  async cleanupDevices() {
    let sid = await this.auth.ensureSession();
    const postOpts = {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
      transformResponse: [(data) => data],
    };

    // Get all devices and find inactive ones
    const queryRes = await axios.get(`${this.baseUrl}/query.lua`, {
      params: { sid, network: 'landevice:settings/landevice/list(name,UID,active)' },
      timeout: 15000,
    });
    const allDevices = queryRes.data?.network || [];
    const inactive = allDevices.filter(d => d.active === '0');
    const countBefore = allDevices.length;

    console.log(`[Filter] Cleanup: ${inactive.length} inactive devices out of ${countBefore}`);

    let removed = 0;
    for (const dev of inactive) {
      try {
        // Refresh SID every 10 deletions to avoid expiration during long loops
        if (removed > 0 && removed % 10 === 0) {
          sid = await this.auth.ensureSession();
        }
        // Step 1: request deletion
        await axios.post(
          `${this.baseUrl}/data.lua`,
          new URLSearchParams({
            sid, xhr: '1', lang: 'de', no_sidrenew: '',
            page: 'netDev', delete: dev.UID,
          }).toString(),
          postOpts,
        );
        // Step 2: confirm
        await axios.post(
          `${this.baseUrl}/data.lua`,
          new URLSearchParams({
            sid, xhr: '1', lang: 'de', no_sidrenew: '',
            page: 'netDev', delete: dev.UID, confirmed: '',
          }).toString(),
          postOpts,
        );
        removed++;
        console.log(`[Filter] Cleanup: deleted "${dev.name}" (${dev.UID}) [${removed}/${inactive.length}]`);
      } catch (err) {
        console.error(`[Filter] Cleanup: failed to delete "${dev.name}" (${dev.UID}):`, err.message);
      }
    }

    const countAfter = countBefore - removed;
    console.log(`[Filter] Cleanup: ${countBefore} → ${countAfter} devices (${removed} removed)`);
    this._cache = null;
    return { countBefore, countAfter, removed };
  }

  // === Profile Management ===

  // List all profiles from kidPro page
  async getProfiles() {
    const sid = await this.auth.ensureSession();
    const response = await axios.post(
      `${this.baseUrl}/data.lua`,
      new URLSearchParams({ sid, xhr: '1', lang: 'de', page: 'kidPro', no_sidrenew: '' }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000, transformResponse: [(data) => data] }
    );
    return this._parseKidProHtml(response.data);
  }

  _parseKidProHtml(html) {
    const profiles = [];
    const rowRegex = /<tr[^>]*>(.*?)<\/tr>/gs;
    let match;
    while ((match = rowRegex.exec(html)) !== null) {
      const row = match[1];
      const editMatch = row.match(/name="edit"\s+value="(filtprof\d+)"/);
      if (!editMatch) continue;
      const id = editMatch[1];
      const nameMatch = row.match(/<td[^>]*class="name"[^>]*title="([^"]*)"/) || row.match(/<span>([^<]+)<\/span>/);
      const name = nameMatch ? this._decodeHtml(nameMatch[1]) : id;
      const deleteBtn = row.match(/name="delete"[^>]*value="[^"]*"[^>]*/);
      const deletable = deleteBtn && !deleteBtn[0].includes('disabled');
      // Extract summary columns
      const tdRegex = /<td[^>]*datalabel="([^"]*)"[^>]*>(.*?)<\/td>/gs;
      const cols = {};
      let td;
      while ((td = tdRegex.exec(row)) !== null) {
        cols[td[1]] = td[2].replace(/<[^>]+>/g, '').trim();
      }
      profiles.push({
        id, name, deletable,
        onlineTime: cols['Online Time'] || '',
        budget: cols['Shared Budget'] || '',
        filter: cols['Filter'] || '',
        apps: cols['Blocked Applications'] || '',
      });
    }
    console.log(`[Filter] Parsed ${profiles.length} profiles`);
    return profiles;
  }

  // Get detailed profile settings
  async getProfileDetails(profileId) {
    const sid = await this.auth.ensureSession();
    const response = await axios.post(
      `${this.baseUrl}/data.lua`,
      new URLSearchParams({ sid, xhr: '1', lang: 'de', page: 'kids_profileedit', edit: profileId, no_sidrenew: '' }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000, transformResponse: [(data) => data] }
    );
    return this._parseProfileEditHtml(response.data, profileId);
  }

  _parseProfileEditHtml(html, profileId) {
    const getVal = (name) => {
      const m = html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`));
      return m ? this._decodeHtml(m[1]) : '';
    };
    const getRadio = (name) => {
      const m = html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"[^>]*checked`));
      return m ? m[1] : '';
    };
    const isChecked = (name) => {
      const m = html.match(new RegExp(`name="${name}"[^>]*checked|checked[^>]*name="${name}"`));
      return !!m;
    };

    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const budgetPerDay = {};
    for (const day of days) {
      budgetPerDay[day] = {
        hours: parseInt(getVal(`hours_${day}`)) || 0,
        minutes: parseInt(getVal(`minutes_${day}`)) || 0,
      };
    }

    // Parse timer items
    const timerItems = [];
    const timerRegex = /name="timer_item_\d+"[^>]*value="([^"]*)"/g;
    let tm;
    while ((tm = timerRegex.exec(html)) !== null) {
      const parts = tm[1].split(';');
      if (parts.length >= 3) {
        timerItems.push({ time: parts[0], mode: parseInt(parts[1]), days: parseInt(parts[2]) });
      }
    }

    // Parse assigned devices (checked checkboxes)
    const assignedDevices = [];
    const devRegex = /name="(checkbox_landevice\d+)"[^>]*checked/g;
    let dv;
    while ((dv = devRegex.exec(html)) !== null) {
      assignedDevices.push(dv[1].replace('checkbox_', ''));
    }

    return {
      id: profileId,
      name: getVal('name'),
      time: getRadio('time') || 'unlimited',
      budget: getRadio('budget') || 'unlimited',
      budgetPerDay,
      shareBudget: isChecked('share_budget'),
      disallowGuest: isChecked('disallow_guest'),
      parental: isChecked('parental'),
      filterType: getRadio('filtertype') || 'black',
      netAppsChosen: getVal('netappschosen'),
      timerItems,
      assignedDevices,
    };
  }

  // Save (create or update) a profile
  async saveProfile(profileId, data) {
    const sid = await this.auth.ensureSession();
    const params = new URLSearchParams();
    params.append('sid', sid);
    params.append('xhr', '1');
    params.append('lang', 'de');
    params.append('no_sidrenew', '');
    params.append('page', 'kids_profileedit');
    params.append('edit', profileId || '');
    params.append('apply', '');
    params.append('back_to_page', '/internet/kids_profilelist.lua');
    params.append('name', data.name);
    params.append('time', data.time || 'unlimited');
    params.append('budget', data.budget || 'unlimited');

    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    for (const day of days) {
      params.append(`hours_${day}`, String(data.budgetPerDay?.[day]?.hours ?? 24));
      params.append(`minutes_${day}`, String(data.budgetPerDay?.[day]?.minutes ?? 0));
    }

    if (data.shareBudget) params.append('share_budget', 'on');
    if (data.disallowGuest) params.append('disallow_guest', 'on');
    if (data.parental) params.append('parental', 'on');
    if (data.parental) params.append('filtertype', data.filterType || 'black');
    params.append('netappschosen', data.netAppsChosen || '');

    if (data.timerItems) {
      data.timerItems.forEach((item, i) => {
        params.append(`timer_item_${i}`, `${item.time};${item.mode};${item.days}`);
      });
    }

    const response = await axios.post(
      `${this.baseUrl}/data.lua`, params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000, transformResponse: [(data) => data] }
    );

    const body = response.data || '';
    console.log(`[Filter] saveProfile response: ${body.substring(0, 200)}`);
    this._cache = null;

    // For new profiles, find the new ID by comparing profile lists
    if (!profileId) {
      try {
        const profiles = await this.getProfiles();
        const newProfile = profiles.find(p => p.name === data.name);
        return newProfile ? newProfile.id : null;
      } catch { return null; }
    }
    return profileId;
  }

  // Delete a profile (single step, no confirmation)
  async deleteProfile(profileId) {
    const sid = await this.auth.ensureSession();
    await axios.post(
      `${this.baseUrl}/data.lua`,
      new URLSearchParams({ sid, xhr: '1', lang: 'de', page: 'kidPro', delete: profileId, no_sidrenew: '' }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000, transformResponse: [(data) => data] }
    );
    console.log(`[Filter] Profile ${profileId} deleted`);
    this._cache = null;
  }

  // Get website blacklist or whitelist (returns clean JSON)
  async getWebsiteList(listType) {
    const sid = await this.auth.ensureSession();
    const page = listType === 'white' ? 'kids_whitelist' : 'kids_blacklist';
    const response = await axios.post(
      `${this.baseUrl}/data.lua`,
      new URLSearchParams({ sid, xhr: '1', lang: 'de', page, listtype: listType, no_sidrenew: '' }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
    );
    return response.data?.data || { list: [], listcount: 0 };
  }

  // Save the entire website list (full replace via urllist parameter with \r separator)
  async saveWebsiteList(listType, urls) {
    const sid = await this.auth.ensureSession();
    const page = listType === 'white' ? 'kids_whitelist' : 'kids_blacklist';
    const urllist = urls.map(u => u.trim()).filter(Boolean).join('\r') + '\r';

    const response = await axios.post(
      `${this.baseUrl}/data.lua`,
      new URLSearchParams({ sid, xhr: '1', lang: 'de', page, listtype: listType, no_sidrenew: '', apply: '', urllist }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
    );

    const result = response.data?.data || {};
    if (result.apply !== 'ok') {
      throw new Error('Fritz!Box did not confirm the website list update');
    }
    console.log(`[Filter] Website ${listType}list saved (${urls.length} entries)`);
    return result;
  }

  // Sanity-check data.lua responses (always HTTP 200, so check body for login redirect)
  _checkResponse(body, context) {
    if (typeof body === 'string' && body.includes('"sid":"0000000000000000"')) {
      throw new Error(`Fritz!Box session expired during ${context}`);
    }
  }

  _decodeHtml(str) {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }
}

module.exports = FritzFilter;
