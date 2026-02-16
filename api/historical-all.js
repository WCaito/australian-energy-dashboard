/**
 * historical-all.js (v2)
 *
 * Serverless handler to fetch & aggregate NEM price data from OpenElectricity v4.
 * - Uses Bearer auth against the v4 base URL.
 * - Calls GET /v4/data/network/NEM with snake_case params.
 * - Sends ISO 8601 date-time strings (T00:00:00Z) per API shape.
 * - Attempts grouped by region first; on upstream 5xx, retries ungrouped once.
 * - Aggregates daily prices into monthly stats + price-event counts for NSW1, VIC1, QLD1, SA1, TAS1.
 *
 * ENV REQUIRED:
 *   OPENELECTRICITY_API_KEY = <your_api_key>
 * OPTIONAL:
 *   OPENELECTRICITY_API_URL = <override_base_url> (defaults to https://api.openelectricity.org.au/v4)
 */

const https = require('https');

const OE_BASE = process.env.OPENELECTRICITY_API_URL || 'https://api.openelectricity.org.au/v4';
const REGIONS = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'];

function isoMidnightUTC(d) {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
  return dt.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function requestUpstream(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers }, (res) => {
      const status = res.statusCode;
      const requestId = res.headers['x-request-id'] || res.headers['X-Request-ID'];
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        if (status !== 200) {
          return reject({ type: 'UPSTREAM', status, requestId, bodySnippet: body.slice(0, 800), url: url.toString() });
        }
        try { resolve({ json: JSON.parse(body), requestId }); }
        catch (e) { reject({ type: 'PARSE', error: e, bodySnippet: body.slice(0, 800), url: url.toString() }); }
      });
    });
    req.on('error', (e) => reject({ type: 'NETWORK', error: e, url: url.toString() }));
    req.setTimeout(30000, () => { req.destroy(); reject({ type: 'TIMEOUT', error: new Error('timeout'), url: url.toString() }); });
    req.end();
  });
}

async function fetchOpenElectricityData(startISO, endISO, apiKey) {
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Accept': 'application/json',
    'User-Agent': 'aed-dashboard/1.2'
  };

  async function doRequest(grouped) {
    const params = new URLSearchParams({
      metrics: 'price',
      interval: '1d',
      date_start: startISO,
      date_end: endISO
    });
    if (grouped) params.set('primary_grouping', 'network_region');

    const url = new URL(`${OE_BASE}/data/network/NEM?${params.toString()}`);
    console.log(`[OE] GET ${url.toString()}`);
    return requestUpstream(url, headers);
  }

  try {
    // First attempt: grouped
    return await doRequest(true);
  } catch (e) {
    if (e && e.type === 'UPSTREAM' && e.status >= 500) {
      console.warn('[OE] 5xx with grouping; retrying ungrouped…', e);
      return await doRequest(false);
    }
    throw e;
  }
}

