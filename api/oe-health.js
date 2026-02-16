/**
 * oe-health.js
 * Lightweight health check for OpenElectricity v4 connectivity & auth.
 * Fetches 7 days of price data for NEM and returns upstream JSON plus basic meta.
 *
 * ENV REQUIRED:
 *   OPENELECTRICITY_API_KEY
 */

const https = require('https');
const OE_BASE = process.env.OPENELECTRICITY_API_URL || 'https://api.openelectricity.org.au/v4';

function fetchUpstream(start, end, apiKey) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ metrics: 'price', interval: '1d', date_start: start, date_end: end, primary_grouping: 'network_region' });
    const url = new URL(`${OE_BASE}/data/network/NEM?${params.toString()}`);
    const req = https.request(url, { method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json', 'User-Agent': 'aed-health/1.0' } }, (res) => {
      const status = res.statusCode; const requestId = res.headers['x-request-id'] || res.headers['X-Request-ID']; let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => { if (status !== 200) return resolve({ status, requestId, raw: body }); try { const json = JSON.parse(body); resolve({ status, requestId, json }); } catch (e) { resolve({ status, requestId, raw: body }); } });
    });
    req.on('error', (e) => reject(e));
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
  if (!API_KEY) return res.status(500).json({ error: 'OPENELECTRICITY_API_KEY not set' });

  const end = new Date(); end.setDate(end.getDate() - 2);
  const start = new Date(end); start.setDate(start.getDate() - 7);
  const date_end = end.toISOString().slice(0,10);
  const date_start = start.toISOString().slice(0,10);

  try {
    const upstream = await fetchUpstream(date_start, date_end, API_KEY);
    return res.status(200).json({ meta: { date_start, date_end }, upstream });
  } catch (e) {
    return res.status(502).json({ error: 'health check failed', message: e.message });
  }
};
