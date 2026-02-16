/**
 * oe-probe.js
 * Flexible probe that forwards your query params to /v4/data/network/NEM.
 * Example: /api/oe-probe?metrics=price&interval=1d&date_start=2026-02-10T00:00:00Z&date_end=2026-02-11T00:00:00Z&primary_grouping=network_region
 */
const https = require('https');
const OE_BASE = process.env.OPENELECTRICITY_API_URL || 'https://api.openelectricity.org.au/v4';
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-Requested-With');
  if (req.method==='OPTIONS') return res.status(200).end();
  const API_KEY = process.env.OPENELECTRICITY_API_KEY;
  if (!API_KEY) return res.status(500).json({ error:'OPENELECTRICITY_API_KEY not set' });
  const allowed = ['metrics','interval','date_start','date_end','primary_grouping'];
  const params = new URLSearchParams();
  for (const k of allowed){ if (req.query[k]) params.set(k, String(req.query[k])); }
  if (!params.has('metrics')) params.set('metrics','price');
  if (!params.has('interval')) params.set('interval','1d');
  const url = new URL(`${OE_BASE}/data/network/NEM?${params.toString()}`);
  const reqUp = https.request(url, { method:'GET', headers:{ 'Authorization':`Bearer ${API_KEY}`, 'Accept':'application/json', 'User-Agent':'aed-probe/1.0' } }, (up) => {
    const status = up.statusCode; const requestId = up.headers['x-request-id'] || up.headers['X-Request-ID']; let body='';
    up.on('data',(c)=> body+=c);
    up.on('end',()=>{
      try{ const json = JSON.parse(body); return res.status(status).json({ status, requestId, url: url.toString(), json: status===200? json : undefined, bodySnippet: status===200? undefined : body.slice(0,800) }); }
      catch{ return res.status(status).json({ status, requestId, url: url.toString(), bodySnippet: body.slice(0,800) }); }
    });
  });
  reqUp.on('error',(e)=> res.status(502).json({ status:502, url: url.toString(), error:'network', message:e.message }));
  reqUp.setTimeout(20000,()=>{ reqUp.destroy(); res.status(504).json({ status:504, url: url.toString(), error:'timeout' }); });
  reqUp.end();
};
