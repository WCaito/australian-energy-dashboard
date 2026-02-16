/**
 * oe-ping.js
 * Simple auth/connectivity check against /v4/facilities.
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
  const url = new URL(`${OE_BASE}/facilities`);
  const reqUp = https.request(url, { method:'GET', headers:{ 'Authorization':`Bearer ${API_KEY}`, 'Accept':'application/json', 'User-Agent':'aed-ping/1.0' } }, (up) => {
    const status = up.statusCode; const requestId = up.headers['x-request-id'] || up.headers['X-Request-ID']; let body='';
    up.on('data',(c)=> body+=c);
    up.on('end',()=>{
      if (status===200) return res.status(200).json({ ok:true, status, requestId, sample: body.slice(0,200) });
      return res.status(status||502).json({ ok:false, status, requestId, bodySnippet: body.slice(0,400) });
    });
  });
  reqUp.on('error',(e)=> res.status(502).json({ ok:false, error:'network', message:e.message }));
  reqUp.setTimeout(15000,()=>{ reqUp.destroy(); res.status(504).json({ ok:false, error:'timeout' }); });
  reqUp.end();
};
