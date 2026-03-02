const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');
const FritzSoap = require('./soap');

const HOSTS_SERVICE = 'urn:dslforum-org:service:Hosts:1';
const HOSTS_CONTROL = '/upnp/control/hosts';
const HOST_FILTER_SERVICE = 'urn:dslforum-org:service:X_AVM-DE_HostFilter:1';
const HOST_FILTER_CONTROL = '/upnp/control/x_hostfilter';
const LAST_SEEN_FILE = path.join(__dirname, '..', '..', 'lastseen-data.json');

class FritzHosts {
  constructor(host, username, password) {
    this.host = host;
    this.username = username;
    this.password = password;
    this.soap = new FritzSoap(host);
    this._lastSeen = this._loadLastSeen();
  }

  _loadLastSeen() {
    try {
      return JSON.parse(fs.readFileSync(LAST_SEEN_FILE, 'utf8'));
    } catch {
      return {};
    }
  }

  _saveLastSeen() {
    try {
      fs.writeFileSync(LAST_SEEN_FILE, JSON.stringify(this._lastSeen, null, 2));
    } catch (err) {
      console.error('[Hosts] Failed to save last seen data:', err.message);
    }
  }

  _updateLastSeen(hosts) {
    const now = Date.now();
    let changed = false;
    for (const h of hosts) {
      const key = h.mac || h.ip;
      if (!key) continue;
      if (h.active) {
        this._lastSeen[key] = now;
        changed = true;
      }
      h.lastSeen = this._lastSeen[key] || null;
    }
    if (changed) this._saveLastSeen();
  }

  async getHostCount() {
    const result = await this.soap.callAuthenticated(
      HOSTS_CONTROL,
      HOSTS_SERVICE,
      'GetHostNumberOfEntries',
      this.username,
      this.password
    );
    return parseInt(result.NewHostNumberOfEntries, 10);
  }

  async getHostByIndex(index) {
    const result = await this.soap.callAuthenticated(
      HOSTS_CONTROL,
      HOSTS_SERVICE,
      'GetGenericHostEntry',
      this.username,
      this.password,
      { NewIndex: index }
    );
    return {
      hostname: result.NewHostName || '',
      ip: result.NewIPAddress || '',
      mac: result.NewMACAddress || '',
      active: result.NewActive === '1',
      interfaceType: result.NewInterfaceType || '',
      addressSource: result.NewAddressSource || '',
    };
  }

  async getAllHosts() {
    const count = await this.getHostCount();
    const hosts = [];
    const BATCH_SIZE = 10;

    for (let i = 0; i < count; i += BATCH_SIZE) {
      const batch = [];
      for (let j = i; j < Math.min(i + BATCH_SIZE, count); j++) {
        batch.push(
          this.getHostByIndex(j).catch(err => {
            console.warn(`[Hosts] Failed to get host at index ${j}:`, err.message);
            return null;
          })
        );
      }
      const results = await Promise.all(batch);
      hosts.push(...results.filter(Boolean));
    }

    this._updateLastSeen(hosts);
    return hosts;
  }

  async getHostListPath() {
    const result = await this.soap.callAuthenticated(
      HOSTS_CONTROL,
      HOSTS_SERVICE,
      'X_AVM-DE_GetHostListPath',
      this.username,
      this.password
    );
    return result['NewX_AVM-DE_HostListPath'];
  }

  async getHostListXml() {
    try {
      const path = await this.getHostListPath();
      console.log(`[Hosts] Host list path: ${path}`);
      const url = `http://${this.host}:49000${path}`;
      const response = await axios.get(url, {
        timeout: 10000,
        auth: { username: this.username, password: this.password },
      });
      const parsed = await xml2js.parseStringPromise(response.data, {
        explicitArray: false,
        ignoreAttrs: true,
      });

      const items = parsed.List.Item;
      const hostArray = Array.isArray(items) ? items : [items];

      const hosts = hostArray.map(item => ({
        hostname: item['X_AVM-DE_FriendlyName'] || item.HostName || '',
        ip: item.IPAddress || '',
        mac: item.MACAddress || '',
        active: item.Active === '1',
        interfaceType: item.InterfaceType || '',
        addressSource: item.AddressSource || '',
        speed: item.X_AVM_DE_Speed || '0',
        port: item.X_AVM_DE_Port || '',
        guest: item.X_AVM_DE_Guest === '1',
      }));
      this._updateLastSeen(hosts);
      return hosts;
    } catch (err) {
      console.error('[Hosts] getHostListXml failed:', err.message);
      // Fallback: get hosts one by one
      console.log('[Hosts] Falling back to GetGenericHostEntry...');
      return this.getAllHosts();
    }
  }

  async disallowWANAccess(ip) {
    await this.soap.callAuthenticated(
      HOST_FILTER_CONTROL,
      HOST_FILTER_SERVICE,
      'DisallowWANAccessByIP',
      this.username,
      this.password,
      { NewIPv4Address: ip, NewDisallow: '1' }
    );
    console.log(`[Hosts] Blocked WAN access for ${ip}`);
  }

  async allowWANAccess(ip) {
    await this.soap.callAuthenticated(
      HOST_FILTER_CONTROL,
      HOST_FILTER_SERVICE,
      'DisallowWANAccessByIP',
      this.username,
      this.password,
      { NewIPv4Address: ip, NewDisallow: '0' }
    );
    console.log(`[Hosts] Allowed WAN access for ${ip}`);
  }

  async getWANAccessByIP(ip) {
    const result = await this.soap.callAuthenticated(
      HOST_FILTER_CONTROL,
      HOST_FILTER_SERVICE,
      'GetWANAccessByIP',
      this.username,
      this.password,
      { NewIPv4Address: ip }
    );
    return {
      disallowed: result.NewDisallow === '1',
      wanAccess: result.NewWANAccess || '',
    };
  }
}

module.exports = FritzHosts;
