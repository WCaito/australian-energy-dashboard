/**
 * api/gwap-sa-wind.js
 * Generation-Weighted Average Price (GWAP) — wind or solar_utility, any NEM region
 *
 * ══ METHODOLOGY ════════════════════════════════════════════════════════════════
 *
 * GWAP ($/MWh) = Σ market_value ($) / Σ energy (MWh)
 *
 * Both metrics come from OpenElectricity getNetworkData at monthly resolution.
 * OE computes market_value as Σ(generation × spot_price) across 5-minute dispatch
 * intervals before aggregating — this is a genuine interval-level GWAP, not
 * monthly-avg-price × monthly-energy.
 *
 * Capture rate (%) = annual GWAP / annual flat price × 100
 * Flat price = time-weighted average from getMarket (price) for the same region.
 *
 * ══ QUERY PARAMS ════════════════════════════════════════════════════════════════
 *   ?region=SA1            default SA1, any of NSW1 VIC1 QLD1 SA1 TAS1
 *   ?fueltech=wind         default wind; "solar_utility" for utility solar
 *   ?year=trailing12       default; or 2024 / 2023 / 2022
 *   ?force=true            bypass Redis cache
 *
 * ══ DATA LIMITS & API STRATEGY ══════════════════════════════════════════════════
 *
 * The OE API data limits page (docs.openelectricity.org.au/api-reference/data-limits)
 * constrains response size. At interval=1M with secondaryGrouping=fueltech and
 * primaryGrouping=network_region, a 12-month request returns approximately:
 *   5 regions × ~15 fueltechs × 2 metrics × 12 months ≈ 1,800 rows  ← within limits
 *
 * A multi-year "wide window" approach returns 3–4× that and exceeds the limit.
 *
 * Strategy: one SDK call per period (trailing12 OR a single calendar year),
 * with dateStart/dateEnd scoped EXACTLY to the requested period.
 * Region and fueltech are filtered client-side from the response datatable.
 * Each result is cached individually under gwap:v8:{region}:{fueltech}:{year}.
 *
 * ══ CACHING ═════════════════════════════════════════════════════════════════════
 *   Redis 25h TTL · Key: gwap:v8:{region}:{fueltech}:{year}
 */

'use strict';

const REGIONS   = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'];
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

/**
 * Convert a UTC Date to a timezone-naive AEST string (UTC+10, no DST).
 * OE expects naive AEST datetimes: "YYYY-MM-DDTHH:mm:ss"
 */
function toNaive(utcDate) {
  return new Date(utcDate.getTime() + 10 * 3600 * 1000)
    .toISOString()
    .slice(0, 19);
}

/**
 * Build the exact dateStart/dateEnd for the requested period.
 * Each call is scoped to exactly 12 months — never a multi-year window.
 *
 * trailing12 → last 12 complete calendar months
 * 2024 / 2023 / 2022 → Jan 1 to Dec 31 (or last complete month if current year)
 *
 * Returns { dateStart, dateEnd, startMonth, endMonth, label }
 * dateStart/dateEnd are naive AEST strings passed directly to the OE SDK.
 */
