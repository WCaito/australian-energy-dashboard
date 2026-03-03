/**
 * api/scenario.js — Merchant Revenue Scenario Simulator
 *
 * Simulates the historical energy-market revenue for a hypothetical solar
 * or wind project in any NEM region, using actual AEMO spot prices and
 * real fleet-level GWAP data from OpenElectricity.
 *
 * ══ METHODOLOGY ══════════════════════════════════════════════════════════════
 *
 * Revenue = Capacity (MW) × Capacity Factor × Hours in period × GWAP ($/MWh) × MLF
 *
 * GWAP (Generation-Weighted Average Price) is the price actually EARNED by a
 * fleet of wind or solar generators — it reflects when that technology generates,
 * not a simple time average. It is fetched from the OpenElectricity API at
 * monthly resolution, giving real fleet-level capture rates.
 *
 * Capacity Factor (CF):
 *   The fraction of maximum possible generation actually produced. Two modes:
 *   1. Default: region + technology specific annual averages (AEMO/AER data)
 *      with month-level seasonal adjustments applied.
 *   2. Override: user supplies a specific annual CF (0.01–0.95).
 *   Seasonal adjustment factors are always applied to give monthly CF variation.
 *
 * PPA overlay (optional):
 *   When a PPA strike price is supplied, each month computes:
 *     PPA revenue    = energy × strike
 *     Spot revenue   = energy × GWAP
 *     Hedge payoff   = energy × (strike − GWAP)  [positive = hedge pays out]
 *
 * MLF (Marginal Loss Factor):
 *   Network location discount applied to effective price. Range: 0.80–1.10.
 *   Default 1.0. Revenue = energy × effective_price × MLF.
 *
 * ══ CAPACITY FACTOR DEFAULTS ═════════════════════════════════════════════════
 *
 *   Solar (utility-scale, DC-AC ratio ~1.3, single-axis tracking typical):
 *     NSW1 0.22 · VIC1 0.21 · QLD1 0.26 · SA1 0.24 · TAS1 0.16
 *   Wind:
 *     NSW1 0.31 · VIC1 0.35 · QLD1 0.28 · SA1 0.38 · TAS1 0.43
 *
 *   Sources: AEMO Generation Information 2024, AER State of the Energy Market 2024
 *
 * ══ QUERY PARAMS ═════════════════════════════════════════════════════════════
 *   ?region=SA1              NEM region (NSW1 VIC1 QLD1 SA1 TAS1)
 *   ?fueltech=solar_utility  solar_utility or wind
 *   ?capacity=100            Installed capacity in MW (1–2000)
 *   ?mlf=0.95                Marginal Loss Factor (0.80–1.10, default 1.0)
 *   ?year=trailing12         trailing12 or 2024 / 2023 / 2022
 *   ?ppa_strike=65           Optional PPA strike price in $/MWh
 *   ?cf_override=0.28        Optional capacity factor override (0.01–0.95)
 *   ?force=true              Bypass Redis cache
 *
 * ══ CACHING ══════════════════════════════════════════════════════════════════
 *   Redis 25h TTL per unique param combination.
 *   Key: scenario:v2:{region}:{fueltech}:{year}
 *   (capacity, mlf, ppa_strike, cf_override are post-processing — not cached separately)
 */

'use strict';

const REGIONS   = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'];
const FUELTECHS = ['wind', 'solar_utility'];

// ── Default capacity factors (annual average, fractional) ─────────────────────
const DEFAULT_CF = {
  solar_utility: { NSW1: 0.22, VIC1: 0.21, QLD1: 0.26, SA1: 0.24, TAS1: 0.16 },
  wind:          { NSW1: 0.31, VIC1: 0.35, QLD1: 0.28, SA1: 0.38, TAS1: 0.43 },
};

// Seasonal CF multipliers (applied to annual CF to give monthly variation).
// Australian seasons: DJF=summer, MAM=autumn, JJA=winter, SON=spring.
// Solar: peaks in summer (more sun hours), troughs in winter.
// Wind:  peaks in winter (stronger frontal systems), troughs in summer.
const SEASONAL_CF_MULT = {
  solar_utility: { summer: 1.22, autumn: 0.98, winter: 0.73, spring: 1.07 },
  wind:          { summer: 0.84, autumn: 0.96, winter: 1.18, spring: 1.02 },
};

