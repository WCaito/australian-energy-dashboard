/**
 * oe-health.js (v2)
 * Probes OpenElectricity v4 with both ungrouped and grouped queries over last 7 days.
 * Returns status/requestId per variant for quick diagnosis.
 */

const https = require('https');
const OE_BASE = process.env.OPENELECTRICITY_API_URL || 'https://api.openelectricity.org.au/v4';

function isoMidnightUTC(d){ const dt=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),0,0,0,0)); return dt.toISOString().replace(/\.\d{3}Z$/, 'Z'); }

function doProbe(grouped, startISO, endISO, apiKey){
  return new Promise((resolve) => {
    const params = new URLSearchParams({ metrics:'price', interval:'1d', date_start:startISO, date_end:endISO });
    if (grouped) params.set('primary_grouping','network_region');
    const url = new URL(`${OE_BASE}/data/network/NEM?${params.toString()}`);
    const req = https.request(url, { method:'GET', headers:{ 'Authorization':`Bearer ${apiKey}`, 'Accept':'application/json', 'User-Agent':'aed-health/1.1' } }, (res)=>{
      const status = res.statusCode; const requestId = res.headers['x-request-id'] || res.headers['X-Request-ID']; let body='';
      res.on('data',(c)=> body+=c); res.on('end',()=>{ resolve({ variant: grouped? 'grouped':'ungrouped', status, requestId, ok: status===200, raw: status===200? undefined : body.slice(0,400) }); });
    });
    req.on('error', (e)=> resolve({ variant: grouped? 'grouped':'ungrouped', status: 0, requestId: null, ok:false, raw: e.message }));
    req.setTimeout(15000, ()=>{ req.destroy(); resolve({ variant: grouped? 'grouped':'ungrouped', status: 0, requestId: null, ok:false, raw: 'timeout' }); });
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

  const end = new Date(); end.setUTCDate(end.getUTCDate() - 2);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - 7);
  const date_start = isoMidnightUTC(start); const date_end = isoMidnightUTC(end);

  const grouped = await doProbe(true, date_start, date_end, API_KEY);
  const ungrouped = await doProbe(false, date_start, date_end, API_KEY);
  return res.status(200).json({ meta:{ date_start, date_end }, probes:[grouped, ungrouped] });
};
