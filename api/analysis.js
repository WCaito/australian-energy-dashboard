/**
 * api/analysis.js — NEM Market Analysis: Price Duration Curve + Intraday Shape
 *
 * DATA SOURCE
 * ───────────
 * AEMO Price & Demand CSV files (30-minute settlement intervals):
 *   https://www.aemo.com.au/aemo/data/nem/priceanddemand/PRICE_AND_DEMAND_YYYYMM_REGIONID.csv
 *   Columns: SETTLEMENTDATE (AEST, interval-end), REGIONID, RRP ($/MWh), TOTALDEMAND
 *
 *   One trailing-12-month dataset = ~17,520 records per region.
 *   All months fetched in parallel; typically completes in 5–12 s.
 *
 * OUTPUTS
 * ───────
 * priceDuration  — 201 points { pct, price } at 0.5% spacing.
 *   pct = the % of intervals that had a price AT OR ABOVE this level.
 *   pct=0 → maximum recorded price. pct=100 → minimum recorded price.
 *   This is the AER/AEMO standard format: x-axis = cumulative % of time.
 *
 * intradayShape  — 24 hourly buckets { hour, overall, summer, autumn,
 *   winter, spring, p25_overall, p75_overall }.
 *   Seasonal cuts follow Australian convention:
 *     Summer (DJF): months 12, 1, 2
 *     Autumn (MAM): months 3, 4, 5
 *     Winter (JJA): months 6, 7, 8
 *     Spring (SON): months 9, 10, 11
 *
 * stats — summary KPIs (avg, median, percentiles, event counts).
 *
 * QUERY PARAMS
 * ────────────
 * ?region=NSW1        default NSW1, any of: NSW1 VIC1 QLD1 SA1 TAS1
 * ?year=trailing12    default; or 2023, 2024, 2025
 * ?force=true         bypass Redis cache
 *
 * CACHING
 * ───────
 * Cached in Upstash Redis for 25 h.  Key: analysis:v3:{region}:{year}
 */

'use strict';

const REGIONS = ['NSW1','VIC1','QLD1','SA1','TAS1'];

// ── Redis helpers ──────────────────────────────────────────────────────────────

async function getRedis() {
  const { Redis } = await import('@upstash/redis');
  return new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}

async function kvGet(key) {
  try {
    if (!process.env.UPSTASH_REDIS_REST_URL) return null;
    const r = await getRedis();
    return await r.get(key);
  } catch (e) {
    console.warn('[analysis] kvGet:', e.message);
    return null;
  }
}

async function kvSet(key, value, exSec = 25 * 3600) {
  try {
    if (!process.env.UPSTASH_REDIS_REST_URL) return;
    const r = await getRedis();
    await r.set(key, value, { ex: exSec });
  } catch (e) {
    console.warn('[analysis] kvSet:', e.message);
  }
}

// ── AEMO CSV fetch + parse ──────────────────────────────────────────────────────

async function fetchCSV(year, month, region) {
  const ym  = `${year}${String(month).padStart(2,'0')}`;
  const url = `https://www.aemo.com.au/aemo/data/nem/priceanddemand/PRICE_AND_DEMAND_${ym}_${region}.csv`;
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 15000);
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal:  ctrl.signal,
    });
    clearTimeout(tid);
    return resp.ok ? resp.text() : null;
  } catch {
    return null;
  }
}

/**
 * Parse AEMO CSV → array of { price, hour, month }.
 * SETTLEMENTDATE format: "2024/01/15 08:30:00" (AEST, interval-end).
 * Hour = hour of the interval-end timestamp (standard AEMO/AER convention).
 */
function parseCSV(csvText) {
  if (!csvText) return [];
  const lines = csvText.split('\n');
  const hdrs  = lines[0].split(',').map(h => h.trim().replace(/"/g,'').toUpperCase());
  const dIdx  = hdrs.indexOf('SETTLEMENTDATE');
  const pIdx  = hdrs.indexOf('RRP');
  if (dIdx === -1 || pIdx === -1) return [];

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].trim().split(',');
    if (cols.length <= Math.max(dIdx, pIdx)) continue;

    const price = parseFloat(cols[pIdx]);
    if (!isFinite(price)) continue;

    // "2024/01/15 08:30:00" or "2024-01-15 08:30:00"
    const raw   = cols[dIdx].trim().replace(/"/g,'');
    const parts = raw.split(/[\s\/\-:]/);
    if (parts.length < 5) continue;

    const mo = parseInt(parts[1], 10);
    const hr = parseInt(parts[3], 10);
    if (!isFinite(mo) || !isFinite(hr)) continue;

    out.push({ price, hour: hr, month: mo });
  }
  return out;
}

async function fetchRegion(region, months) {
  console.log(`[analysis] ${region}: fetching ${months.length} months in parallel`);
  const results = await Promise.allSettled(
    months.map(({ year, month }) => fetchCSV(year, month, region).then(parseCSV))
  );
  const records = [];
  let ok = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.length > 0) {
      records.push(...r.value);
      ok++;
    }
  }
  console.log(`[analysis] ${region}: ${ok}/${months.length} months, ${records.length} records`);
  return records;
}

