/**
 * historical-all.js - AEMO CSV Price and Demand Data
 *
 * ARCHITECTURE (solves Vercel 60s timeout):
 * ─────────────────────────────────────────
 * The endpoint accepts an optional `?region=NSW1` param.
 *
 *   • Without ?region → returns cached data from Vercel KV (near-instant).
 *                        If cache is empty, returns 202 telling the client to
 *                        call per-region and try again later.
 *
 *   • With ?region    → fetches ALL months for THAT region in parallel
 *                        (24 concurrent requests instead of 120 sequential).
 *                        Stores the result in KV for future cache hits.
 *                        Typically completes in 5–15 s, well under 60 s.
 *
 * FRONTEND USAGE:
 * ───────────────
 *   // 1. Try cache first
 *   const cached = await fetch('/api/historical-all');
 *   if (cached.status === 200) { use data; return; }
 *
 *   // 2. Cache miss – fan out 5 parallel per-region calls
 *   const regions = ['NSW1','VIC1','QLD1','SA1','TAS1'];
 *   await Promise.all(regions.map(r => fetch(`/api/historical-all?region=${r}`)));
 *
 *   // 3. Re-fetch combined result (now in KV)
 *   const fresh = await fetch('/api/historical-all');
 *
 * CRON (vercel.json):
 *   { "crons": [{ "path": "/api/historical-all-cron", "schedule": "0 2 * * *" }] }
 */

const REGIONS = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'];

// ─── KV helpers (gracefully no-ops if @vercel/kv is not installed) ────────────

async function kvGet(key) {
  try {
    const { kv } = await import('@vercel/kv');
    return await kv.get(key);
  } catch {
    return null;
  }
}

async function kvSet(key, value, exSeconds = 86400) {
  try {
    const { kv } = await import('@vercel/kv');
    await kv.set(key, value, { ex: exSeconds });
  } catch {
    // KV not configured – silently skip caching
  }
}

// ─── OpenElectricity client ────────────────────────────────────────────────────

async function getClient() {
  try {
    const { OpenElectricityClient } = await import('openelectricity');
    const apiKey = process.env.OPENELECTRICITY_API_KEY;
    if (!apiKey) throw new Error('OPENELECTRICITY_API_KEY environment variable not set');
    return new OpenElectricityClient({ apiKey });
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') {
      const e = new Error('OpenElectricity SDK not installed');
      e.type = 'MISSING_DEPENDENCY';
      throw e;
    }
    throw err;
  }
}

function toAESTLocal(date) {
  const aest = new Date(date.getTime() + 10 * 60 * 60 * 1000);
  return aest.toISOString().replace('Z', '').split('.')[0];
}

// ─── OpenElectricity: monthly average prices ──────────────────────────────────

async function fetchMonthlyAverages(dateStart, dateEnd, client) {
  console.log('[fetchMonthlyAverages] Fetching from OE');
  return client.getMarket('NEM', ['price'], {
    interval: '1M',
    dateStart,
    dateEnd,
    primaryGrouping: 'network_region',
  });
}

function parseMonthlyAverages(response) {
  const out = Object.fromEntries(REGIONS.map(r => [r, {}]));
  if (!response?.datatable?.rows) return out;

  for (const row of response.datatable.rows) {
    const { region, interval: timestamp, price } = row;
    if (!region || !REGIONS.includes(region) || !timestamp || price == null) continue;

    const date = new Date(timestamp);
    if (isNaN(date.getTime())) continue;

    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    out[region][key] = {
      averagePrice: Number(price.toFixed(2)),
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      date: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString(),
    };
  }

  return out;
}

// ─── AEMO CSV fetching ────────────────────────────────────────────────────────

async function fetchAEMOCSV(year, month, region) {
  const ym = `${year}${String(month).padStart(2, '0')}`;
  const url = `https://www.aemo.com.au/aemo/data/nem/priceanddemand/PRICE_AND_DEMAND_${ym}_${region}.csv`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal,
    });

    clearTimeout(timeout);
    return response.ok ? response.text() : null;
  } catch {
    return null;
  }
}

function parseAEMOCSV(csvText, region) {
  const lines = csvText.split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().toUpperCase());
  const dateIdx  = headers.indexOf('SETTLEMENTDATE');
  const priceIdx = headers.indexOf('RRP');

  if (dateIdx === -1 || priceIdx === -1) {
    console.warn(`[parseAEMOCSV] Missing columns for ${region}`);
    return [];
  }

  const records = [];
  const maxIdx = Math.max(dateIdx, priceIdx);

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = line.split(',');
    if (cols.length <= maxIdx) continue;

    const timestamp = cols[dateIdx].trim();
    const price = parseFloat(cols[priceIdx]);
    if (!timestamp || isNaN(price)) continue;

    records.push({ timestamp, region, price });
  }

  return records;
}

