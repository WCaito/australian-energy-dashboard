/** historical-all.js (v4.3 - Vercel Edge Compatible) */
const OE_BASE = process.env.OPENELECTRICITY_API_URL || 'https://api.openelectricity.org.au/v4';
const REGIONS = ['NSW1','VIC1','QLD1','SA1','TAS1'];

function isoMidnightUTC(d){ 
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0)); 
  return dt.toISOString().replace(/\.\d{3}Z$/, 'Z'); 
}

async function requestUpstreamWithRedirects(url, headers){
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: headers,
      redirect: 'follow',
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    const requestId = response.headers.get('x-request-id') || response.headers.get('X-Request-ID');
    
    if (!response.ok) {
      const bodyText = await response.text();
      const error = new Error(`Upstream returned ${response.status}`);
      error.type = 'UPSTREAM';
      error.status = response.status;
      error.requestId = requestId;
      error.bodySnippet = bodyText.slice(0, 500);
      error.url = url.toString();
      throw error;
    }
    
    const json = await response.json();
    return { 
      status: response.status, 
      requestId: requestId, 
      json: json, 
      url: url.toString() 
    };
    
  } catch(e) {
    clearTimeout(timeoutId);
    
    if (e.type === 'UPSTREAM') throw e;
    
    if (e.name === 'AbortError') {
      const error = new Error('Request timeout');
      error.type = 'TIMEOUT';
      error.url = url.toString();
      throw error;
    }
    
    if (e.name === 'SyntaxError') {
      const error = new Error('Failed to parse JSON');
      error.type = 'PARSE';
      error.bodySnippet = e.message;
      error.url = url.toString();
      throw error;
    }
    
    const error = new Error('Network error');
    error.type = 'NETWORK';
    error.error = e;
    error.url = url.toString();
    throw error;
  }
}

async function fetchOpenElectricityData(startISO, endISO, apiKey, mode, interval){
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Accept': 'application/json',
    'User-Agent': 'aed-dashboard/1.3'
  };
  
  async function doRequest(grouped){
    const params = new URLSearchParams({
      metrics: 'price',
      interval: interval || '1d',
      date_start: startISO,
      date_end: endISO
    });
    if (grouped) params.set('primary_grouping', 'network_region');
    const url = `${OE_BASE}/data/network/NEM?${params.toString()}`;
    return requestUpstreamWithRedirects(url, headers);
  }
  
  try {
    if (mode === 'ungrouped') return await doRequest(false);
    if (mode === 'grouped') return await doRequest(true);
    return await doRequest(true);
  } catch(e) {
    if (e && e.type === 'UPSTREAM' && e.status >= 500 && mode !== 'grouped') {
      return await doRequest(false);
    }
    throw e;
  }
}