const MONTH_SEASON = {
  1:'summer', 2:'summer', 12:'summer',
  3:'autumn', 4:'autumn',  5:'autumn',
  6:'winter', 7:'winter',  8:'winter',
  9:'spring',10:'spring', 11:'spring',
};

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
  } catch (e) { console.warn('[scenario] kvGet:', e.message); return null; }
}
async function kvSet(key, value, ex = 25 * 3600) {
  try {
    if (!process.env.UPSTASH_REDIS_REST_URL) return;
    await (await getRedis()).set(key, value, { ex });
  } catch (e) { console.warn('[scenario] kvSet:', e.message); }
}

// ── OE client ──────────────────────────────────────────────────────────────────
async function getClient() {
  const { OpenElectricityClient } = await import('openelectricity');
  const apiKey = process.env.OPENELECTRICITY_API_KEY;
  if (!apiKey) throw new Error('OPENELECTRICITY_API_KEY not set');
  return new OpenElectricityClient({ apiKey });
}

// ── Date helpers ───────────────────────────────────────────────────────────────
function toNaive(utcDate) {
  return new Date(utcDate.getTime() + 10 * 3600 * 1000).toISOString().slice(0, 19);
}

function monthKey(ts) {
  const d = ts instanceof Date ? ts : new Date(String(ts).replace(' ', 'T'));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1))
    .toLocaleString('en-AU', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

function buildDateRange(yearParam) {
  const now     = new Date();
  const curYear = now.getUTCFullYear();
  const curMo   = now.getUTCMonth() + 1;

  let startMonth, endMonth, label;

  if (yearParam === 'trailing12') {
    let lcm = curMo - 1, lcy = curYear;
    if (lcm === 0) { lcm = 12; lcy = curYear - 1; }
    endMonth   = new Date(Date.UTC(lcy, lcm, 1));
    startMonth = new Date(Date.UTC(lcy - 1, lcm, 1));
    const s = startMonth.toLocaleString('en-AU', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    const e = new Date(endMonth - 1).toLocaleString('en-AU', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    label = `${s} – ${e}`;
  } else {
    const yr   = parseInt(yearParam, 10);
    const lastM = yr < curYear ? 12 : curMo - 1;
    startMonth = new Date(Date.UTC(yr, 0, 1));
    endMonth   = new Date(Date.UTC(yr, lastM, 1));
    label = lastM === 12 ? `${yr} (full year)` :
      `Jan – ${new Date(Date.UTC(yr, lastM - 1, 1)).toLocaleString('en-AU', { month: 'short', timeZone: 'UTC' })} ${yr}`;
  }

  return { dateStart: toNaive(startMonth), dateEnd: toNaive(endMonth), startMonth, endMonth, label };
}

function matchesFueltech(ft, fueltech) {
  const f = String(ft || '').toLowerCase();
  if (fueltech === 'wind')          return f.includes('wind') && !f.includes('offshore');
  if (fueltech === 'solar_utility') return f.includes('solar') && !f.includes('rooftop');
  return false;
}

// ── OE fetch: GWAP data ────────────────────────────────────────────────────────
async function fetchGWAPData(client, region, fueltech, range) {
  const { dateStart, dateEnd, startMonth, endMonth } = range;

  const validKeys = new Set();
  const kc = new Date(startMonth);
  while (kc < endMonth) { validKeys.add(monthKey(kc)); kc.setUTCMonth(kc.getUTCMonth() + 1); }

  // Fetch energy + market_value for GWAP computation
  const [energyResp, priceResp] = await Promise.all([
    client.getNetworkData('NEM', ['energy', 'market_value'], {
      interval: '1M', dateStart, dateEnd,
      primaryGrouping: 'network_region',
      secondaryGrouping: ['fueltech'],
    }),
    client.getMarket('NEM', ['price'], {
      interval: '1M', dateStart, dateEnd,
      primaryGrouping: 'network_region',
    }),
  ]);

  // Build monthly fueltech data
  const fueltechData = {};
  for (const row of (energyResp?.datatable?.rows || [])) {
    const r  = row.network_region || row.region;
    const ft = row.fueltech || row.fueltech_group || '';
    const ts = row.interval;
    if (r !== region || !matchesFueltech(ft, fueltech) || !ts) continue;
    const key = monthKey(ts);
    if (!validKeys.has(key)) continue;
    if (!fueltechData[key]) fueltechData[key] = { energyMWh: 0, marketValueDollars: 0 };
    if (row.energy       != null) fueltechData[key].energyMWh          += Number(row.energy);
    if (row.market_value != null) fueltechData[key].marketValueDollars += Number(row.market_value);
  }

  // Build monthly flat prices
  const flatPrices = {};
  for (const row of (priceResp?.datatable?.rows || [])) {
    const r  = row.network_region || row.region;
    const ts = row.interval;
    if (r !== region || !ts || row.price == null) continue;
    const key = monthKey(ts);
    if (!validKeys.has(key)) continue;
    flatPrices[key] = Number(row.price);
  }

  // Build ordered months list
  const months = [];
  const cursor = new Date(startMonth);
  while (cursor < endMonth) {
    months.push(monthKey(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return { fueltechData, flatPrices, months };
}

// ── Revenue simulation ─────────────────────────────────────────────────────────
function simulateRevenue({ fueltechData, flatPrices, months }, {
  fueltech, region, capacityMW, mlf, cfOverride, ppaStrike,
}) {
  const annualCF  = cfOverride !== null ? cfOverride : DEFAULT_CF[fueltech][region];
  const seasonal  = SEASONAL_CF_MULT[fueltech];
  const ftLabel   = fueltech === 'solar_utility' ? 'Solar' : 'Wind';

  let totalEnergyMWh       = 0;
  let totalRevenueSpot     = 0;
  let totalRevenuePPA      = 0;
  let totalMarketValue     = 0;
  let totalFlatPriceSum    = 0;
  let flatPriceCount       = 0;
  let fleetTotalEnergyMWh  = 0;
  let fleetTotalMktVal     = 0;

  const monthly = months.map(key => {
    const [yr, mo] = key.split('-').map(Number);
    const season   = MONTH_SEASON[mo];
    const mult     = seasonal[season] || 1.0;
    const monthlyCF = Math.min(0.95, annualCF * mult);

    // Days in month
    const daysInMonth = new Date(yr, mo, 0).getDate();
    const hoursInMonth = daysInMonth * 24;

    // Hypothetical project energy generation (MWh)
    const energyMWh = +(capacityMW * monthlyCF * hoursInMonth).toFixed(0);

    // Actual fleet GWAP for this month (from OE)
    const fd  = fueltechData[key];
    const gwap = (fd && fd.energyMWh > 0 && fd.marketValueDollars != null)
      ? fd.marketValueDollars / fd.energyMWh  // $/MWh
      : null;

    const flatPrice = flatPrices[key] ?? null;
    const captureRate = (gwap != null && flatPrice != null && flatPrice !== 0)
      ? +(gwap / flatPrice * 100).toFixed(1) : null;

    // Revenue calculations
    const effectiveGWAP = gwap !== null ? gwap * mlf : null;
    const revenueSpot   = effectiveGWAP !== null ? +(energyMWh * effectiveGWAP).toFixed(0) : null;
    const revenuePPA    = ppaStrike !== null ? +(energyMWh * ppaStrike * mlf).toFixed(0) : null;
    const hedgePayoff   = (revenueSpot !== null && revenuePPA !== null)
      ? +(revenuePPA - revenueSpot).toFixed(0) : null;

    // Accumulate totals
    if (revenueSpot !== null) {
      totalEnergyMWh   += energyMWh;
      totalRevenueSpot += revenueSpot;
    }
    if (revenuePPA !== null) totalRevenuePPA += revenuePPA;
    if (gwap !== null && fd) {
      fleetTotalEnergyMWh += fd.energyMWh;
      fleetTotalMktVal    += fd.marketValueDollars;
    }
    if (flatPrice !== null) {
      totalFlatPriceSum += flatPrice;
      flatPriceCount++;
    }

    return {
      key,
      label:         monthLabel(key),
      month:         mo,
      year:          yr,
      season,
      annualCF:      +annualCF.toFixed(4),
      monthlyCF:     +monthlyCF.toFixed(4),
      hoursInMonth,
      energyMWh,
      energyGWh:     +(energyMWh / 1000).toFixed(2),
      gwap:          gwap !== null ? +gwap.toFixed(2) : null,
      effectiveGWAP: effectiveGWAP !== null ? +effectiveGWAP.toFixed(2) : null,
      flatPrice:     flatPrice !== null ? +flatPrice.toFixed(2) : null,
      captureRate,
      revenueSpot,
      revenuePPA,
      hedgePayoff,
    };
  });

  // Add cumulative revenue field
  let cumulativeSpot = 0;
  let cumulativePPA  = 0;
  for (const m of monthly) {
    if (m.revenueSpot !== null) cumulativeSpot += m.revenueSpot;
    if (m.revenuePPA  !== null) cumulativePPA  += m.revenuePPA;
    m.cumulativeSpot = cumulativeSpot;
    m.cumulativePPA  = ppaStrike !== null ? cumulativePPA : null;
  }

  // Annual summary
  const monthsWithData  = monthly.filter(m => m.gwap !== null);
  const annualGWAP      = fleetTotalEnergyMWh > 0
    ? +(fleetTotalMktVal / fleetTotalEnergyMWh).toFixed(2) : null;
  const annualFlatPrice = flatPriceCount > 0
    ? +(totalFlatPriceSum / flatPriceCount).toFixed(2) : null;
  const annualCaptureRate = (annualGWAP != null && annualFlatPrice != null && annualFlatPrice !== 0)
    ? +(annualGWAP / annualFlatPrice * 100).toFixed(1) : null;

  // P10/P50/P90 from monthly spot revenue distribution
  const spotRevenues = monthsWithData.map(m => m.revenueSpot).filter(v => v !== null).sort((a, b) => a - b);
  const pct = (arr, p) => arr.length === 0 ? null : arr[Math.min(Math.floor(p / 100 * arr.length), arr.length - 1)];
  const annualisedFrom = (monthlyVal) => monthlyVal !== null ? Math.round(monthlyVal * 12) : null;

  // Best and worst months
  const rankedMonths = [...monthsWithData].filter(m => m.revenueSpot !== null)
    .sort((a, b) => b.revenueSpot - a.revenueSpot);
  const bestMonth  = rankedMonths[0] || null;
  const worstMonth = rankedMonths[rankedMonths.length - 1] || null;

  const annual = {
    totalEnergyMWh:    Math.round(totalEnergyMWh),
    totalEnergyGWh:    +(totalEnergyMWh / 1000).toFixed(1),
    revenueSpot:       Math.round(totalRevenueSpot),
    revenuePPA:        ppaStrike !== null ? Math.round(totalRevenuePPA) : null,
    totalHedgePayoff:  ppaStrike !== null ? Math.round(totalRevenuePPA - totalRevenueSpot) : null,
    revenuePerMW:      totalEnergyMWh > 0 ? Math.round(totalRevenueSpot / capacityMW) : null,
    revenueSpotM:      +(totalRevenueSpot / 1e6).toFixed(3),
    revenuePPAM:       ppaStrike !== null ? +(totalRevenuePPA / 1e6).toFixed(3) : null,
    annualGWAP,
    annualFlatPrice,
    annualCaptureRate,
    annualCF:          +annualCF.toFixed(4),
    assumedAnnualCF:   +annualCF.toFixed(4),
    cfOverrideUsed:    cfOverride !== null,
    p10AnnualisedRevenue: annualisedFrom(pct(spotRevenues, 10)),
    p50AnnualisedRevenue: annualisedFrom(pct(spotRevenues, 50)),
    p90AnnualisedRevenue: annualisedFrom(pct(spotRevenues, 90)),
    bestMonth:  bestMonth  ? { label: bestMonth.label,  revenue: bestMonth.revenueSpot,  gwap: bestMonth.gwap  } : null,
    worstMonth: worstMonth ? { label: worstMonth.label, revenue: worstMonth.revenueSpot, gwap: worstMonth.gwap } : null,
    monthsWithData: monthsWithData.length,
    totalMonths:    monthly.length,
  };

  const assumptions = {
    annualCF:          +annualCF.toFixed(4),
    cfSource:          cfOverride !== null ? 'User override' : `AEMO/AER default for ${region} ${ftLabel}`,
    seasonalAdjustments: seasonal,
    mlfApplied:        mlf,
    gwapSource:        'OpenElectricity API — actual fleet-level GWAP',
    capacityMW,
    ppaStrike:         ppaStrike ?? null,
    region,
    fueltech,
  };

  return { monthly, annual, assumptions };
}

// ── Handler ────────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Validate + parse params ──────────────────────────────────────────────────
  const region   = (req.query.region   || 'SA1').toUpperCase();
  const fueltech = (req.query.fueltech || 'solar_utility').toLowerCase();

  if (!REGIONS.includes(region))   return res.status(400).json({ error: `Invalid region. Use: ${REGIONS.join(', ')}` });
  if (!FUELTECHS.includes(fueltech)) return res.status(400).json({ error: `Invalid fueltech. Use: ${FUELTECHS.join(', ')}` });

  const capacityMW = Math.max(1, Math.min(2000, parseFloat(req.query.capacity || '100') || 100));
  const mlf        = Math.max(0.80, Math.min(1.10, parseFloat(req.query.mlf || '1.0') || 1.0));
  const cfOverride = req.query.cf_override
    ? Math.max(0.01, Math.min(0.95, parseFloat(req.query.cf_override))) : null;
  const ppaStrike  = req.query.ppa_strike
    ? Math.max(0, Math.min(500, parseFloat(req.query.ppa_strike))) : null;

  const now    = new Date();
  const valYrs = [now.getUTCFullYear(), now.getUTCFullYear()-1, now.getUTCFullYear()-2, now.getUTCFullYear()-3];
  let year = req.query.year || 'trailing12';
  if (year !== 'trailing12' && !valYrs.includes(parseInt(year, 10))) year = 'trailing12';

  const force    = req.query.force === 'true';
  // Cache key covers only the market data fetch (GWAP by region/fueltech/year)
  // Revenue computation is done server-side with params
  const cacheKey = `scenario:v2:${region}:${fueltech}:${year}`;

  console.log(`[scenario] ${region} ${fueltech} ${year} | cap=${capacityMW}MW mlf=${mlf} cf_override=${cfOverride} ppa=${ppaStrike}`);

  // ── Try cache for GWAP data ───────────────────────────────────────────────────
  let gwapData = null;
  if (!force) {
    const cached = await kvGet(cacheKey);
    if (cached?.months?.length) {
      console.log(`[scenario] cache hit: ${cacheKey}`);
      gwapData = cached;
    }
  }

  // ── Fetch GWAP data from OE if not cached ─────────────────────────────────────
  if (!gwapData) {
    try {
      const range  = buildDateRange(year);
      const client = await getClient();
      const fetched = await fetchGWAPData(client, region, fueltech, range);
      if (!Object.keys(fetched.fueltechData).length) {
        return res.status(503).json({
          error: `No ${region} ${fueltech} GWAP data available for ${range.label}. ` +
                 `This region may have no utility ${fueltech} in the period, or the API returned no data.`,
          region, fueltech, year,
        });
      }
      gwapData = { ...fetched, range };
      await kvSet(cacheKey, gwapData);
    } catch (err) {
      console.error('[scenario] OE fetch error:', err.message);
      return res.status(500).json({ error: 'Failed to fetch market data', message: err.message });
    }
  }

  // ── Run revenue simulation ─────────────────────────────────────────────────────
  const range = gwapData.range || buildDateRange(year);
  const { monthly, annual, assumptions } = simulateRevenue(gwapData, {
    fueltech, region, capacityMW, mlf, cfOverride, ppaStrike,
  });

  const ftLabel = fueltech === 'solar_utility' ? 'Utility Solar' : 'Wind';

  return res.status(200).json({
    success:     true,
    region,
    fueltech,
    fueltechLabel: ftLabel,
    year,
    periodLabel: range.label || '',
    fetchedAt:   new Date().toISOString(),
    inputs:  { capacityMW, mlf, cfOverride, ppaStrike, year },
    monthly,
    annual,
    assumptions,
    defaultCF: DEFAULT_CF[fueltech][region],
    fromCache: !!gwapData._fromCache,
  });
};