/**
 * Fetch ALL months for a SINGLE region in parallel.
 * 24 concurrent requests → typically 5–15 s.
 */
async function fetchAEMODataForRegion(region, months) {
  console.log(`[fetchAEMOData] ${region}: fetching ${months.length} months in parallel`);

  const results = await Promise.allSettled(
    months.map(({ year, month }) =>
      fetchAEMOCSV(year, month, region).then(csv =>
        csv ? parseAEMOCSV(csv, region) : []
      )
    )
  );

  const records = [];
  let successCount = 0;

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.length > 0) {
      records.push(...result.value);
      successCount++;
    }
  }

  console.log(`[fetchAEMOData] ${region}: ${successCount}/${months.length} months OK, ${records.length} records`);
  return records;
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

function aggregateAEMOMonthly(records, regions) {
  const out     = Object.fromEntries(regions.map(r => [r, {}]));
  const buckets = Object.fromEntries(regions.map(r => [r, {}]));

  for (const { timestamp, region, price } of records) {
    if (!regions.includes(region)) continue;
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) continue;

    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!buckets[region][key]) buckets[region][key] = [];
    buckets[region][key].push(price);
  }

  for (const region of regions) {
    for (const [monthKey, prices] of Object.entries(buckets[region])) {
      if (!prices.length) continue;

      const negPrices     = prices.filter(p => p < 0);
      const highPrices    = prices.filter(p => p >= 300 && p < 1000);
      const extremePrices = prices.filter(p => p >= 1000);
      const avg = arr => arr.length
        ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2))
        : 0;

      out[region][monthKey] = {
        maxPrice: Number(Math.max(...prices).toFixed(2)),
        minPrice: Number(Math.min(...prices).toFixed(2)),
        totalIntervals: prices.length,
        priceEvents: {
          negative: { count: negPrices.length,     avgPrice: avg(negPrices) },
          high:     { count: highPrices.length,    avgPrice: avg(highPrices) },
          extreme:  { count: extremePrices.length, avgPrice: avg(extremePrices) },
        },
      };
    }
  }

  return out;
}