function processResponse(apiResponse){
  const { json } = apiResponse || {}; 
  if (!json || json.success === false) return {};
  if (!Array.isArray(json.data)) return {};
  
  const buckets = Object.fromEntries(REGIONS.map(r => [r, {}]));
  
  json.data.forEach(series => {
    if ((series.metric || '').toLowerCase() !== 'price') return;
    if (!Array.isArray(series.results)) return;
    
    series.results.forEach(r => {
      const region = r?.columns?.network_region || r?.name || r?.id; 
      if (!region || !REGIONS.includes(region)) return;
      
      const points = Array.isArray(r.data) ? r.data : (Array.isArray(r.history) ? r.history : []);
      
      points.forEach(pt => {
        const ts = pt.timestamp || pt.interval; 
        const val = pt.value; 
        if (val == null) return;
        
        const d = new Date(ts); 
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        
        if (!buckets[region][key]) {
          buckets[region][key] = {
            year: d.getUTCFullYear(),
            month: d.getUTCMonth() + 1,
            date: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(),
            prices: [],
            negativeCount: 0,
            highCount: 0,
            extremeCount: 0,
            highPrices: [],
            extremePrices: []
          };
        }
        
        const m = buckets[region][key]; 
        m.prices.push(val);
        
        if (val < 0) {
          m.negativeCount++;
        } else if (val >= 300 && val < 1000) { 
          m.highCount++; 
          m.highPrices.push(val);
        } else if (val >= 1000) { 
          m.extremeCount++; 
          m.extremePrices.push(val);
        } 
      });
    });
  });
  
  const out = {};
  
  REGIONS.forEach(region => {
    const months = Object.values(buckets[region]).map(m => {
      const avg = m.prices.reduce((a, b) => a + b, 0) / m.prices.length; 
      const max = Math.max(...m.prices); 
      const n = m.prices.length;
      const avgHigh = m.highPrices.length ? (m.highPrices.reduce((a, b) => a + b, 0) / m.highPrices.length) : 0;
      const avgExtreme = m.extremePrices.length ? (m.extremePrices.reduce((a, b) => a + b, 0) / m.extremePrices.length) : 0;
      
      return { 
        year: m.year, 
        month: m.month, 
        date: m.date, 
        averagePrice: Number(avg.toFixed(2)), 
        maxPrice: Number(max.toFixed(2)), 
        priceEvents: { 
          negative: {
            count: m.negativeCount,
            percentage: ((m.negativeCount / n) * 100).toFixed(2)
          }, 
          high: {
            count: m.highCount,
            percentage: ((m.highCount / n) * 100).toFixed(2),
            avgPrice: Number(avgHigh.toFixed(2))
          }, 
          extreme: {
            count: m.extremeCount,
            percentage: ((m.extremeCount / n) * 100).toFixed(2),
            avgPrice: Number(avgExtreme.toFixed(2))
          } 
        } 
      };
    }).sort((a, b) => new Date(a.date) - new Date(b.date));
    
    out[region] = months;
  });
  
  return out;
}

export default async function handler(req, res) {
  // Set CORS headers first
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Vary', 'Origin');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const API_KEY = process.env.OPENELECTRICITY_API_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: 'API key not configured' });
  }
  
  try {
    let years = parseInt(req.query.years, 10); 
    if (!Number.isFinite(years) || years <= 0) years = 4; 
    if (years > 5) years = 5;
    
    const mode = (req.query.group || 'auto').toLowerCase(); 
    const interval = req.query.interval;
    let startISO = req.query.date_start;
    let endISO = req.query.date_end;
    
    if (!startISO || !endISO) { 
      const end = new Date(); 
      end.setUTCDate(end.getUTCDate() - 2); 
      const start = new Date(end); 
      start.setUTCFullYear(end.getUTCFullYear() - years); 
      startISO = isoMidnightUTC(start); 
      endISO = isoMidnightUTC(end); 
    }
    
    const apiResponse = await fetchOpenElectricityData(startISO, endISO, API_KEY, mode, interval);
    const processed = processResponse(apiResponse);
    const totalMonths = Object.values(processed).reduce((s, arr) => s + (Array.isArray(arr) ? arr.length : 0), 0);
    
    if (!totalMonths) {
      return res.status(404).json({ 
        error: 'No data after processing', 
        startISO, 
        endISO 
      });
    }
    
    return res.status(200).json({ 
      data: processed, 
      fetchedAt: new Date().toISOString(), 
      source: 'OpenElectricity v4', 
      dateRange: { 
        start: startISO, 
        end: endISO 
      } 
    });
    
  } catch(e) {
    if (e && e.type === 'UPSTREAM') {
      return res.status(e.status || 502).json({ 
        error: 'Upstream API error', 
        upstreamStatus: e.status, 
        upstreamRequestId: e.requestId, 
        upstreamBodySnippet: e.bodySnippet, 
        url: e.url 
      });
    }
    if (e && e.type === 'PARSE') {
      return res.status(502).json({ 
        error: 'Failed to parse upstream response', 
        upstreamBodySnippet: e.bodySnippet, 
        url: e.url 
      });
    }
    if (e && e.type === 'TIMEOUT') {
      return res.status(504).json({ 
        error: 'Upstream timeout', 
        url: e.url 
      });
    }
    if (e && e.type === 'NETWORK') {
      return res.status(502).json({ 
        error: 'Network error to upstream', 
        message: e.error?.message, 
        url: e.url 
      });
    }
    
    console.error('[FATAL]', e); 
    return res.status(500).json({ 
      error: 'Unhandled server error', 
      message: e?.message || String(e) 
    });
  }
}