// ── Price Duration Curve ────────────────────────────────────────────────────────

/**
 * 201 points at 0.5% spacing.
 * pct = % of total intervals that had price AT OR ABOVE this level.
 *   pct=0   → highest price recorded (0% of time exceeds this)
 *   pct=100 → lowest price recorded (all intervals at/above this)
 * Curve is monotonically decreasing: left = expensive, right = cheap.
 */
function computePDC(prices) {
  if (!prices.length) return [];
  const sorted = [...prices].sort((a, b) => b - a);   // descending
  const n = sorted.length;
  const pts = [];
  for (let i = 0; i <= 200; i++) {
    const pct = i * 0.5;
    const idx = Math.min(Math.round((pct / 100) * n), n - 1);
    pts.push({ pct: +pct.toFixed(1), price: +sorted[idx].toFixed(2) });
  }
  return pts;
}

// ── Intraday shape ─────────────────────────────────────────────────────────────

const SEASON = {
  12:'summer', 1:'summer', 2:'summer',
   3:'autumn', 4:'autumn', 5:'autumn',
   6:'winter', 7:'winter', 8:'winter',
   9:'spring',10:'spring',11:'spring',
};

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a,b) => a+b, 0) / arr.length;
}

function pct(arr, p) {
  if (!arr.length) return null;
  const s   = [...arr].sort((a,b) => a-b);
  const idx = Math.min(Math.floor((p/100) * s.length), s.length - 1);
  return s[idx];
}

function computeIntraday(records) {
  const bkt = {};
  for (let h = 0; h < 24; h++)
    bkt[h] = { overall:[], summer:[], autumn:[], winter:[], spring:[] };

  for (const { price, hour, month } of records) {
    if (hour < 0 || hour > 23) continue;
    const s = SEASON[month];
    if (!s) continue;
    bkt[hour].overall.push(price);
    bkt[hour][s].push(price);
  }

  return Array.from({ length: 24 }, (_, h) => {
    const b = bkt[h];
    const fix = v => v !== null ? +v.toFixed(2) : null;
    return {
      hour: h,
      overall:     fix(mean(b.overall)),
      summer:      fix(mean(b.summer)),
      autumn:      fix(mean(b.autumn)),
      winter:      fix(mean(b.winter)),
      spring:      fix(mean(b.spring)),
      p25_overall: fix(pct(b.overall, 25)),
      p75_overall: fix(pct(b.overall, 75)),
    };
  });
}

// ── Per-hour negative price frequency (cannibalisation risk) ─────────────────────
/**
 * Returns 24 objects: { hour, negPct, negPctSummer, negPctWinter, totalIntervals }
 * negPct = % of 30-min intervals in that hour that had price < 0
 */
function computeIntradayNegFreq(records) {
  const bkt = {};
  for (let h = 0; h < 24; h++)
    bkt[h] = { all:[], summer:[], autumn:[], winter:[], spring:[] };

  for (const { price, hour, month } of records) {
    if (hour < 0 || hour > 23) continue;
    const s = SEASON[month];
    if (!s) continue;
    const isNeg = price < 0 ? 1 : 0;
    bkt[hour].all.push(isNeg);
    bkt[hour][s].push(isNeg);
  }

  const negPct = arr => arr.length === 0 ? null
    : +(arr.reduce((a,b) => a+b, 0) / arr.length * 100).toFixed(2);

  return Array.from({ length: 24 }, (_, h) => {
    const b = bkt[h];
    return {
      hour:           h,
      negPct:         negPct(b.all),
      negPctSummer:   negPct(b.summer),
      negPctAutumn:   negPct(b.autumn),
      negPctWinter:   negPct(b.winter),
      negPctSpring:   negPct(b.spring),
      totalIntervals: b.all.length,
    };
  });
}

// ── Summary stats ───────────────────────────────────────────────────────────────