function buildDateRange(yearParam) {
  const now     = new Date();
  const curYear = now.getUTCFullYear();
  const curMo   = now.getUTCMonth() + 1; // 1-based

  let startMonth, endMonth, label;

  if (yearParam === 'trailing12') {
    // Last complete month in 0-based UTC terms is getUTCMonth() (since current month is in progress)
    const lastCompleteM0 = now.getUTCMonth(); // 0-based index of last complete month
    const lastY          = lastCompleteM0 === 0 ? curYear - 1 : curYear;
    const lastM0         = lastCompleteM0 === 0 ? 11 : lastCompleteM0 - 1; // wait — need to re-think

    // Simpler: last complete month = curMo - 1 (1-based). If that's 0, it's Dec of prev year.
    let lcm = curMo - 1;  // 1-based last complete month
    let lcy = curYear;
    if (lcm === 0) { lcm = 12; lcy = curYear - 1; }

    // endMonth = first day of month AFTER last complete month (exclusive boundary for OE)
    endMonth   = new Date(Date.UTC(lcy, lcm, 1));     // e.g. if lcm=2 → Mar 1 = first day of Mar
    // startMonth = 12 months before endMonth
    startMonth = new Date(Date.UTC(lcy - 1, lcm, 1)); // 12 months before

    const startLabel = startMonth.toLocaleString('en-AU', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    const endLabel   = new Date(endMonth - 1).toLocaleString('en-AU', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    label = `${startLabel} – ${endLabel}`;

  } else {
    const yr = parseInt(yearParam, 10);
    // For a past year: full calendar year Jan–Dec.
    // For the current year: Jan through last complete month.
    const lastM = yr < curYear ? 12 : curMo - 1;

    if (lastM === 0) {
      // Edge case: current year and it's January — no complete months yet, treat as error upstream
      startMonth = new Date(Date.UTC(yr, 0, 1));
      endMonth   = new Date(Date.UTC(yr, 0, 1)); // zero-length range
      label = `${yr} (no data yet)`;
    } else {
      startMonth = new Date(Date.UTC(yr, 0, 1));        // Jan 1 of year
      endMonth   = new Date(Date.UTC(yr, lastM, 1));    // first day of month after last complete
      label = lastM === 12
        ? `${yr} (full year)`
        : `Jan – ${new Date(Date.UTC(yr, lastM - 1, 1))
            .toLocaleString('en-AU', { month: 'short', timeZone: 'UTC' })} ${yr}`;
    }
  }

  return {
    dateStart: toNaive(startMonth),
    dateEnd:   toNaive(endMonth),
    startMonth,
    endMonth,
    label,
  };
}

/**
 * Convert an OE interval timestamp to a "YYYY-MM" month key.
 *
 * OE returns naive AEST strings like "2025-01-01T00:00:00" (no timezone).
 * new Date("2025-01-01T00:00:00") in Node.js treats it as LOCAL time — on a
 * UTC server, local=UTC, so getUTCFullYear/Month give the correct year-month.
 * The SDK may also return already-parsed Date objects, which work the same way.
 *
 * DO NOT append "+10:00" — that shifts the UTC equivalent back 10 hours,
 * making Jan 2025 → Dec 2024.
 */
function monthKey(ts) {
  const d = ts instanceof Date ? ts : new Date(String(ts).replace(' ', 'T'));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1))
    .toLocaleString('en-AU', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

// ── Fueltech matching ─────────────────────────────────────────────────────────

function matchesFueltech(ft, fueltech) {
  const f = String(ft || '').toLowerCase();
  if (fueltech === 'wind')          return f.includes('wind');
  if (fueltech === 'solar_utility') return f.includes('solar') && !f.includes('rooftop');
  return false;
}

// ── OE fetches ────────────────────────────────────────────────────────────────

/**
 * Fetch energy + market_value for the requested period.
 * Uses the SDK with exact dateStart/dateEnd — one call per period selection.
 * Returns a map of { 'YYYY-MM': { energyMWh, marketValueDollars } }
 * filtered to the requested region, fueltech, AND date range.
 *
 * Response size: 5 regions × ~15 fueltechs × 2 metrics × 12 months ≈ 1,800 rows
 * — within OE data limits for a single 12-month window.
 */
async function fetchFueltechData(client, region, fueltech, dateStart, dateEnd, startMonth, endMonth) {
  console.log(`[gwap] getNetworkData energy+market_value | ${dateStart} → ${dateEnd}`);

  const { datatable } = await client.getNetworkData(
    'NEM',
    ['energy', 'market_value'],
    {
      interval:          '1M',
      dateStart,
      dateEnd,
      primaryGrouping:   'network_region',
      secondaryGrouping: ['fueltech'],
    }
  );

  if (!datatable?.rows?.length) {
    console.warn('[gwap] getNetworkData returned no rows');
    return {};
  }

  console.log(`[gwap] getNetworkData rows: ${datatable.rows.length}`);

  // Log the fueltech values actually present so we can verify filter logic
  const fueltechs = [...new Set(datatable.rows.map(r => r.fueltech || r.fueltech_group || ''))].slice(0, 20);
  console.log(`[gwap] fueltechs in response: ${fueltechs.join(', ')}`);

  // Build a set of valid month keys for client-side filtering.
  // This is the authoritative filter — discards any rows OE returns outside
  // the requested period (in case OE ignores dateStart/dateEnd).
  const validKeys = new Set();
  const kc = new Date(startMonth);
  while (kc < endMonth) { validKeys.add(monthKey(kc)); kc.setUTCMonth(kc.getUTCMonth() + 1); }
  console.log(`[gwap] expecting months: ${[...validKeys].sort().join(', ')}`);

  const out = {};
  for (const row of datatable.rows) {
    const r  = row.network_region || row.region;
    const ft = row.fueltech || row.fueltech_group || '';
    const ts = row.interval;

    if (r !== region)                   continue;
    if (!matchesFueltech(ft, fueltech)) continue;
    if (!ts)                            continue;

    const key = monthKey(ts);
    if (!validKeys.has(key))            continue;  // ← client-side date filter
    if (!out[key]) out[key] = { energyMWh: 0, marketValueDollars: 0 };
    if (row.energy       != null) out[key].energyMWh          += Number(row.energy);
    if (row.market_value != null) out[key].marketValueDollars += Number(row.market_value);
  }

  const keys = Object.keys(out).sort();
  console.log(`[gwap] ${region}/${fueltech} months: ${keys.length} → ${keys.join(', ')}`);
  return out;
}

/**
 * Fetch flat (time-weighted) spot price for the region over the same period.
 * Returns a map of { 'YYYY-MM': price }
 * Response size: 5 regions × 12 months = 60 rows — very small.
 */
async function fetchFlatPrice(client, region, dateStart, dateEnd, startMonth, endMonth) {
  console.log(`[gwap] getMarket price ${region} | ${dateStart} → ${dateEnd}`);

  const { datatable } = await client.getMarket(
    'NEM',
    ['price'],
    { interval: '1M', dateStart, dateEnd, primaryGrouping: 'network_region' }
  );

  if (!datatable?.rows?.length) {
    console.warn('[gwap] getMarket returned no rows');
    return {};
  }

  const validKeys = new Set();
  const kc = new Date(startMonth);
  while (kc < endMonth) { validKeys.add(monthKey(kc)); kc.setUTCMonth(kc.getUTCMonth() + 1); }

  const out = {};
  for (const row of datatable.rows) {
    const r  = row.network_region || row.region;
    const ts = row.interval;
    if (r !== region || !ts || row.price == null) continue;
    const key = monthKey(ts);
    if (!validKeys.has(key)) continue;  // ← client-side date filter
    out[key] = Number(row.price);
  }

  console.log(`[gwap] ${region} flat price months: ${Object.keys(out).length} → ${Object.keys(out).sort().join(', ')}`);
  return out;
}

// ── Compute GWAP ──────────────────────────────────────────────────────────────

function computeGWAP(fueltechData, flatPrices, { startMonth, endMonth }) {
  // Build the canonical ordered list of months in the requested period.
  // cursor steps in UTC month boundaries: Date.UTC(2025,0,1), Date.UTC(2025,1,1), etc.
  // monthKey(cursor) uses getUTCFullYear/Month, matching what fetchFueltechData produces
  // for OE row timestamps parsed as UTC (naive strings, no offset).
  const months = [];
  const cursor = new Date(startMonth);
  while (cursor < endMonth) {
    months.push(monthKey(cursor));   // ← cursor is a Date, use directly
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  let totalEnergyMWh   = 0;
  let totalMarketValue = 0;
  let flatPriceSum     = 0;
  let flatPriceCount   = 0;

  const monthly = months.map(key => {
    const w  = fueltechData[key];
    const fp = flatPrices[key] ?? null;

    const energyMWh          = w?.energyMWh         ?? null;
    const marketValueDollars = w?.marketValueDollars ?? null;
    const gwap = (energyMWh != null && energyMWh > 0 && marketValueDollars != null)
      ? +(marketValueDollars / energyMWh).toFixed(2)
      : null;

    if (energyMWh        != null) totalEnergyMWh   += energyMWh;
    if (marketValueDollars != null) totalMarketValue += marketValueDollars;
    if (fp               != null) { flatPriceSum += fp; flatPriceCount++; }

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
    totalGenerationGWh: totalEnergyMWh > 0 ? +(totalEnergyMWh / 1000).toFixed(0) : null,
    totalMarketValueM:  totalMarketValue > 0 ? +(totalMarketValue / 1e6).toFixed(1) : null,
  };
}

// ── Handler ────────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Validate params ──────────────────────────────────────────────────────────

  const region   = (req.query.region   || 'SA1').toUpperCase();
  const fueltech = (req.query.fueltech || 'wind').toLowerCase();

  if (!REGIONS.includes(region)) {
    return res.status(400).json({ error: `Invalid region. Use one of: ${REGIONS.join(', ')}` });
  }
  if (!FUELTECHS.includes(fueltech)) {
    return res.status(400).json({ error: `Invalid fueltech. Use one of: ${FUELTECHS.join(', ')}` });
  }

  const now    = new Date();
  const valYrs = [now.getUTCFullYear(), now.getUTCFullYear() - 1, now.getUTCFullYear() - 2];
  let year = req.query.year || 'trailing12';
  if (year !== 'trailing12' && !valYrs.includes(parseInt(year, 10))) year = 'trailing12';

  // ── Cache ────────────────────────────────────────────────────────────────────

  const force    = req.query.force === 'true';
  const cacheKey = `gwap:v8:${region}:${fueltech}:${year}`;

  if (!force) {
    const cached = await kvGet(cacheKey);
    if (cached?.annualGWAP !== undefined) {
      console.log(`[gwap] cache hit: ${cacheKey}`);
      return res.status(200).json({ ...cached, fromCache: true });
    }
  }

  // ── Fetch ────────────────────────────────────────────────────────────────────

  try {
    const range  = buildDateRange(year);
    const client = await getClient();

    console.log(`[gwap] period: ${range.label} | ${range.dateStart} → ${range.dateEnd} | ${region} ${fueltech}`);

    // Two targeted SDK calls for the exact requested period only.
    // Call 1: energy+market_value → ~1,800 rows max (all fueltechs, all regions, 12 months)
    // Call 2: price → ~60 rows max (all regions, 12 months)
    // Both are within OE data limits for a single 12-month window.
    const [fueltechData, flatPrices] = await Promise.all([
      fetchFueltechData(client, region, fueltech, range.dateStart, range.dateEnd, range.startMonth, range.endMonth),
      fetchFlatPrice(client, region, range.dateStart, range.dateEnd, range.startMonth, range.endMonth),
    ]);

    if (!Object.keys(fueltechData).length) {
      return res.status(503).json({
        error:
          `No ${region} ${fueltech} data for ${range.label}. ` +
          `The region may have no ${fueltech} generation in this period, ` +
          `or the API returned an unexpected format — check server logs.`,
      });
    }

    const {
      monthly, annualGWAP, annualFlatPrice, captureRate,
      totalGenerationGWh, totalMarketValueM,
    } = computeGWAP(fueltechData, flatPrices, range);

    const result = {
      success:            true,
      region,
      fueltech,
      year,
      periodLabel:        range.label,
      fetchedAt:          new Date().toISOString(),
      monthly,
      annualGWAP,
      annualFlatPrice,
      captureRate,
      totalGenerationGWh,
      totalMarketValueM,
    };

    await kvSet(cacheKey, result);
    console.log(
      `[gwap] ✓ ${region} ${fueltech} ${year}` +
      ` | GWAP $${annualGWAP}/MWh | flat $${annualFlatPrice}/MWh` +
      ` | capture ${captureRate}% | ${totalGenerationGWh} GWh`
    );
    return res.status(200).json({ ...result, fromCache: false });

  } catch (err) {
    console.error('[gwap] error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
};
