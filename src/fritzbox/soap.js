const axios = require('axios');
const xml2js = require('xml2js');
const crypto = require('crypto');

class FritzSoap {
  constructor(host) {
    this.host = host;
    this.port = 49000;
  }

  get baseUrl() {
    return `http://${this.host}:${this.port}`;
  }

  _buildSoapBody(serviceType, actionName, args) {
    const argsXml = Object.entries(args)
      .map(([key, value]) => `<${key}>${this._escapeXml(String(value))}</${key}>`)
      .join('');

    return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${actionName} xmlns:u="${serviceType}">
      ${argsXml}
    </u:${actionName}>
  </s:Body>
</s:Envelope>`;
  }

  _parseSoapResponse(data, actionName) {
    return xml2js.parseStringPromise(data, {
      explicitArray: false,
      ignoreAttrs: true,
    }).then(parsed => {
      const body = parsed['s:Envelope']['s:Body'];
      const responseKey = `u:${actionName}Response`;
      return body[responseKey] || body;
    });
  }

  async callAuthenticated(controlUrl, serviceType, actionName, username, password, args = {}) {
    const soapBody = this._buildSoapBody(serviceType, actionName, args);
    const url = `${this.baseUrl}${controlUrl}`;
    const headers = {
      'Content-Type': 'text/xml; charset="utf-8"',
      'SoapAction': `${serviceType}#${actionName}`,
    };

    // Step 1: Send request without auth to get Digest challenge
    let wwwAuth;
    try {
      const response = await axios.post(url, soapBody, { headers, timeout: 10000 });
      // No 401 — request succeeded without auth, return directly
      return this._parseSoapResponse(response.data, actionName);
    } catch (err) {
      if (err.response && err.response.status === 401) {
        wwwAuth = err.response.headers['www-authenticate'];
      } else {
        throw err;
      }
    }

    if (!wwwAuth) {
      throw new Error('SOAP 401 without WWW-Authenticate header');
    }

    // Step 2: Parse Digest challenge and compute response
    const digestHeader = this._computeDigestAuth(wwwAuth, username, password, 'POST', controlUrl);

    // Step 3: Retry with Digest Authorization header
    const response = await axios.post(url, soapBody, {
      headers: {
        ...headers,
        'Authorization': digestHeader,
      },
      timeout: 10000,
    });

    return this._parseSoapResponse(response.data, actionName);
  }

  _computeDigestAuth(wwwAuth, username, password, method, uri) {
    // Parse WWW-Authenticate header fields
    const realm = this._extractField(wwwAuth, 'realm');
    const nonce = this._extractField(wwwAuth, 'nonce');
    const qop = this._extractField(wwwAuth, 'qop');
    const algorithm = this._extractField(wwwAuth, 'algorithm') || 'MD5';

    const nc = '00000001';
    const cnonce = crypto.randomBytes(8).toString('hex');

    // HA1 = MD5(username:realm:password)
    const ha1 = crypto.createHash('md5')
      .update(`${username}:${realm}:${password}`)
      .digest('hex');

    // HA2 = MD5(method:uri)
    const ha2 = crypto.createHash('md5')
      .update(`${method}:${uri}`)
      .digest('hex');

    // Response
    let response;
    if (qop) {
      // MD5(HA1:nonce:nc:cnonce:qop:HA2)
      response = crypto.createHash('md5')
        .update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
        .digest('hex');
    } else {
      // MD5(HA1:nonce:HA2)
      response = crypto.createHash('md5')
        .update(`${ha1}:${nonce}:${ha2}`)
        .digest('hex');
    }

    let header = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
    if (qop) {
      header += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
    }
    if (algorithm) {
      header += `, algorithm=${algorithm}`;
    }

    return header;
  }

  _extractField(header, field) {
    const regex = new RegExp(`${field}="?([^",]+)"?`);
    const match = header.match(regex);
    return match ? match[1] : null;
  }

  _escapeXml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}

module.exports = FritzSoap;
