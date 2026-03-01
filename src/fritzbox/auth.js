const crypto = require('crypto');
const axios = require('axios');
const xml2js = require('xml2js');

class FritzAuth {
  constructor(host, username, password) {
    this.host = host;
    this.username = username;
    this.password = password;
    this.sid = '0000000000000000';
    this.sidTimestamp = 0;
  }

  get baseUrl() {
    return `http://${this.host}`;
  }

  isSessionValid() {
    // SID expires after 20 minutes
    return this.sid !== '0000000000000000' && (Date.now() - this.sidTimestamp) < 19 * 60 * 1000;
  }

  async getSessionId() {
    if (this.isSessionValid()) {
      return this.sid;
    }

    // Step 1: Get challenge
    const challengeRes = await axios.get(`${this.baseUrl}/login_sid.lua?version=2`);
    const parsed = await xml2js.parseStringPromise(challengeRes.data);
    const sessionInfo = parsed.SessionInfo;

    const blockTime = parseInt(sessionInfo.BlockTime[0], 10);
    if (blockTime > 0) {
      throw new Error(`Login blocked for ${blockTime} seconds. Too many failed attempts.`);
    }

    const challenge = sessionInfo.Challenge[0];

    // Step 2: Compute response
    let response;
    if (challenge.startsWith('2$')) {
      // PBKDF2 challenge (FRITZ!OS 7.24+)
      response = await this._solvePbkdf2Challenge(challenge);
    } else {
      // MD5 fallback
      response = this._solveMd5Challenge(challenge);
    }

    // Step 3: Send login request
    const loginRes = await axios.post(
      `${this.baseUrl}/login_sid.lua?version=2`,
      `username=${encodeURIComponent(this.username)}&response=${response}`,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const loginParsed = await xml2js.parseStringPromise(loginRes.data);
    const sid = loginParsed.SessionInfo.SID[0];

    if (sid === '0000000000000000') {
      throw new Error('Authentication failed. Check your username and password.');
    }

    this.sid = sid;
    this.sidTimestamp = Date.now();
    console.log(`[Auth] Session established: ${sid.substring(0, 8)}...`);
    return this.sid;
  }

  async _solvePbkdf2Challenge(challenge) {
    // Format: 2$<iter1>$<salt1>$<iter2>$<salt2>
    const parts = challenge.split('$');
    const iter1 = parseInt(parts[1], 10);
    const salt1 = Buffer.from(parts[2], 'hex');
    const iter2 = parseInt(parts[3], 10);
    const salt2 = Buffer.from(parts[4], 'hex');

    // Step 1: hash1 = PBKDF2(password, salt1, iter1, 32, sha256)
    const hash1 = crypto.pbkdf2Sync(this.password, salt1, iter1, 32, 'sha256');

    // Step 2: hash2 = PBKDF2(hash1, salt2, iter2, 32, sha256)
    const hash2 = crypto.pbkdf2Sync(hash1, salt2, iter2, 32, 'sha256');

    return `${parts[4]}$${hash2.toString('hex')}`;
  }

  _solveMd5Challenge(challenge) {
    // MD5 fallback: response = challenge + "-" + md5(challenge + "-" + password_utf16le)
    const buffer = Buffer.from(`${challenge}-${this.password}`, 'utf-16le');
    const hash = crypto.createHash('md5').update(buffer).digest('hex');
    return `${challenge}-${hash}`;
  }

  async ensureSession() {
    return this.getSessionId();
  }
}

module.exports = FritzAuth;
