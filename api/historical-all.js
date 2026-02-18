/**
 * historical-all.js
 * Fetches historical monthly electricity price data from OpenElectricity API v4.
 * KEY CORRECTIONS vs previous version:
 *  - Price is a MARKET metric → endpoint is /v4/market/{network}, NOT /v4/data/network/{network}
 *  - Uses native 1M (monthly) interval so the API does the aggregation — no client-side bucketing needed
 *  - Date format: timezone-naive ISO strings in NEM local time (AEST = UTC+10), no trailing Z
 *  - Uses CommonJS (module.exports) for Vercel serverless compatibility
 */

const OE_BASE = process.env.OPENELECTRICITY_API_URL || 'https://api.openelectricity.org.au/v4';
const REGIONS = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'];

function toNEMLocal(date) {
  // Convert UTC → AEST (UTC+10), strip timezone suffix for API
  const aest = new Date(date.getTime() + 10 * 60 * 60 * 1000);
  return aest.toISOString().replace('Z', '').split('.')[0];
}

async function fetchMarketData(dateStart, dateEnd, apiKey) {
  const params = new URLSearchParams();
  params.append('metrics', 'price');
  params.append('interval', '1M');
  params.append('date_start', dateStart);
  params.append('date_end', dateEnd);
  params.append('primary_grouping', 'network_region');

  // CORRECT endpoint: /v4/market/{network_code} — NOT /v4/data/network/{network_code}
  const url = `${OE_BASE}/market/NEM?${params.toString()}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'User-Agent': 'aed-dashboard/2.0',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.status === 416) {
      // 416 = No Data Found — valid empty response
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
      throw Object.assign(new Error('Request to OpenElectricity timed out'), { type: 'TIMEOUT' });
    }
    throw e;
  }
}

/**
 * Parse the /v4/market response.
 *
 * Response shape:
 * {
 *   success: true,
 *   data: [{
 *     metric: "price",
 *     unit: "$/MWh",
 *     interval: "1M",
 *     results: [{
 *       name: "NSW1",
 *       columns: { network_region: "NSW1" },
 *       data: [{ timestamp: "2024-01-01T00:00:00", value: 85.23 }, ...]
 *     }, ...]
 *   }]
 * }
 */
function parseResponse(json) {
  const out = Object.fromEntries(REGIONS.map(r => [r, []]));

  if (!json || json.success === false || !Array.isArray(json.data)) return out;

  for (const series of json.data) {
    if ((series.metric || '').toLowerCase() !== 'price') continue;
    if (!Array.isArray(series.results)) continue;

    for (const result of series.results) {
      // Region is in result.columns.network_region or result.name
      const region =
        (result.columns && result.columns.network_region) ||
        result.name ||
        '';

      if (!REGIONS.includes(region)) continue;

      const rawData = Array.isArray(result.data) ? result.data : [];

      for (const pt of rawData) {
        const ts = pt.timestamp || pt.interval || pt.date;
        const val = pt.value;
        if (ts == null || val == null) continue;

        const date = new Date(ts);
        if (isNaN(date.getTime())) continue;

        out[region].push({ date, value: val });
      }
    }
  }

  return out;
}

function buildMonthlyOutput(rawPoints) {
  // rawPoints is already monthly (interval=1M), but bucket just in case
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
    .map(b => {
      const p = b.prices;
      const avg = p.reduce((a, c) => a + c, 0) / p.length;
      const max = Math.max(...p);
      const negCount = p.filter(v => v < 0).length;
      const highPx = p.filter(v => v >= 300 && v < 1000);
      const extremePx = p.filter(v => v >= 1000);
      const n = p.length;

      return {
        year: b.year,
        month: b.month,
        date: b.date,
        averagePrice: Number(avg.toFixed(2)),
        maxPrice: Number(max.toFixed(2)),
        priceEvents: {
          negative: {
            count: negCount,
            percentage: n ? Number(((negCount / n) * 100).toFixed(2)) : 0,
          },
          high: {
            count: highPx.length,
            percentage: n ? Number(((highPx.length / n) * 100).toFixed(2)) : 0,
            avgPrice: highPx.length
              ? Number((highPx.reduce((a, c) => a + c, 0) / highPx.length).toFixed(2))
              : 0,
          },
          extreme: {
            count: extremePx.length,
            percentage: n ? Number(((extremePx.length / n) * 100).toFixed(2)) : 0,
            avgPrice: extremePx.length
              ? Number((extremePx.reduce((a, c) => a + c, 0) / extremePx.length).toFixed(2))
              : 0,
          },
        },
      };
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.OPENELECTRICITY_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server configuration error',
      message: 'OPENELECTRICITY_API_KEY environment variable is not set.',
    });
  }

  let years = parseInt(req.query.years, 10);
  if (!Number.isFinite(years) || years <= 0) years = 4;
  if (years > 5) years = 5;

  const now = new Date();
  // End = first of current month in UTC; start = N years back
  const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const startDate = new Date(endDate);
  startDate.setUTCFullYear(endDate.getUTCFullYear() - years);

  const dateStart = toNEMLocal(startDate);
  const dateEnd = toNEMLocal(endDate);

  try {
    const json = await fetchMarketData(dateStart, dateEnd, apiKey);

    if (json.noData) {
      return res.status(404).json({
        error: 'No data found',
        message: 'OpenElectricity returned no data for the requested date range.',
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
        message: 'OpenElectricity returned data but none could be parsed for any NEM region.',
        hint: 'Verify your API key has access to the market/price endpoint.',
        dateRange: { start: dateStart, end: dateEnd },
        rawDataArrayLength: Array.isArray(json.data) ? json.data.length : 'n/a',
        requestUrl: json._requestUrl,
      });
    }

    return res.status(200).json({
      success: true,
      data: processed,
      fetchedAt: new Date().toISOString(),
      source: 'OpenElectricity API v4 — /v4/market/NEM',
      dateRange: { start: dateStart, end: dateEnd },
      years,
    });
  } catch (err) {
    console.error('[historical-all] Fatal error:', err);

    if (err.type === 'TIMEOUT') {
      return res.status(504).json({
        error: 'Upstream timeout',
        message: 'OpenElectricity API did not respond in time.',
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
            ? 'Invalid or missing API key. Check OPENELECTRICITY_API_KEY.'
            : err.status === 403
            ? 'API key does not have permission for the market/price endpoint.'
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