function processResponse(apiResponse) {
  const { json } = apiResponse || {};
  if (!json || json.success === false) { console.error('[PROC] Unsuccessful upstream JSON'); return {}; }
  if (!Array.isArray(json.data)) { console.error('[PROC] json.data is not an array'); return {}; }

  const buckets = Object.fromEntries(REGIONS.map(r => [r, {}]));

  json.data.forEach((series) => {
    if ((series.metric || '').toLowerCase() !== 'price') return;
    if (!Array.isArray(series.results)) return;

    series.results.forEach((r) => {
      const region = r?.columns?.network_region || r?.name || r?.id;
      if (!region || !REGIONS.includes(region)) return;
      const points = Array.isArray(r.data) ? r.data : (Array.isArray(r.history) ? r.history : []);
      if (!points.length) return;

      points.forEach((pt) => {
        const ts = pt.timestamp || pt.interval; const val = pt.value; if (val == null) return;
        const d = new Date(ts);
        const monthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        if (!buckets[region][monthKey]) {
          buckets[region][monthKey] = { year: d.getUTCFullYear(), month: d.getUTCMonth()+1, date: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(), prices: [], negativeCount: 0, highCount: 0, extremeCount: 0, highPrices: [], extremePrices: [] };
        }
        const m = buckets[region][monthKey];
        m.prices.push(val);
        if (val < 0) m.negativeCount++;
        else if (val >= 300 && val < 1000) { m.highCount++; m.highPrices.push(val); }
        else if (val >= 1000) { m.extremeCount++; m.extremePrices.push(val); }
      });
    });
  });

  const out = {};
  REGIONS.forEach((region) => {
    const months = Object.values(buckets[region]).map(m => {
      const avg = m.prices.reduce((a, b) => a + b, 0) / m.prices.length;
      const max = Math.max(...m.prices);
      const n   = m.prices.length;
      const avgHigh    = m.highPrices.length ? (m.highPrices.reduce((a, b) => a + b, 0) / m.highPrices.length) : 0;
      const avgExtreme = m.extremePrices.length ? (m.extremePrices.reduce((a, b) => a + b, 0) / m.extremePrices.length) : 0;
      return {
        year: m.year, month: m.month, date: m.date,
        averagePrice: Number(avg.toFixed(2)), maxPrice: Number(max.toFixed(2)),
        priceEvents: {
          negative: { count: m.negativeCount, percentage: ((m.negativeCount / n) * 100).toFixed(2) },
          high:     { count: m.highCount,     percentage: ((m.highCount     / n) * 100).toFixed(2), avgPrice: Number(avgHigh.toFixed(2)) },
          extreme:  { count: m.extremeCount,  percentage: ((m.extremeCount  / n) * 100).toFixed(2), avgPrice: Number(avgExtreme.toFixed(2)) }
        }
      };
    }).sort((a, b) => new Date(a.date) - new Date(b.date));
    out[region] = months;
  });

  return out;
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const API_KEY = process.env.OPENELECTRICITY_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'API key not configured', message: 'Set OPENELECTRICITY_API_KEY' });

  try {
    let years = parseInt(req.query.years, 10); if (!Number.isFinite(years) || years <= 0) years = 4; if (years > 5) years = 5;
    const end = new Date(); end.setUTCDate(end.getUTCDate() - 2);
    const start = new Date(end); start.setUTCFullYear(end.getUTCFullYear() - years);
    const dateStartISO = isoMidnightUTC(start); const dateEndISO = isoMidnightUTC(end);

    console.log(`[BOOT] years=${years} range=${dateStartISO}→${dateEndISO}`);

    const apiResponse = await fetchOpenElectricityData(dateStartISO, dateEndISO, API_KEY);
    const processed = processResponse(apiResponse);
    const monthsTotal = Object.values(processed).reduce((s, arr) => s + (Array.isArray(arr) ? arr.length : 0), 0);
    if (!monthsTotal) return res.status(404).json({ error: 'No data after processing', dateStartISO, dateEndISO });

    return res.status(200).json({ data: processed, fetchedAt: new Date().toISOString(), source: 'OpenElectricity v4', yearsFetched: years, dateRange: { start: dateStartISO, end: dateEndISO } });
  } catch (e) {
    if (e && e.type === 'UPSTREAM') return res.status(e.status || 502).json({ error: 'Upstream API error', upstreamStatus: e.status, upstreamRequestId: e.requestId, upstreamBodySnippet: e.bodySnippet, url: e.url });
    if (e && e.type === 'PARSE') return res.status(502).json({ error: 'Failed to parse upstream response', upstreamBodySnippet: e.bodySnippet, url: e.url });
    if (e && e.type === 'TIMEOUT') return res.status(504).json({ error: 'Upstream timeout', url: e.url });
    if (e && e.type === 'NETWORK') return res.status(502).json({ error: 'Network error to upstream', message: e.error?.message, url: e.url });
    console.error('[FATAL]', e);
    return res.status(500).json({ error: 'Unhandled server error', message: e?.message || String(e) });
  }
};
