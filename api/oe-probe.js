
/** oe-probe.js (v4) */
const { requestUpstreamWithRedirects } = require('./_upstream');
const OE_BASE = process.env.OPENELECTRICITY_API_URL || 'https://api.openelectricity.org.au/v4';

module.exports = async (req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS'); res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-Requested-With'); if(req.method==='OPTIONS') return res.status(200).end();
  const API_KEY = process.env.OPENELECTRICITY_API_KEY; if(!API_KEY) return res.status(500).json({ status:500, error:'OPENELECTRICITY_API_KEY not set' });
  const allowed=['metrics','interval','date_start','date_end','primary_grouping']; const params=new URLSearchParams(); for(const k of allowed){ if(req.query[k]) params.set(k, String(req.query[k])); }
  if(!params.has('metrics')) params.set('metrics','price'); if(!params.has('interval')) params.set('interval','1d');
  const url=new URL(`${OE_BASE}/data/network/NEM?${params.toString()}`);
  const headers={'Authorization':`Bearer ${API_KEY}`,'Accept':'application/json','User-Agent':'aed-probe/1.1'};
  try{ const up = await requestUpstreamWithRedirects(url, headers); return res.status(200).json({ status:200, requestId: up.requestId, url: url.toString(), json: up.json }); }
  catch(e){ return res.status(e.status||502).json({ status: e.status||502, requestId: e.requestId, url: e.url||url.toString(), bodySnippet: e.bodySnippet }); }
};