function computeStats(prices) {
  if (!prices.length) return {};
  const sorted = [...prices].sort((a,b) => a-b);
  const n  = sorted.length;
  const s  = prices.reduce((a,b) => a+b, 0);

  const negCount  = prices.filter(p => p <    0).length;
  const hiCount   = prices.filter(p => p >= 300 && p < 1000).length;
  const exCount   = prices.filter(p => p >= 1000).length;

  const p25v = pct(sorted, 25);
  const p75v = pct(sorted, 75);

  return {
    totalIntervals: n,
    totalHours:     +(n * 0.5).toFixed(0),
    avgPrice:       +(s / n).toFixed(2),
    medianPrice:    +pct(sorted, 50).toFixed(2),
    maxPrice:       +sorted[n-1].toFixed(2),
    minPrice:       +sorted[0].toFixed(2),
    p25:            +p25v.toFixed(2),
    p75:            +p75v.toFixed(2),
    p90:            +pct(sorted, 90).toFixed(2),
    p95:            +pct(sorted, 95).toFixed(2),
    p99:            +pct(sorted, 99).toFixed(2),
    iqrSpread:      +(p75v - p25v).toFixed(2),
    negCount,
    negPct:         +(negCount / n * 100).toFixed(2),
    negHours:       +(negCount * 0.5).toFixed(1),
    hiCount,
    hiPct:          +(hiCount  / n * 100).toFixed(2),
    hiHours:        +(hiCount  * 0.5).toFixed(1),
    exCount,
    exPct:          +(exCount  / n * 100).toFixed(2),
    exHours:        +(exCount  * 0.5).toFixed(1),
  };
}

// ── Month-list builder ──────────────────────────────────────────────────────────

function buildMonths(yearParam) {
  const now     = new Date();
  const curYear = now.getUTCFullYear();
  const curMo   = now.getUTCMonth() + 1;

  if (yearParam === 'trailing12') {
    const months = [];
    let y = curYear, m = curMo - 1;
    if (m === 0) { m = 12; y--; }
    for (let i = 0; i < 12; i++) {
      months.unshift({ year: y, month: m });
      m--; if (m === 0) { m = 12; y--; }
    }
    return months;
  }

  const yr   = parseInt(yearParam, 10);
  const endM = yr < curYear ? 12 : curMo - 1;
  const months = [];
  for (let m = 1; m <= endM; m++) months.push({ year: yr, month: m });
  return months;
}

// ── Handler ─────────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const region = (req.query.region || 'NSW1').toUpperCase();
  if (!REGIONS.includes(region))
    return res.status(400).json({ error: `Invalid region. Use one of: ${REGIONS.join(', ')}` });

  const now    = new Date();
  const valYrs = [now.getUTCFullYear(), now.getUTCFullYear()-1, now.getUTCFullYear()-2];
  let year = req.query.year || 'trailing12';
  if (year !== 'trailing12' && !valYrs.includes(parseInt(year, 10))) year = 'trailing12';

  const force    = req.query.force === 'true';
  const cacheKey = `analysis:v3:${region}:${year}`;

  if (!force) {
    const cached = await kvGet(cacheKey);
    if (cached && cached.stats) {
      console.log(`[analysis] cache hit: ${cacheKey}`);
      return res.status(200).json({ ...cached, fromCache: true });
    }
  }

  try {
    const months = buildMonths(year);
    if (!months.length)
      return res.status(400).json({ error: 'No complete months available for this period.' });

    const records = await fetchRegion(region, months);
    if (!records.length)
      return res.status(503).json({ error: 'AEMO data unavailable. Try again in a few minutes.', region, year });

    const prices       = records.map(r => r.price);
    const priceDuration = computePDC(prices);
    const intradayShape   = computeIntraday(records);
    const intradayNegFreq = computeIntradayNegFreq(records);
    const stats           = computeStats(prices);

    const periodLabel = year === 'trailing12'
      ? `Trailing 12 months (${months[0].year}/${String(months[0].month).padStart(2,'0')} – ${months.at(-1).year}/${String(months.at(-1).month).padStart(2,'0')})`
      : `${year} calendar year (${months.length} months)`;

    const result = {
      success: true,
      region,
      year,
      periodLabel,
      monthCount: months.length,
      fetchedAt:  new Date().toISOString(),
      stats,
      priceDuration,
      intradayShape,
      intradayNegFreq,
    };

    await kvSet(cacheKey, result);
    console.log(`[analysis] done — ${records.length} records, ${months.length} months, ${priceDuration.length} PDC pts`);
    return res.status(200).json({ ...result, fromCache: false });

  } catch (err) {
    console.error('[analysis] error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
};
