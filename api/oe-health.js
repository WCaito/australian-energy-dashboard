
/** oe-health.js (v4) */
const { requestUpstreamWithRedirects } = require('./_upstream');
const OE_BASE = process.env.OPENELECTRICITY_API_URL || 'https://api.openelectricity.org.au/v4';

function isoMidnightUTC(d){ const dt=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),0,0,0,0)); return dt.toISOString().replace(/\.\d{3}Z$/,'Z'); }

module.exports = async (req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS'); res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-Requested-With'); if(req.method==='OPTIONS') return res.status(200).end();
  const API_KEY = process.env.OPENELECTRICITY_API_KEY; if(!API_KEY) return res.status(500).json({ error:'OPENELECTRICITY_API_KEY not set' });
  const end=new Date(); end.setUTCDate(end.getUTCDate()-2); const start=new Date(end); start.setUTCDate(start.getUTCDate()-7);
  const date_start=isoMidnightUTC(start); const date_end=isoMidnightUTC(end);
  const headers={'Authorization':`Bearer ${API_KEY}`,'Accept':'application/json','User-Agent':'aed-health/1.2'};
  async function probe(grouped){ const params=new URLSearchParams({ metrics:'price', interval:'1d', date_start, date_end }); if(grouped) params.set('primary_grouping','network_region'); const url=new URL(`${OE_BASE}/data/network/NEM?${params.toString()}`); try{ const up=await requestUpstreamWithRedirects(url, headers); return { variant: grouped?'grouped':'ungrouped', status:200, ok:true, url:url.toString(), requestId: up.requestId }; }catch(e){ return { variant: grouped?'grouped':'ungrouped', status: e.status||0, ok:false, url: e.url||url.toString(), requestId: e.requestId, raw: e.bodySnippet }; } }
  const g = await probe(true); const u = await probe(false);
  return res.status(200).json({ meta:{ date_start, date_end }, probes:[g,u] });
};
