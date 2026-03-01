/**
 * api/gwap-sa-wind.js
 * Generation-Weighted Average Price (GWAP) — wind or solar, any NEM region
 *
 * ══ METHODOLOGY ════════════════════════════════════════════════════════════════
 *
 * GWAP ($/MWh) = Σ market_value ($) / Σ energy (MWh)
 *
 * Both metrics come from OpenElectricity getNetworkData at monthly resolution.
 * OE computes market_value as Σ(generation × spot_price) across 5-minute
 * dispatch intervals before aggregating to monthly — so this is a genuine
 * interval-level GWAP, not a monthly-average-price × monthly-energy approximation.
 *
 * Capture rate (%) = annual GWAP / annual flat price × 100
 * Flat price = time-weighted average from getMarket (price) for the same region.
 * Capture < 100% = generator earned less per MWh than a flat baseload generator
 *                  (the "cannibalisation discount").
 *
 * ══ QUERY PARAMS ════════════════════════════════════════════════════════════════
 *   ?region=SA1          default SA1, any of NSW1 VIC1 QLD1 SA1 TAS1
 *   ?fueltech=wind       default wind; use "solar_utility" for utility solar
 *   ?force=true          bypass Redis cache
 *
 * ══ FUELTECH FILTER ══════════════════════════════════════════════════════════════
 *   wind:          ft.includes('wind')  — catches wind, wind_onshore, wind_offshore
 *   solar_utility: ft.includes('solar') && !ft.includes('rooftop')
 *                  — catches solar_utility, excludes behind-the-meter rooftop
 *                  — rooftop solar does not participate in the spot market dispatch
 *
 * ══ CACHING ═════════════════════════════════════════════════════════════════════
 *   Redis 25h TTL · Key: gwap:v5:{region}:{fueltech}:trailing12
 */

'use strict';

const REGIONS   = ['NSW1','VIC1','QLD1','SA1','TAS1'];
const FUELTECHS = ['wind', 'solar_utility'];

// ── Redis ──────────────────────────────────────────────────────────────────────

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
    return await (await getRedis()).get(key);
  } catch (e) { console.warn('[gwap] kvGet:', e.message); return null; }
}
async function kvSet(key, value, ex = 25 * 3600) {
  try {
    if (!process.env.UPSTASH_REDIS_REST_URL) return;
    await (await getRedis()).set(key, value, { ex });
  } catch (e) { console.warn('[gwap] kvSet:', e.message); }
}

// ── OE client ─────────────────────────────────────────────────────────────────

