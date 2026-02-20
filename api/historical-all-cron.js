/**
 * historical-all-cron.js
 *
 * Nightly cron job — pre-fetches 2 years of AEMO CSV data for all regions
 * and stores the aggregated result in Vercel KV so the main endpoint can
 * serve it instantly.
 *
 * Schedule in vercel.json:
 *   {
 *     "crons": [
 *       { "path": "/api/historical-all-cron", "schedule": "0 2 * * *" }
 *     ]
 *   }
 *
 * Vercel Cron timeout: 300 s on hobby plan (vs 60 s for regular functions).
 * This gives plenty of headroom for the sequential-per-region parallel fetch.
 *
 * Security: protect with CRON_SECRET env var.
 *   Set header: Authorization: Bearer <CRON_SECRET>
 *   Vercel sets this automatically when triggered by the cron scheduler.
 */

const REGIONS = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'];
const CACHE_KEY_PREFIX = 'historical-all:v2';
const CACHE_TTL = 25 * 60 * 60; // 25 hours

// ─── KV ───────────────────────────────────────────────────────────────────────

async function getRedis() {
  const { Redis } = await import('@upstash/redis');
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}

async function kvSet(key, value, exSeconds) {
  const redis = await getRedis();
  await redis.set(key, value, { ex: exSeconds });
}

async function kvGet(key) {
  const redis = await getRedis();
  return redis.get(key);
}

// ─── OpenElectricity ──────────────────────────────────────────────────────────

async function getClient() {
  const { OpenElectricityClient } = await import('openelectricity');
  const apiKey = process.env.OPENELECTRICITY_API_KEY;
  if (!apiKey) throw new Error('OPENELECTRICITY_API_KEY not set');
  return new OpenElectricityClient({ apiKey });
}

function toAESTLocal(date) {
  const aest = new Date(date.getTime() + 10 * 60 * 60 * 1000);
  return aest.toISOString().replace('Z', '').split('.')[0];
}

async function fetchMonthlyAverages(dateStart, dateEnd, client) {
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

// ─── AEMO CSV ─────────────────────────────────────────────────────────────────

async function fetchAEMOCSV(year, month, region) {
  const ym  = `${year}${String(month).padStart(2, '0')}`;
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
  const lines   = csvText.split('\n');
  if (lines.length < 2) return [];

  const headers  = lines[0].split(',').map(h => h.trim().toUpperCase());
  const dateIdx  = headers.indexOf('SETTLEMENTDATE');
  const priceIdx = headers.indexOf('RRP');
  if (dateIdx === -1 || priceIdx === -1) return [];

  const records = [];
  const maxIdx  = Math.max(dateIdx, priceIdx);

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols  = line.split(',');
    if (cols.length <= maxIdx) continue;

    const timestamp = cols[dateIdx].trim();
    const price     = parseFloat(cols[priceIdx]);
    if (!timestamp || isNaN(price)) continue;

    records.push({ timestamp, region, price });
  }

  return records;
}

async function fetchRegionParallel(region, months) {
  console.log(`[cron] ${region}: fetching ${months.length} months in parallel`);

  const results = await Promise.allSettled(
    months.map(({ year, month }) =>
      fetchAEMOCSV(year, month, region).then(csv =>
        csv ? parseAEMOCSV(csv, region) : []
      )
    )
  );

  const records = [];
  let ok = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.length > 0) {
      records.push(...r.value);
      ok++;
    }
  }

  console.log(`[cron] ${region}: ${ok}/${months.length} months OK, ${records.length} records`);
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

      let max = -Infinity, min = Infinity;
      for (const p of prices) { if (p > max) max = p; if (p < min) min = p; }

      const avg = arr => arr.length
        ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2))
        : 0;

      const neg = prices.filter(p => p < 0);
      const hi  = prices.filter(p => p >= 300 && p < 1000);
      const ex  = prices.filter(p => p >= 1000);

      out[region][monthKey] = {
        maxPrice:       Number(max.toFixed(2)),
        minPrice:       Number(min.toFixed(2)),
        totalIntervals: prices.length,
        priceEvents: {
          negative: { count: neg.length, avgPrice: avg(neg) },
          high:     { count: hi.length,  avgPrice: avg(hi) },
          extreme:  { count: ex.length,  avgPrice: avg(ex) },
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

// ─── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // Protect cron endpoint
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log('[cron] Starting nightly AEMO data refresh');
  const cronStart = Date.now();

  const years = 2;
  const now       = new Date();
  const endDate   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const startDate = new Date(endDate);
  startDate.setUTCFullYear(endDate.getUTCFullYear() - years);

  const dateStart = toAESTLocal(startDate);
  const dateEnd   = toAESTLocal(endDate);
  const months    = buildMonthList(
    startDate.getUTCFullYear(), startDate.getUTCMonth() + 1,
    endDate.getUTCFullYear(),   endDate.getUTCMonth()
  );

  console.log(`[cron] Date range: ${dateStart} → ${dateEnd}, ${months.length} months`);

  try {
    const client = await getClient();

    // Fetch OE averages once for all regions
    const oeResponse  = await fetchMonthlyAverages(dateStart, dateEnd, client);
    const monthlyAvgs = parseMonthlyAverages(oeResponse);

    // Fetch each region's AEMO CSVs in parallel (per-region), regions done sequentially
    // so we don't overwhelm AEMO's servers (120 concurrent requests at once is risky)
    const allRecords = [];

    for (const region of REGIONS) {
      const records = await fetchRegionParallel(region, months);
      allRecords.push(...records);
    }

    const aemoStats = aggregateAEMOMonthly(allRecords, REGIONS);
    let   merged    = mergeData(monthlyAvgs, aemoStats, REGIONS);
    merged          = calculatePeriodPercentages(merged, REGIONS);

    const totalMonths = Object.values(merged).reduce((sum, arr) => sum + arr.length, 0);
    const cacheKey    = `${CACHE_KEY_PREFIX}:${years}`;

    await kvSet(cacheKey, merged, CACHE_TTL);

    const elapsed = ((Date.now() - cronStart) / 1000).toFixed(1);
    console.log(`[cron] Done in ${elapsed}s — ${totalMonths} region-months cached`);

    return res.status(200).json({
      success: true,
      totalMonths,
      regions: REGIONS,
      elapsed: `${elapsed}s`,
      aemoRecords: allRecords.length,
      cachedKey: cacheKey,
      expiresIn: `${CACHE_TTL / 3600}h`,
    });

  } catch (err) {
    console.error('[cron] Error:', err);
    return res.status(500).json({
      error: 'Cron job failed',
      message: err.message || String(err),
    });
  }
};
