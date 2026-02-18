/**
 * historical-all.js - Fetch historical price data from OpenElectricity API v4
 * 
 * CORRECT ENDPOINT: /v4/data/network/{network_code} with metrics=price
 * (price IS a valid network data metric)
 */

const OE_BASE = process.env.OPENELECTRICITY_API_URL || 'https://api.openelectricity.org.au/v4';
const REGIONS = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'];

/**
 * Convert UTC date to AEST (UTC+10) timezone-naive ISO string
 * OpenElectricity expects: "2024-01-01T00:00:00" (no Z suffix)
 */
function toAESTLocal(date) {
  const aest = new Date(date.getTime() + 10 * 60 * 60 * 1000);
  return aest.toISOString().replace('Z', '').split('.')[0];
}

/**
 * Fetch price data from OpenElectricity v4 API
 */
async function fetchPriceData(dateStart, dateEnd, apiKey) {
  const params = new URLSearchParams();
  params.append('metrics', 'price');
  params.append('interval', '1M');
  params.append('date_start', dateStart);
  params.append('date_end', dateEnd);
  params.append('primary_grouping', 'network_region');

  // CORRECT endpoint for price data
  const url = `${OE_BASE}/data/network/NEM?${params.toString()}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'User-Agent': 'australian-energy-dashboard/2.0',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.status === 416) {
      // No data available for date range
      return { success: true, data: [], noData: true };
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const err = new Error(`OpenElectricity API ${response.status}`);
      err.status = response.status;
      err.body = body.slice(0, 800);
      err.url = url;
      throw err;
    }

    const json = await response.json();
    json._requestUrl = url;
    return json;

  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      const err = new Error('Request timeout');
      err.type = 'TIMEOUT';
      throw err;
    }
    throw e;
  }
}

/**
 * Parse response from /v4/data/network endpoint
 * 
 * Response structure:
 * {
 *   success: true,
 *   data: [{
 *     metric: "price",
 *     unit: "$/MWh",
 *     interval: "1M",
 *     results: [{
 *       name: "NSW1" or columns: { network_region: "NSW1" },
 *       data: [{ timestamp: "2024-01-01T00:00:00", value: 85.23 }, ...]
 *     }]
 *   }]
 * }
 */
function parseResponse(json) {
  const out = Object.fromEntries(REGIONS.map(r => [r, []]));

  if (!json || json.success === false || !Array.isArray(json.data)) {
    return out;
  }

  for (const series of json.data) {
    const metricName = (series.metric || '').toLowerCase();
    if (metricName !== 'price') continue;
    if (!Array.isArray(series.results)) continue;

    for (const result of series.results) {
      // Region name can be in result.name or result.columns.network_region
      const regionName = 
        (result.columns && result.columns.network_region) ||
        result.name ||
        result.id ||
        '';

      if (!REGIONS.includes(regionName)) continue;

      const dataPoints = Array.isArray(result.data) 
        ? result.data 
        : (Array.isArray(result.history) ? result.history : []);

      for (const pt of dataPoints) {
        const ts = pt.timestamp || pt.interval || pt.date;
        const val = pt.value;
        
        if (ts == null || val == null) continue;

        const date = new Date(ts);
        if (isNaN(date.getTime())) continue;

        out[regionName].push({ date, value: val });
      }
    }
  }

  return out;
}

/**
 * Aggregate raw data points into monthly summaries
 */
function buildMonthlyOutput(rawPoints) {
  const buckets = {};

  for (const { date, value } of rawPoints) {
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    
    if (!buckets[key]) {
      buckets[key] = {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        date: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString(),
        prices: [],
      };
    }
    
    buckets[key].prices.push(value);
  }

  return Object.values(buckets)
    .map(bucket => {
      const prices = bucket.prices;
      const avg = prices.reduce((sum, p) => sum + p, 0) / prices.length;
      const max = Math.max(...prices);
      
      const negCount = prices.filter(p => p < 0).length;
      const highPrices = prices.filter(p => p >= 300 && p < 1000);
      const extremePrices = prices.filter(p => p >= 1000);
      const n = prices.length;

      return {
        year: bucket.year,
        month: bucket.month,
        date: bucket.date,
        averagePrice: Number(avg.toFixed(2)),
        maxPrice: Number(max.toFixed(2)),
        priceEvents: {
          negative: {
            count: negCount,
            percentage: n ? Number(((negCount / n) * 100).toFixed(2)) : 0,
          },
          high: {
            count: highPrices.length,
            percentage: n ? Number(((highPrices.length / n) * 100).toFixed(2)) : 0,
            avgPrice: highPrices.length
              ? Number((highPrices.reduce((a, b) => a + b, 0) / highPrices.length).toFixed(2))
              : 0,
          },
          extreme: {
            count: extremePrices.length,
            percentage: n ? Number(((extremePrices.length / n) * 100).toFixed(2)) : 0,
            avgPrice: extremePrices.length
              ? Number((extremePrices.reduce((a, b) => a + b, 0) / extremePrices.length).toFixed(2))
              : 0,
          },
        },
      };
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.OPENELECTRICITY_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server configuration error',
      message: 'OPENELECTRICITY_API_KEY environment variable not set',
    });
  }

  // Parse years parameter (default 4, max 5)
  let years = parseInt(req.query.years, 10);
  if (!Number.isFinite(years) || years <= 0) years = 4;
  if (years > 5) years = 5;

  // Calculate date range - end at start of current month, go back N years
  const now = new Date();
  const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const startDate = new Date(endDate);
  startDate.setUTCFullYear(endDate.getUTCFullYear() - years);

  const dateStart = toAESTLocal(startDate);
  const dateEnd = toAESTLocal(endDate);

  try {
    const json = await fetchPriceData(dateStart, dateEnd, apiKey);

    if (json.noData) {
      return res.status(404).json({
        error: 'No data found',
        message: 'OpenElectricity returned no data for the requested date range',
        dateRange: { start: dateStart, end: dateEnd },
      });
    }

    const rawByRegion = parseResponse(json);

    const processed = {};
    for (const region of REGIONS) {
      processed[region] = buildMonthlyOutput(rawByRegion[region] || []);
    }

    const totalMonths = Object.values(processed).reduce(
      (sum, arr) => sum + arr.length,
      0
    );

    if (totalMonths === 0) {
      return res.status(502).json({
        error: 'Empty response',
        message: 'OpenElectricity returned data but no price records could be parsed',
        hint: 'Check your API key has access to price data via the network endpoint',
        dateRange: { start: dateStart, end: dateEnd },
        requestUrl: json._requestUrl,
      });
    }

    return res.status(200).json({
      success: true,
      data: processed,
      fetchedAt: new Date().toISOString(),
      source: 'OpenElectricity API v4 — /v4/data/network/NEM',
      dateRange: { start: dateStart, end: dateEnd },
      years,
    });

  } catch (err) {
    console.error('[historical-all] Error:', err);

    if (err.type === 'TIMEOUT') {
      return res.status(504).json({
        error: 'Upstream timeout',
        message: 'OpenElectricity API did not respond in time',
      });
    }

    if (err.status) {
      return res.status(502).json({
        error: 'Upstream API error',
        upstreamStatus: err.status,
        upstreamBody: err.body,
        url: err.url,
        hint:
          err.status === 401
            ? 'Invalid API key. Check OPENELECTRICITY_API_KEY in Vercel.'
            : err.status === 403
            ? 'API key does not have permission for price data.'
            : err.status === 404
            ? 'API endpoint not found. This should not happen - please report.'
            : err.status === 422
            ? 'Invalid query parameters sent to OpenElectricity.'
            : 'Check Vercel function logs for details.',
      });
    }

    return res.status(500).json({
      error: 'Internal server error',
      message: err.message || String(err),
    });
  }
};
