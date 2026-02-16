/**
 * historical-all.js
 *
 * Serverless handler to fetch & aggregate NEM price data from OpenElectricity v4.
 * - Uses Bearer auth against the v4 base URL.
 * - Hits GET /v4/data/network/NEM with snake_case params and primary_grouping=network_region.
 * - Aggregates daily prices into monthly stats + price-event counts for NSW1, VIC1, QLD1, SA1, TAS1.
 *
 * ENV REQUIRED:
 *   OPENELECTRICITY_API_KEY = <your_api_key>
 *
 * OPTIONAL:
 *   OPENELECTRICITY_API_URL = <override_base_url>   // defaults to https://api.openelectricity.org.au/v4
 */

const https = require('https');

// Default to production v4 API; can be overridden for testing.
const OE_BASE = process.env.OPENELECTRICITY_API_URL || 'https://api.openelectricity.org.au/v4';

// Regions of interest for NEM
const REGIONS = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'];

// ---- Upstream fetch ----
function fetchOpenElectricityData(startDate, endDate, apiKey) {
  return new Promise((resolve, reject) => {
    // v4 expects snake_case params and supports grouping by network_region
    const params = new URLSearchParams({
      metrics: 'price',
      interval: '1d',
      date_start: startDate,
      date_end: endDate,
      primary_grouping: 'network_region'
    });

    const url = new URL(`${OE_BASE}/data/network/NEM?${params.toString()}`);
    const options = {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,   // Bearer auth as per API overview
        'Accept': 'application/json',
        'User-Agent': 'oe-key-checker/1.0'
      }
    };

    console.log(`[OE] GET ${url.toString()}`);

    const req = https.request(url, options, (res) => {
      const status = res.statusCode;
      const requestId = res.headers['x-request-id'] || res.headers['X-Request-ID'];
      let body = '';

      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        console.log(`[OE] status=${status}${requestId ? ` request-id=${requestId}` : ''}`);
        if (status !== 200) {
          console.error(`[OE] upstream error (first 800 chars): ${body.slice(0, 800)}`);
          return reject({
            type: 'UPSTREAM',
            status,
            requestId,
            bodySnippet: body.slice(0, 800)
          });
        }
        try {
          const json = JSON.parse(body);
          resolve({ json, requestId });
        } catch (err) {
          console.error('[OE] JSON parse error:', err);
          console.error('[OE] Raw body (first 500):', body.slice(0, 500));
          reject({ type: 'PARSE', error: err, bodySnippet: body.slice(0, 800) });
        }
      });
    });

    req.on('error', (err) => {
      console.error('[OE] Network error:', err);
      reject({ type: 'NETWORK', error: err });
    });

    req.setTimeout(30000, () => {
      req.destroy();
      reject({ type: 'TIMEOUT', error: new Error('Upstream request timed out after 30s') });
    });

    req.end();
  });
}