async function getClient() {
  const { OpenElectricityClient } = await import('openelectricity');
  const apiKey = process.env.OPENELECTRICITY_API_KEY;
  if (!apiKey) throw new Error('OPENELECTRICITY_API_KEY not set');
  return new OpenElectricityClient({ apiKey });
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function toNaive(date) {
  return new Date(date.getTime() + 10 * 3600 * 1000).toISOString().slice(0, 19);
}

function buildDateRange(yearParam) {
  const now     = new Date();
  const curYear = now.getUTCFullYear();
  const curMo   = now.getUTCMonth() + 1; // 1-based

  let startMonth, endMonth, label;

  if (yearParam === 'trailing12') {
    // Last 12 complete months
    let y = curYear, m = now.getUTCMonth(); // m is 0-based
    if (m === 0) { m = 12; y--; }           // Jan edge case → last month is Dec prev year
    startMonth = new Date(Date.UTC(y - 1, m, 1)); // 12 months before last complete
    endMonth   = new Date(Date.UTC(y,     m, 1)); // first of month AFTER last complete
    label = `${startMonth.toLocaleString('en-AU',{month:'short',year:'numeric',timeZone:'UTC'})} – ${new Date(endMonth - 1).toLocaleString('en-AU',{month:'short',year:'numeric',timeZone:'UTC'})}`;
  } else {
    const yr   = parseInt(yearParam, 10);
    const endM = yr < curYear ? 12 : curMo - 1; // complete months only for current year
    startMonth = new Date(Date.UTC(yr, 0, 1));    // Jan 1 of year
    endMonth   = new Date(Date.UTC(yr, endM, 1)); // first of month after last included
    label = endM === 12
      ? `${yr} (full year)`
      : `Jan – ${new Date(Date.UTC(yr, endM - 1, 1)).toLocaleString('en-AU',{month:'short',timeZone:'UTC'})} ${yr}`;
  }

  // OE wide range: always request 4 full years of data regardless of selected period.
  // We do NOT rely on OE to filter by date — computeGWAP filters client-side.
  // This is necessary because OE's date params are not reliably honoured for
  // market_value at monthly resolution.
  const oeStart = new Date(Date.UTC(curYear - 3, 0, 1)); // Jan 1, three years ago
  const oeEnd   = new Date(Date.UTC(curYear + 1, 0, 1)); // Jan 1 next year (safe ceiling)

  return {
    // Period the user actually wants — used for filtering and display
    startMonth,
    endMonth,
    label,
    // Wide OE request range — do NOT use these for display or filtering
    oeDateStart: toNaive(oeStart),
    oeDateEnd:   toNaive(oeEnd),
  };
}

function monthKey(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2,'0')}`;
}

function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1))
    .toLocaleString('en-AU', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

// ── Fetch energy + market_value for a given fueltech in a given region ─────────

function matchesFueltech(ft, fueltech) {
  if (fueltech === 'wind')          return ft.includes('wind');
  if (fueltech === 'solar_utility') return ft.includes('solar') && !ft.includes('rooftop');
  return false;
}

async function fetchFueltechData(client, region, fueltech, oeDateStart, oeDateEnd) {
  console.log(`[gwap] getNetworkData energy+market_value ${region} ${fueltech} ${oeDateStart} → ${oeDateEnd} (wide range, filtered in computeGWAP)`);

  const { datatable } = await client.getNetworkData(
    'NEM',
    ['energy', 'market_value'],
    {
      interval:          '1M',
      dateStart:         oeDateStart,
      dateEnd:           oeDateEnd,
      primaryGrouping:   'network_region',
      secondaryGrouping: ['fueltech'],
    }
  );

  if (!datatable?.rows?.length) {
    console.warn('[gwap] getNetworkData returned no rows');
    return {};
  }

  // Log unique combos for debugging
  const seen = new Set();
  for (const row of datatable.rows) {
    const r = row.network_region || row.region;
    const f = row.fueltech || row.fueltech_group || '';
    if (r && f) seen.add(`${r}/${f}`);
  }
  console.log(`[gwap] combos in response: ${[...seen].slice(0, 30).join(', ')}`);

  const out = {};
  for (const row of datatable.rows) {
    const r  = row.network_region || row.region;
    const ft = String(row.fueltech || row.fueltech_group || '').toLowerCase();
    const ts = row.interval;

    if (r !== region) continue;
    if (!matchesFueltech(ft, fueltech)) continue;
    if (!ts) continue;

    const key = monthKey(ts);
    if (!out[key]) out[key] = { energyMWh: 0, marketValueDollars: 0 };
    if (row.energy       != null) out[key].energyMWh          += Number(row.energy);
    if (row.market_value != null) out[key].marketValueDollars += Number(row.market_value);
  }

  const keys = Object.keys(out).sort();
  console.log(`[gwap] ${region} ${fueltech} months: ${keys.length} → ${keys.join(', ')}`);
  return out;
}

// ── Fetch flat (time-weighted) price for region ───────────────────────────────

async function fetchFlatPrice(client, region, oeDateStart, oeDateEnd) {
  console.log(`[gwap] getMarket price ${region} monthly ${oeDateStart} → ${oeDateEnd} (wide range)`);

  const { datatable } = await client.getMarket(
    'NEM',
    ['price'],
    { interval: '1M', dateStart: oeDateStart, dateEnd: oeDateEnd, primaryGrouping: 'network_region' }
  );

  if (!datatable?.rows?.length) {
    console.warn('[gwap] getMarket returned no rows');
    return {};
  }

  const out = {};
  for (const row of datatable.rows) {
    const r  = row.network_region || row.region;
    const ts = row.interval;
    const p  = row.price;
    if (r !== region || !ts || p == null) continue;
    out[monthKey(ts)] = Number(p);
  }

  console.log(`[gwap] ${region} flat price months: ${Object.keys(out).length}`);
  return out;
}

// ── Compute GWAP ──────────────────────────────────────────────────────────────

function computeGWAP(windData, flatPrices, { startMonth, endMonth }) {
  const months = [];
  const cursor = new Date(startMonth);
  while (cursor < endMonth) {
    months.push(monthKey(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  let totalEnergyMWh   = 0;
  let totalMarketValue = 0;
  let flatPriceSum     = 0;
  let flatPriceCount   = 0;

  const monthly = months.map(key => {
    const w  = windData[key];
    const fp = flatPrices[key] ?? null;

    const energyMWh          = w?.energyMWh         ?? null;
    const marketValueDollars = w?.marketValueDollars ?? null;
    const gwap = (energyMWh != null && energyMWh > 0 && marketValueDollars != null)
      ? +(marketValueDollars / energyMWh).toFixed(2)
      : null;

    if (energyMWh != null)          totalEnergyMWh   += energyMWh;
    if (marketValueDollars != null)  totalMarketValue += marketValueDollars;
    if (fp != null)                 { flatPriceSum    += fp; flatPriceCount++; }

    return {
      key,
      label:        monthLabel(key),
      energyGWh:    energyMWh != null ? +(energyMWh / 1000).toFixed(1) : null,
      energyMWh:    energyMWh != null ? +energyMWh.toFixed(0) : null,
      marketValueM: marketValueDollars != null ? +(marketValueDollars / 1e6).toFixed(3) : null,
      gwap,
      flatPrice:    fp != null ? +fp.toFixed(2) : null,
      captureRate:  (gwap != null && fp != null && fp !== 0)
                      ? +(gwap / fp * 100).toFixed(1) : null,
    };
  });

  const annualGWAP = totalEnergyMWh > 0
    ? +(totalMarketValue / totalEnergyMWh).toFixed(2) : null;

  const annualFlatPrice = flatPriceCount > 0
    ? +(flatPriceSum / flatPriceCount).toFixed(2) : null;

  const captureRate = (annualGWAP != null && annualFlatPrice != null && annualFlatPrice !== 0)
    ? +(annualGWAP / annualFlatPrice * 100).toFixed(1) : null;

  return {
    monthly,
    annualGWAP,
    annualFlatPrice,
    captureRate,
    totalWindGWh:      totalEnergyMWh > 0 ? +(totalEnergyMWh / 1000).toFixed(0) : null,
    totalMarketValueM: totalMarketValue > 0 ? +(totalMarketValue / 1e6).toFixed(1) : null,
  };
}

// ── Handler ────────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const region   = (req.query.region   || 'SA1').toUpperCase();
  const fueltech = (req.query.fueltech || 'wind').toLowerCase();

  if (!REGIONS.includes(region)) {
    return res.status(400).json({ error: `Invalid region. Use one of: ${REGIONS.join(', ')}` });
  }
  if (!FUELTECHS.includes(fueltech)) {
    return res.status(400).json({ error: `Invalid fueltech. Use one of: ${FUELTECHS.join(', ')}` });
  }

  const now     = new Date();
  const valYrs  = [now.getUTCFullYear(), now.getUTCFullYear()-1, now.getUTCFullYear()-2];
  let   year    = req.query.year || 'trailing12';
  if (year !== 'trailing12' && !valYrs.includes(parseInt(year, 10))) year = 'trailing12';

  const force    = req.query.force === 'true';
  const cacheKey = `gwap:v5:${region}:${fueltech}:${year}`;

  if (!force) {
    const cached = await kvGet(cacheKey);
    if (cached?.annualGWAP !== undefined) {
      console.log(`[gwap] cache hit: ${cacheKey}`);
      return res.status(200).json({ ...cached, fromCache: true });
    }
  }

  try {
    const range  = buildDateRange(year);
    const client = await getClient();

    const [fueltechData, flatPrices] = await Promise.all([
      fetchFueltechData(client, region, fueltech, range.oeDateStart, range.oeDateEnd),
      fetchFlatPrice(client, region, range.oeDateStart, range.oeDateEnd),
    ]);

    if (!Object.keys(fueltechData).length) {
      return res.status(503).json({
        error: `No ${region} ${fueltech} data from OpenElectricity. The region may have no ${fueltech} generation, or the API is temporarily unavailable.`,
      });
    }

    const { monthly, annualGWAP, annualFlatPrice, captureRate, totalWindGWh, totalMarketValueM } =
      computeGWAP(fueltechData, flatPrices, range);

    const result = {
      success:          true,
      region,
      fueltech,
      year,
      periodLabel:      range.label,
      fetchedAt:        new Date().toISOString(),
      monthly,
      annualGWAP,
      annualFlatPrice,
      captureRate,
      totalGenerationGWh: totalWindGWh,
      totalMarketValueM,
    };

    await kvSet(cacheKey, result);
    console.log(`[gwap] done ${region} ${fueltech} — GWAP $${annualGWAP}/MWh | flat $${annualFlatPrice}/MWh | capture ${captureRate}% | ${totalWindGWh} GWh`);
    return res.status(200).json({ ...result, fromCache: false });

  } catch (err) {
    console.error('[gwap] error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
};
