/**
 * oe-ping.js
 * Simple auth/connectivity check against /v4/facilities with redirect follow (http + https).
 */
const http = require('http');
const https = require('https');

const OE_BASE = process.env.OPENELECTRICITY_API_URL || 'https://api.openelectricity.org.au/v4';

function requestByProtocol(u, options, onResponse) {
  return (u.protocol === 'http:' ? http : https).request(u, options, onResponse);
}

function followGet(url, headers, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    const req = requestByProtocol(url, { method: 'GET', headers }, (res) => {
      const status = res.statusCode;
      const location = res.headers.location;
      const requestId = res.headers['x-request-id'] || res.headers['X-Request-ID'];
      let body = '';

      res.on('data', (c) => (body += c));
      res.on('end', async () => {
        // Follow 3xx with Location (301/302/303/307/308)
        if ([301, 302, 303, 307, 308].includes(status) && location && maxRedirects > 0) {
          // Resolve relative -> absolute
          let nextUrl = new URL(location, url);

          // Optional hardening: if the redirect downgrades to http, upgrade to https if same host supports it.
          if (nextUrl.protocol === 'http:' && url.hostname === nextUrl.hostname) {
            nextUrl = new URL(nextUrl.toString().replace(/^http:/, 'https:'));
          }

          console.log(`[oe-ping] redirect ${status} → ${nextUrl.toString()}`);
          try {
            const next = await followGet(nextUrl, headers, maxRedirects - 1);
            return resolve(next);
          } catch (e) {
            return reject(e);
          }
        }

        resolve({
          status,
          requestId,
          body,
          headers: res.headers,
          url: url.toString()
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const API_KEY = process.env.OPENELECTRICITY_API_KEY;
  if (!API_KEY) return res.status(500).json({ ok: false, error: 'OPENELECTRICITY_API_KEY not set' });

  try {
    const url = new URL(`${OE_BASE}/facilities`);
    const headers = {
      'Authorization': `Bearer ${API_KEY}`,
      'Accept': 'application/json',
      'User-Agent': 'aed-ping/1.2'
    };

    const up = await followGet(url, headers);

    if (up.status === 200) {
      return res.status(200).json({
        ok: true,
        status: up.status,
        requestId: up.requestId,
        sample: up.body ? up.body.slice(0, 200) : ''
      });
    }
    return res.status(up.status || 502).json({
      ok: false,
      status: up.status,
      requestId: up.requestId,
      bodySnippet: up.body ? up.body.slice(0, 400) : '',
      finalUrl: up.url
    });
  } catch (e) {
    console.error('[oe-ping] error', e);
    return res.status(502).json({ ok: false, error: 'network', message: e.message });
  }
};