// ---- Response processing ----
// v4 series points are typically in result.data[] with { timestamp, value }.
// The region label is usually r.name or r.columns.network_region (when grouped by network_region).
function processResponse(apiResponse) {
  const { json } = apiResponse || {};
  if (!json || json.success === false) {
    console.error('[PROC] Missing/unsuccessful upstream JSON');
    return {};
  }
  if (!Array.isArray(json.data)) {
    console.error('[PROC] json.data is not an array');
    return {};
  }

  // Prepare region buckets keyed by month
  const buckets = Object.fromEntries(REGIONS.map(r => [r, {}]));

  json.data.forEach((series, idx) => {
    if ((series.metric || '').toLowerCase() !== 'price') return;
    if (!Array.isArray(series.results)) return;

    series.results.forEach((r) => {
      const region = r?.columns?.network_region || r?.name || r?.id;
      if (!region || !REGIONS.includes(region)) return;

      const points = Array.isArray(r.data) ? r.data
                   : (Array.isArray(r.history) ? r.history : []);
      if (!points.length) return;

      points.forEach((pt) => {
        const ts = pt.timestamp || pt.interval;
        const val = pt.value;
        if (val === null || val === undefined) return;

        const d = new Date(ts);
        const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

        if (!buckets[region][monthKey]) {
          buckets[region][monthKey] = {
            year: d.getFullYear(),
            month: d.getMonth() + 1,
            date: new Date(d.getFullYear(), d.getMonth(), 1).toISOString(),
            prices: [],
            negativeCount: 0,
            highCount: 0,
            extremeCount: 0,
            highPrices: [],
            extremePrices: []
          };
        }

        const m = buckets[region][monthKey];
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

  // Aggregate
  const out = {};
  REGIONS.forEach((region) => {
    const months = Object.values(buckets[region]).map(m => {
      const avg = m.prices.reduce((a, b) => a + b, 0) / m.prices.length;
      const max = Math.max(...m.prices);
      const n   = m.prices.length;

      const avgHigh    = m.highPrices.length ? (m.highPrices.reduce((a, b) => a + b, 0) / m.highPrices.length) : 0;
      const avgExtreme = m.extremePrices.length ? (m.extremePrices.reduce((a, b) => a + b, 0) / m.extremePrices.length) : 0;

      return {
        year: m.year,
        month: m.month,
        date: m.date,
        averagePrice: Number(avg.toFixed(2)),
        maxPrice: Number(max.toFixed(2)),
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

// ---- Serverless entrypoint ----
module.exports = async (req, res) => {
  // CORS for browser use
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const API_KEY = process.env.OPENELECTRICITY_API_KEY;
  if (!API_KEY) {
    console.error('[BOOT] OPENELECTRICITY_API_KEY not set');
    return res.status(500).json({
      error: 'API key not configured',
      message: 'Set OPENELECTRICITY_API_KEY in your environment'
    });
  }

  try {
    // years guardrail (1..5), defaults to 4
    let years = parseInt(req.query.years, 10);
    if (!Number.isFinite(years) || years <= 0) years = 4;
    if (years > 5) years = 5;

    // 2‑day buffer to avoid partial latest day
    const endDate = new Date();
    endDate.setDate(endDate.getDate() - 2);

    const startDate = new Date(endDate);
    startDate.setFullYear(endDate.getFullYear() - years);

    const date_end   = endDate.toISOString().slice(0, 10);
    const date_start = startDate.toISOString().slice(0, 10);

    console.log(`[BOOT] years=${years} range=${date_start}→${date_end}`);

    const apiResponse = await fetchOpenElectricityData(date_start, date_end, API_KEY);
    const processed = processResponse(apiResponse);

    const monthsTotal = Object.values(processed)
      .reduce((s, arr) => s + (Array.isArray(arr) ? arr.length : 0), 0);

    if (!monthsTotal) {
      return res.status(404).json({
        error: 'No data available after processing',
        debug: { date_start, date_end }
      });
    }

    return res.status(200).json({
      data: processed,
      fetchedAt: new Date().toISOString(),
      source: 'OpenElectricity v4',
      yearsFetched: years,
      dateRange: { start: date_start, end: date_end }
    });

  } catch (e) {
    // Normalize error payloads so the frontend sees *why* it failed
    if (e && e.type === 'UPSTREAM') {
      return res.status(e.status || 502).json({
        error: 'Upstream API error',
        upstreamStatus: e.status,
        upstreamRequestId: e.requestId,
        upstreamBodySnippet: e.bodySnippet
      });
    }
    if (e && e.type === 'PARSE') {
      return res.status(502).json({
        error: 'Failed to parse upstream response',
        upstreamBodySnippet: e.bodySnippet
      });
    }
    if (e && e.type === 'TIMEOUT') {
      return res.status(504).json({ error: 'Upstream timeout' });
    }
    if (e && e.type === 'NETWORK') {
      return res.status(502).json({ error: 'Network error to upstream', message: e.error?.message });
    }

    console.error('[FATAL]', e);
    return res.status(500).json({ error: 'Unhandled server error', message: e?.message || String(e) });
  }
};