function mergeData(monthlyAvgs, aemoStats, regions) {
  const result = {};

  for (const region of regions) {
    result[region] = [];
    const avgData  = monthlyAvgs[region] || {};
    const aemoData = aemoStats[region]   || {};

    for (const monthKey of Object.keys(aemoData)) {
      const avg  = avgData[monthKey];
      const aemo = aemoData[monthKey];

      if (avg && aemo) {
        result[region].push({ ...avg, ...aemo });
      } else if (aemo) {
        const [y, mo] = monthKey.split('-').map(Number);
        result[region].push({
          ...aemo,
          averagePrice: Number(((aemo.maxPrice + aemo.minPrice) / 2).toFixed(2)),
          year: y,
          month: mo,
          date: new Date(Date.UTC(y, mo - 1, 1)).toISOString(),
        });
      }
    }

    result[region].sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  return result;
}

function calculatePeriodPercentages(mergedData, regions) {
  for (const region of regions) {
    const totalIntervals = mergedData[region].reduce(
      (sum, m) => sum + (m.totalIntervals || 0), 0
    );
    if (totalIntervals === 0) continue;

    for (const month of mergedData[region]) {
      if (month.priceEvents) {
        for (const type of ['negative', 'high', 'extreme']) {
          month.priceEvents[type].percentage = Number(
            ((month.priceEvents[type].count / totalIntervals) * 100).toFixed(4)
          );
        }
      }
      delete month.totalIntervals;
    }
  }
  return mergedData;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function buildMonthList(startYear, startMonth, endYear, endMonth) {
  const months = [];
  let y = startYear, m = startMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    months.push({ year: y, month: m });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Date range setup ──────────────────────────────────────────────────────
  let years = parseInt(req.query.years, 10);
  if (!Number.isFinite(years) || years <= 0) years = 2;
  if (years > 2) years = 2;

  const now       = new Date();
  const endDate   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const startDate = new Date(endDate);
  startDate.setUTCFullYear(endDate.getUTCFullYear() - years);

  const dateStart  = toAESTLocal(startDate);
  const dateEnd    = toAESTLocal(endDate);
  const cacheKey   = `historical-all:v2:${years}`;
  const regionParam = req.query.region ? req.query.region.toUpperCase() : null;

  // ── MODE A: Per-region fetch (called by frontend fan-out) ─────────────────
  if (regionParam) {
    if (!REGIONS.includes(regionParam)) {
      return res.status(400).json({ error: `Invalid region. Must be one of: ${REGIONS.join(', ')}` });
    }

    console.log(`[handler] Per-region fetch: ${regionParam}`);

    try {
      const client  = await getClient();
      const months  = buildMonthList(
        startDate.getUTCFullYear(), startDate.getUTCMonth() + 1,
        endDate.getUTCFullYear(),   endDate.getUTCMonth()
      );

      // Fetch OE averages and AEMO CSVs in parallel
      const [oeResponse, aemoRecords] = await Promise.all([
        fetchMonthlyAverages(dateStart, dateEnd, client),
        fetchAEMODataForRegion(regionParam, months),
      ]);

      const monthlyAvgs = parseMonthlyAverages(oeResponse);
      const aemoStats   = aggregateAEMOMonthly(aemoRecords, [regionParam]);
      let   merged      = mergeData(monthlyAvgs, aemoStats, [regionParam]);
      merged            = calculatePeriodPercentages(merged, [regionParam]);

      const regionResult = {
        region: regionParam,
        data: merged[regionParam],
        fetchedAt: new Date().toISOString(),
        aemoRecords: aemoRecords.length,
      };

      // Merge into the full cache
      const existing = (await kvGet(cacheKey)) || {};
      existing[regionParam] = merged[regionParam];
      await kvSet(cacheKey, existing, 25 * 60 * 60); // 25 h TTL

      console.log(`[handler] ${regionParam} done – ${merged[regionParam].length} months`);

      return res.status(200).json({
        success: true,
        ...regionResult,
        source: 'AEMO Price & Demand CSV (5-min intervals)',
        dateRange: { start: dateStart, end: dateEnd },
      });

    } catch (err) {
      return handleError(err, res);
    }
  }

  // ── MODE B: Return combined cached result ──────────────────────────────────
  console.log('[handler] Combined result request – checking KV cache');

  try {
    const cached = await kvGet(cacheKey);

    if (cached && typeof cached === 'object' && Object.keys(cached).length > 0) {
      // Check we have data for all regions
      const coveredRegions = REGIONS.filter(r => Array.isArray(cached[r]) && cached[r].length > 0);

      if (coveredRegions.length === REGIONS.length) {
        console.log('[handler] Cache hit – serving all regions');
        return res.status(200).json({
          success: true,
          data: cached,
          fetchedAt: new Date().toISOString(),
          source: 'AEMO Price & Demand CSV (5-min intervals) [cached]',
          dateRange: { start: dateStart, end: dateEnd },
          years,
          cached: true,
        });
      }

      // Partial cache – return what we have with a flag
      if (coveredRegions.length > 0) {
        console.log(`[handler] Partial cache: ${coveredRegions.join(', ')}`);
        return res.status(206).json({
          success: true,
          data: cached,
          fetchedAt: new Date().toISOString(),
          source: 'AEMO Price & Demand CSV (5-min intervals) [partial cache]',
          dateRange: { start: dateStart, end: dateEnd },
          years,
          cached: true,
          missingRegions: REGIONS.filter(r => !coveredRegions.includes(r)),
        });
      }
    }

    // No cache at all → tell client to fan out
    console.log('[handler] Cache miss – returning 202 so client can fan out');
    return res.status(202).json({
      success: false,
      message: 'Data not yet cached. Please call ?region=REGION for each region in parallel, then retry.',
      regions: REGIONS,
      hint: `GET /api/historical-all?region=NSW1 (etc.) in parallel, then GET /api/historical-all`,
    });

  } catch (err) {
    return handleError(err, res);
  }
};

function handleError(err, res) {
  console.error('[handler] Error:', err);

  if (err.type === 'MISSING_DEPENDENCY') {
    return res.status(500).json({ error: 'Missing dependency', message: 'OpenElectricity SDK not installed' });
  }
  if (err.message?.includes('OPENELECTRICITY_API_KEY')) {
    return res.status(500).json({ error: 'Configuration error', message: 'OPENELECTRICITY_API_KEY not set' });
  }
  return res.status(500).json({ error: 'Internal server error', message: err.message || String(err) });
}
