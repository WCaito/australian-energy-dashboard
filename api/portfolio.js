/**
 * api/portfolio.js — Physically Flat Portfolio Dispatch Simulator
 *
 * Simulates delivering a flat MW target to a customer (e.g. a data centre)
 * from a portfolio of specific named wind/solar facilities plus optional
 * gas firming, using actual historical generation and AEMO spot prices.
 *
 * ══ INTERVAL RATIONALE ═══════════════════════════════════════════════════════
 *
 * The OpenElectricity API enforces these range limits per request:
 *   5-min  →  8 days max  →  ~46 requests/facility for 12 months  ✗ too many
 *   1-hour → 32 days max  →  12 monthly chunks for 12 months       ✓ practical
 *
 * We therefore use 1-hour intervals from OE for facility generation data.
 * AEMO CSVs provide 30-min spot prices which we average in pairs to hourly.
 *
 * Sub-hourly price spike events (single 30-min intervals at $15,000/MWh) are
 * averaged with their neighbour, slightly understating extreme cost volatility.
 * For portfolio product DESIGN this is an acceptable trade-off.
 *
 * ══ DISPATCH LOGIC (per hour t) ═══════════════════════════════════════════════
 *
 *   renewableOutput[t] = Σ facilityOutput[f][t] × MLF[f]
 *   shortfall[t]  = max(0, targetMW − renewableOutput[t])
 *   surplus[t]    = max(0, renewableOutput[t] − targetMW)
 *
 *   Gas fires only when it is cheaper than buying from spot:
 *     if spotPrice[t] < gasSRMC OR gasMW == 0:
 *       gasFired[t]    = 0
 *       spotPurchase[t] = shortfall[t]
 *     else:
 *       gasFired[t]    = min(shortfall[t], gasMW)
 *       spotPurchase[t] = max(0, shortfall[t] − gasFired[t])
 *
 *   P&L per hour (×1h to convert MW → MWh):
 *     flatRevenue[t]   = targetMW × flatPrice
 *     gasCost[t]       = gasFired[t] × gasSRMC
 *     spotCost[t]      = spotPurchase[t] × spotPrice[t]   (negative = windfall)
 *     curtailRev[t]    = surplus[t] × max(0, spotPrice[t])
 *     renewableCost[t] = renewableOutput[t] × renewableLCOE
 *     netMargin[t]     = flatRevenue + curtailRev − gasCost − spotCost − renewableCost
 *
 * ══ COVERAGE CURVE ═══════════════════════════════════════════════════════════
 *
 *   Sweeps gasMW from 0 → targetMW. For each value:
 *     coverage(g) = (hours where renewableOutput[t] + g ≥ targetMW) / totalHours
 *   This is the primary product design tool — you read off the gas capacity
 *   required to hit 95% or 99% physical coverage.
 *
 * ══ QUERY PARAMS ══════════════════════════════════════════════════════════════
 *   ?facilities=CODE1,CODE2     Comma-separated OE facility codes
 *   ?mlfs=1.0,0.95              Per-facility MLFs (default 1.0 each)
 *   ?target_mw=100              Flat delivery target in MW
 *   ?delivery_region=SA1        NEM region for spot price purchases
 *   ?gas_mw=50                  Gas firming capacity in MW (0 = no gas)
 *   ?gas_srmc=120               Gas short-run marginal cost $/MWh
 *   ?flat_price=95              Flat supply price to buyer $/MWh
 *   ?renewable_lcoe=65          Blended renewable LCOE $/MWh (seller cost)
 *   ?year=2024                  Calendar year, or 'trailing12'
 *   ?coverage_curve=true        Also return coverage curve (sweeps gas 0→target)
 *   ?force=true                 Bypass Redis generation/price data cache
 */

'use strict';

const REGIONS = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'];
const COVERAGE_CURVE_STEPS = 50; // number of gas MW points in the coverage curve

// ── Redis helpers ──────────────────────────────────────────────────────────────

async function getRedis() {
  const { Redis } = await import('@upstash/redis');
  return new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
}

async function kvGet(key) {
  try {
    if (!process.env.UPSTASH_REDIS_REST_URL) return null;
    const r = await (await getRedis()).get(key);
    return r?.data ?? null;
  } catch (e) { console.warn('[portfolio] kvGet:', e.message); return null; }
}

async function kvSet(key, value, ex = 86400) {
  try {
    if (!process.env.UPSTASH_REDIS_REST_URL) return;
    await (await getRedis()).set(key, { data: value, cachedAt: new Date().toISOString() }, { ex });
  } catch (e) { console.warn('[portfolio] kvSet:', e.message); }
}

// ── OE client ──────────────────────────────────────────────────────────────────

async function getClient() {
  const { OpenElectricityClient } = await import('openelectricity');
  const apiKey = process.env.OPENELECTRICITY_API_KEY;
  if (!apiKey) throw new Error('OPENELECTRICITY_API_KEY not set');
  return new OpenElectricityClient({ apiKey });
}

// ── Timestamp helpers ──────────────────────────────────────────────────────────

/**
 * Convert an AEST-naive datetime string to AEST hour key "YYYY-MM-DDTHH".
 * Mirrors the toEpochMs pattern in bess-nsw.js: if no timezone suffix,
 * treat as AEST (+10:00).
 */
function oeToHourKey(ts) {
  if (!ts) return null;
  try {
    let s = String(ts).replace(' ', 'T').replace(/\.\d+/, '');
    // If no timezone info, treat as AEST (UTC+10)
    if (!s.endsWith('Z') && !/[+-]\d{2}:\d{2}$/.test(s)) s += '+10:00';
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    // Convert UTC epoch → AEST by adding 10h, then take the hour portion
    const aest = new Date(d.getTime() + 10 * 3600000);
    return aest.toISOString().slice(0, 13);
  } catch { return null; }
}

/**
 * Convert an AEMO SETTLEMENTDATE (interval END, AEST) to an AEST hour key.
 * "2024/01/15 14:30:00" → interval 14:00–14:30 → "2024-01-15T14"
 * "2024/01/15 15:00:00" → interval 14:30–15:00 → "2024-01-15T14"
 */
function settlementToHourKey(raw) {
  try {
    const s = String(raw).replace(/\//g, '-').replace(' ', 'T');
    const [dateStr, timeStr] = s.split('T');
    const [h, m] = timeStr.split(':').map(Number);
    if (m === 30) return `${dateStr}T${String(h).padStart(2, '0')}`;
    if (h === 0) {
      const [yr, mo, dy] = dateStr.split('-').map(Number);
      const prev = new Date(Date.UTC(yr, mo - 1, dy - 1));
      return `${prev.toISOString().slice(0, 10)}T23`;
    }
    return `${dateStr}T${String(h - 1).padStart(2, '0')}`;
  } catch { return null; }
}

/**
 * Format a UTC Date object as an AEST-naive datetime string "YYYY-MM-DDTHH:MM:SS".
 * This matches the toLocalNaive pattern used in bess-nsw.js and facility-data.js.
 */
function toAESTNaive(date) {
  const aest = new Date(date.getTime() + 10 * 3600 * 1000);
  return aest.toISOString().slice(0, 19);
}

function isPastMonth(year, month) {
  const now = new Date();
  return year < now.getUTCFullYear() ||
    (year === now.getUTCFullYear() && month < now.getUTCMonth() + 1);
}

// ── Date range builder ─────────────────────────────────────────────────────────

function buildMonthList(yearParam) {
  const now = new Date();
  const curY = now.getUTCFullYear();
  const curM = now.getUTCMonth() + 1;

  let lastY = curY, lastM = curM - 1;
  if (lastM === 0) { lastM = 12; lastY--; }

  if (yearParam === 'trailing12') {
    const months = [];
    let y = lastY, m = lastM;
    for (let i = 0; i < 12; i++) {
      months.unshift({ year: y, month: m });
      m--;
      if (m === 0) { m = 12; y--; }
    }
    return months;
  }

  const yr = parseInt(yearParam, 10);
  const endM = yr < curY ? 12 : lastM;
  const months = [];
  for (let m = 1; m <= endM; m++) months.push({ year: yr, month: m });
  return months;
}

// ── OE facility data fetch ─────────────────────────────────────────────────────
//
// Uses interval: '5m' — the only interval confirmed working with getFacilityData
// in this codebase (bess-nsw.js, facility-data.js both use 5m exclusively).
//
// A calendar month (28-31 days) exceeds the 8-day limit for 5m data.
// Solution: split each month into 7-day chunks. Each chunk is cached separately
// in Redis. First cold run fetches all chunks in parallel; subsequent runs are
// instant from cache.
//
// Chunks use AEST-naive datetime strings "YYYY-MM-DDTHH:MM:SS" (no timezone),
// matching the toLocalNaive format used in bess-nsw.js and facility-data.js.
//
// 5-min readings are averaged to hourly (12 readings per hour → mean MW).

function build7dayChunks(year, month) {
  const monthStr    = `${year}-${String(month).padStart(2, '0')}`;
  const daysInMonth = new Date(year, month, 0).getDate();
  const chunks      = [];

  for (let day = 1; day <= daysInMonth; day += 7) {
    const endDay  = Math.min(day + 6, daysInMonth);
    const dayStr  = String(day).padStart(2, '0');
    const endStr  = String(endDay).padStart(2, '0');
    chunks.push({
      cacheKey:  `aed:portfolio:gen:v3:${monthStr}-${dayStr}`,
      dateStart: `${monthStr}-${dayStr}T00:00:00`,
      dateEnd:   `${monthStr}-${endStr}T23:59:59`,
    });
  }
  return chunks;
}

function aggregate5mToHourly(rows) {
  // Bucket 5-min power readings by AEST hour key, then average
  const buckets = {};
  for (const row of rows) {
    const ts  = row.interval || row.date || row.timestamp;
    const key = oeToHourKey(ts);
    if (!key) continue;
    const p = typeof row.power === 'number' ? Math.max(0, row.power) : 0;
    if (!buckets[key]) buckets[key] = { sum: 0, count: 0 };
    buckets[key].sum   += p;
    buckets[key].count += 1;
  }
  const hourly = {};
  for (const [key, b] of Object.entries(buckets)) {
    hourly[key] = b.count > 0 ? +(b.sum / b.count).toFixed(2) : 0;
  }
  return hourly;
}

async function fetchFacilityMonth(client, facilityCode, year, month, force) {
  const chunks = build7dayChunks(year, month);
  const monthStr = `${year}-${String(month).padStart(2, '0')}`;

  const chunkResults = await Promise.all(chunks.map(async chunk => {
    // Check per-chunk Redis cache
    if (!force) {
      const cached = await kvGet(chunk.cacheKey + ':' + facilityCode);
      if (cached && typeof cached === 'object' && Object.keys(cached).length > 0) {
        return cached;
      }
    }

    try {
      // Use interval '5m' — confirmed working pattern from bess-nsw.js and facility-data.js.
      // Date format "YYYY-MM-DDTHH:MM:SS" (AEST naive, no timezone) matches toLocalNaive().
      const { datatable } = await client.getFacilityData(
        'NEM', facilityCode, ['power'],
        { interval: '5m', dateStart: chunk.dateStart, dateEnd: chunk.dateEnd }
      );

      const rows = datatable?.rows || [];
      console.log(`[portfolio] ${facilityCode} ${chunk.dateStart.slice(0,10)}: ${rows.length} rows`);

      if (rows.length > 0 && !rows[0].__logged) {
        console.log(`[portfolio] sample row keys: ${Object.keys(rows[0]).join(', ')}`);
        console.log(`[portfolio] sample row: ${JSON.stringify(rows[0]).slice(0, 200)}`);
      }

      const hourly = aggregate5mToHourly(rows);
      console.log(`[portfolio] ${facilityCode} ${chunk.dateStart.slice(0,10)}: ${Object.keys(hourly).length} hourly buckets`);

      // Only cache if we got real data (never cache empty results)
      if (Object.keys(hourly).length > 0) {
        const ttl = isPastMonth(year, month) ? 7 * 86400 : 3600;
        await kvSet(chunk.cacheKey + ':' + facilityCode, hourly, ttl);
      }
      return hourly;

    } catch (err) {
      console.error(`[portfolio] ${facilityCode} ${chunk.dateStart}: ${err.message}`);
      return {};
    }
  }));

  // Merge all chunk hourly maps into one for this month
  const merged = {};
  for (const h of chunkResults) Object.assign(merged, h);
  console.log(`[portfolio] ${facilityCode} ${monthStr}: ${Object.keys(merged).length} total hour keys`);
  return merged;
}

// ── AEMO CSV price fetch (30-min, averaged to hourly, cached per region-month) ──

async function fetchPriceMonth(region, year, month, force) {
  const monthStr = `${year}-${String(month).padStart(2, '0')}`;
  const cacheKey = `aed:portfolio:price:v1:${region}:${monthStr}`;

  if (!force) {
    const cached = await kvGet(cacheKey);
    if (cached && typeof cached === 'object' && Object.keys(cached).length > 0) return cached;
  }

  const ym  = `${year}${String(month).padStart(2, '0')}`;
  const url = `https://www.aemo.com.au/aemo/data/nem/priceanddemand/PRICE_AND_DEMAND_${ym}_${region}.csv`;

  let text = null;
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 12000);
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal });
    clearTimeout(tid);
    text = resp.ok ? await resp.text() : null;
  } catch { text = null; }

  if (!text) return {};

  const hourly = parseAEMOToHourly(text, region);
  const ttl = isPastMonth(year, month) ? 7 * 86400 : 3600;
  await kvSet(cacheKey, hourly, ttl);
  return hourly;
}

function parseAEMOToHourly(csvText, region) {
  const lines = csvText.split('\n');
  const hdrs  = lines[0].split(',').map(h => h.trim().replace(/"/g, '').toUpperCase());
  const dIdx  = hdrs.indexOf('SETTLEMENTDATE');
  const pIdx  = hdrs.indexOf('RRP');
  const rIdx  = hdrs.indexOf('REGIONID');
  if (dIdx === -1 || pIdx === -1) return {};

  // Collect all prices per hour key
  const buckets = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].trim().split(',');
    if (cols.length <= Math.max(dIdx, pIdx)) continue;

    // Filter by region if REGIONID column present
    if (rIdx !== -1) {
      const rowRegion = cols[rIdx]?.trim().replace(/"/g, '').toUpperCase();
      if (rowRegion && rowRegion !== region) continue;
    }

    const price = parseFloat(cols[pIdx]);
    if (!isFinite(price)) continue;

    const raw     = cols[dIdx].trim().replace(/"/g, '');
    const hourKey = settlementToHourKey(raw);
    if (!hourKey) continue;

    if (!buckets[hourKey]) buckets[hourKey] = [];
    buckets[hourKey].push(price);
  }

  // Average the two 30-min readings per hour
  const result = {};
  for (const [key, prices] of Object.entries(buckets)) {
    result[key] = prices.reduce((a, b) => a + b, 0) / prices.length;
  }
  return result;
}

// ── Dispatch simulation ────────────────────────────────────────────────────────

function runSimulation(hourKeys, genData, priceData, config) {
  const { facilities, targetMW, gasMW, gasSRMC, flatPrice, renewableLCOE } = config;

  // Monthly accumulators — keyed by "YYYY-MM"
  const monthly = {};
  let   annual  = newBucket();
  let   annualHoursTotal = 0;

  // Raw per-hour renewable output (for coverage curve and worst-week search)
  const hourlyRenewable = []; // [{hourKey, renewable, spotPrice, gasFired, spotPurchase, facilityOutputs}]

  for (const hourKey of hourKeys) {
    const mk = hourKey.slice(0, 7);
    if (!monthly[mk]) monthly[mk] = newBucket();

    // Sum facility outputs
    let renewable = 0;
    const outputs = {};
    for (const f of facilities) {
      const raw = (genData[f.code]?.[hourKey] ?? 0);
      const adj = raw * f.mlf;
      outputs[f.code] = adj;
      renewable += adj;
    }

    const spot     = priceData[hourKey] ?? null;
    const shortfall = Math.max(0, targetMW - renewable);
    const surplus   = Math.max(0, renewable   - targetMW);

    // Economic gas dispatch
    let gasFired = 0;
    let spotPurchase = 0;
    if (shortfall > 0 && gasMW > 0) {
      if (spot === null || spot >= gasSRMC) {
        gasFired     = Math.min(shortfall, gasMW);
        spotPurchase = Math.max(0, shortfall - gasFired);
      } else {
        spotPurchase = shortfall; // spot is cheaper than gas
      }
    } else if (shortfall > 0) {
      spotPurchase = shortfall;
    }

    // P&L (each unit = 1 MWh because interval = 1 hour)
    const flatRevenue   = targetMW * flatPrice;
    const gasCost       = gasFired * gasSRMC;
    const spotCost      = spot !== null ? spotPurchase * spot : 0;
    const curtailRev    = (spot !== null && spot > 0) ? surplus * spot : 0;
    const renewableCost = renewable * renewableLCOE;
    const netMargin     = flatRevenue + curtailRev - gasCost - spotCost - renewableCost;

    const hasPrice = spot !== null;

    addToBucket(monthly[mk], { renewable, shortfall, surplus, gasFired, spotPurchase,
      flatRevenue, gasCost, spotCost, curtailRev, renewableCost, netMargin, spot, hasPrice });
    addToBucket(annual,      { renewable, shortfall, surplus, gasFired, spotPurchase,
      flatRevenue, gasCost, spotCost, curtailRev, renewableCost, netMargin, spot, hasPrice });
    annualHoursTotal++;

    hourlyRenewable.push({ hourKey, renewable, spot, gasFired, spotPurchase, surplus, facilityOutputs: outputs });
  }

  // ── Monthly summary array ────────────────────────────────────────────────────
  const monthlyArr = Object.entries(monthly)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, b]) => finalizeBucket(key, b, targetMW, flatPrice, facilities));

  // ── Annual summary ───────────────────────────────────────────────────────────
  const annualSummary = finalizeAnnual(annual, annualHoursTotal, targetMW, flatPrice, facilities);

  // ── Worst 7-day window ───────────────────────────────────────────────────────
  const worstWeek = findWorstWeek(hourlyRenewable, targetMW);

  return { monthly: monthlyArr, annual: annualSummary, worstWeek, hourlyRenewable };
}

function newBucket() {
  return {
    hoursTotal: 0, hoursWithPrice: 0,
    sumRenewable: 0, sumShortfall: 0, sumSurplus: 0,
    sumGasFired: 0, sumSpotPurchase: 0,
    sumFlatRevenue: 0, sumGasCost: 0, sumSpotCost: 0,
    sumCurtailRev: 0, sumRenewableCost: 0, sumNetMargin: 0,
    sumSpotPrice: 0, countCovered: 0, countNegPrice: 0,
  };
}

function addToBucket(b, v) {
  b.hoursTotal++;
  if (v.hasPrice) { b.hoursWithPrice++; b.sumSpotPrice += v.spot; }
  b.sumRenewable     += v.renewable;
  b.sumShortfall     += v.shortfall;
  b.sumSurplus       += v.surplus;
  b.sumGasFired      += v.gasFired;
  b.sumSpotPurchase  += v.spotPurchase;
  b.sumFlatRevenue   += v.flatRevenue;
  b.sumGasCost       += v.gasCost;
  b.sumSpotCost      += v.spotCost;
  b.sumCurtailRev    += v.curtailRev;
  b.sumRenewableCost += v.renewableCost;
  b.sumNetMargin     += v.netMargin;
  // Covered = no residual spot purchase needed (renewable + gas filled the gap)
  if (v.spotPurchase < 0.01) b.countCovered++;
  if (v.spot !== null && v.spot < 0) b.countNegPrice++;
}

function finalizeBucket(monthKey, b, targetMW, flatPrice, facilities) {
  const [yr, mo] = monthKey.split('-').map(Number);
  const label = new Date(Date.UTC(yr, mo - 1, 1))
    .toLocaleString('en-AU', { month: 'short', year: '2-digit', timeZone: 'UTC' });

  const targetMWh     = targetMW * b.hoursTotal;
  const coveragePct   = b.hoursTotal > 0 ? +(b.countCovered / b.hoursTotal * 100).toFixed(1) : null;
  const avgSpotPrice  = b.hoursWithPrice > 0 ? +(b.sumSpotPrice / b.hoursWithPrice).toFixed(2) : null;

  return {
    key: monthKey, label,
    hoursTotal: b.hoursTotal, hoursWithPrice: b.hoursWithPrice,
    targetMWh: +targetMWh.toFixed(0),
    renewableMWh:   +b.sumRenewable.toFixed(0),
    shortfallMWh:   +b.sumShortfall.toFixed(0),
    surplusMWh:     +b.sumSurplus.toFixed(0),
    gasFiredMWh:    +b.sumGasFired.toFixed(0),
    spotPurchMWh:   +b.sumSpotPurchase.toFixed(0),
    coveragePct,
    avgSpotPrice,
    flatRevenue:    +b.sumFlatRevenue.toFixed(0),
    gasCost:        +b.sumGasCost.toFixed(0),
    spotCost:       +b.sumSpotCost.toFixed(0),
    curtailRevenue: +b.sumCurtailRev.toFixed(0),
    renewableCost:  +b.sumRenewableCost.toFixed(0),
    netMargin:      +b.sumNetMargin.toFixed(0),
  };
}

function finalizeAnnual(b, hoursTotal, targetMW, flatPrice, facilities) {
  const targetMWh = targetMW * hoursTotal;
  const avgSpot   = b.hoursWithPrice > 0 ? +(b.sumSpotPrice / b.hoursWithPrice).toFixed(2) : null;

  const renewableCovPct = hoursTotal > 0 ? +(b.countCovered / hoursTotal * 100).toFixed(1) : null;
  const blendedCostPerMWh = targetMWh > 0
    ? +((b.sumGasCost + b.sumSpotCost + b.sumRenewableCost - b.sumCurtailRev) / targetMWh).toFixed(2)
    : null;
  const marginPct = b.sumFlatRevenue > 0
    ? +(b.sumNetMargin / b.sumFlatRevenue * 100).toFixed(1) : null;

  return {
    hoursTotal, hoursWithPrice: b.hoursWithPrice,
    targetMWh: +targetMWh.toFixed(0),
    renewableMWh:   +b.sumRenewable.toFixed(0),
    shortfallMWh:   +b.sumShortfall.toFixed(0),
    surplusMWh:     +b.sumSurplus.toFixed(0),
    gasFiredMWh:    +b.sumGasFired.toFixed(0),
    spotPurchMWh:   +b.sumSpotPurchase.toFixed(0),
    renewableFillPct: targetMWh > 0 ? +(b.sumRenewable / targetMWh * 100).toFixed(1) : null,
    gasFillPct:       targetMWh > 0 ? +(b.sumGasFired   / targetMWh * 100).toFixed(1) : null,
    spotFillPct:      targetMWh > 0 ? +(b.sumSpotPurchase / targetMWh * 100).toFixed(1) : null,
    coveragePct: renewableCovPct,
    avgSpotPrice: avgSpot,
    negPricePct: b.hoursWithPrice > 0 ? +(b.countNegPrice / b.hoursWithPrice * 100).toFixed(1) : null,
    totalFlatRevenue:  +b.sumFlatRevenue.toFixed(0),
    totalGasCost:      +b.sumGasCost.toFixed(0),
    totalSpotCost:     +b.sumSpotCost.toFixed(0),
    totalCurtailRev:   +b.sumCurtailRev.toFixed(0),
    totalRenewableCost: +b.sumRenewableCost.toFixed(0),
    totalNetMargin:    +b.sumNetMargin.toFixed(0),
    blendedCostPerMWh,
    marginPct,
    revenueM:    +(b.sumFlatRevenue / 1e6).toFixed(2),
    marginM:     +(b.sumNetMargin   / 1e6).toFixed(2),
    marginPerMW: hoursTotal > 0 && targetMW > 0
      ? +((b.sumNetMargin) / targetMW).toFixed(0) : null,
  };
}

// ── Worst 7-day (168 consecutive hours) finder ────────────────────────────────

function findWorstWeek(hourly, targetMW) {
  if (hourly.length < 168) return null;
  const W = 168;

  // Rolling window sum of shortfall
  let windowSum = 0;
  for (let i = 0; i < W; i++) windowSum += hourly[i].renewable;
  let minRenewable = windowSum;
  let worstStart = 0;

  for (let i = W; i < hourly.length; i++) {
    windowSum += hourly[i].renewable;
    windowSum -= hourly[i - W].renewable;
    if (windowSum < minRenewable) {
      minRenewable = windowSum;
      worstStart = i - W + 1;
    }
  }

  const window = hourly.slice(worstStart, worstStart + W);
  const totalShortfall = window.reduce((s, h) => s + Math.max(0, targetMW - h.renewable), 0);
  const avgCoverage    = window.filter(h => h.renewable >= targetMW).length / W * 100;

  // Get facility code list from first hour that has data
  const facilityCodes = Object.keys(window.find(h => h.facilityOutputs)?.facilityOutputs || {});

  return {
    startDate: window[0].hourKey.slice(0, 10),
    endDate:   window[W - 1].hourKey.slice(0, 10),
    totalShortfallMWh: +totalShortfall.toFixed(0),
    avgCoverageRenewablePct: +avgCoverage.toFixed(1),
    hourlyData: window.map(h => ({
      hour: h.hourKey,
      renewable: +h.renewable.toFixed(1),
      gasFired:  +h.gasFired.toFixed(1),
      spotPurch: +h.spotPurchase.toFixed(1),
      surplus:   +h.surplus.toFixed(1),
      spotPrice: h.spot !== null ? +h.spot.toFixed(2) : null,
      facilityOutputs: Object.fromEntries(
        Object.entries(h.facilityOutputs || {}).map(([k, v]) => [k, +v.toFixed(1)])
      ),
    })),
  };
}

// ── Coverage curve ────────────────────────────────────────────────────────────
// Returns [{gasMW, coveragePct}] with COVERAGE_CURVE_STEPS + 1 points (0 → targetMW).

function buildCoverageCurve(hourlyRenewable, targetMW) {
  const n = hourlyRenewable.length;
  if (n === 0) return [];

  const renewables = hourlyRenewable.map(h => h.renewable);
  const step = targetMW / COVERAGE_CURVE_STEPS;
  const curve = [];

  for (let i = 0; i <= COVERAGE_CURVE_STEPS; i++) {
    const g = +(i * step).toFixed(1);
    const covered = renewables.filter(r => r + g >= targetMW).length;
    curve.push({ gasMW: g, coveragePct: +(covered / n * 100).toFixed(2) });
  }

  return curve;
}

// ── Main handler ───────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Parse and validate params ──────────────────────────────────────────────

  const rawFacilities = (req.query.facilities || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (rawFacilities.length === 0)
    return res.status(400).json({ error: 'At least one facility code required (?facilities=CODE1,CODE2)' });
  if (rawFacilities.length > 8)
    return res.status(400).json({ error: 'Maximum 8 facilities per simulation' });

  const rawMLFs     = (req.query.mlfs     || '').split(',').map(s => parseFloat(s.trim())).filter(isFinite);
  const rawFueltechs = (req.query.fueltechs || '').split(',').map(s => s.trim().toLowerCase());
  const mlfMap      = Object.fromEntries(rawFacilities.map((code, i) => [code, rawMLFs[i] ?? 1.0]));
  const fueltechMap = Object.fromEntries(rawFacilities.map((code, i) => [code, rawFueltechs[i] || '']));

  const targetMW      = Math.max(1,  Math.min(2000, parseFloat(req.query.target_mw      || '100') || 100));
  const gasMW         = Math.max(0,  Math.min(2000, parseFloat(req.query.gas_mw         || '0')   || 0));
  const gasSRMC       = Math.max(0,  Math.min(500,  parseFloat(req.query.gas_srmc       || '120') || 120));
  const flatPrice     = Math.max(0,  Math.min(500,  parseFloat(req.query.flat_price     || '95')  || 95));
  const renewableLCOE = Math.max(0,  Math.min(300,  parseFloat(req.query.renewable_lcoe || '65')  || 65));

  const deliveryRegion = (req.query.delivery_region || 'SA1').toUpperCase();
  if (!REGIONS.includes(deliveryRegion))
    return res.status(400).json({ error: `Invalid delivery_region. Use: ${REGIONS.join(', ')}` });

  const now    = new Date();
  const valYrs = [now.getUTCFullYear(), now.getUTCFullYear()-1, now.getUTCFullYear()-2, now.getUTCFullYear()-3];
  let year = req.query.year || 'trailing12';
  if (year !== 'trailing12' && !valYrs.includes(parseInt(year, 10))) year = 'trailing12';

  const wantCoverageCurve = req.query.coverage_curve === 'true';
  const force             = req.query.force === 'true';

  const facilities = rawFacilities.map(code => ({ code, mlf: Math.max(0.5, Math.min(1.2, mlfMap[code])), fueltech: fueltechMap[code] || '' }));
  const months     = buildMonthList(year);

  console.log(`[portfolio] facilities=${rawFacilities.join(',')} target=${targetMW}MW gas=${gasMW}MW@$${gasSRMC} region=${deliveryRegion} year=${year} months=${months.length}`);

  // ── Fetch all data in parallel ─────────────────────────────────────────────

  let client;
  try { client = await getClient(); } catch (err) {
    return res.status(500).json({ error: 'OE client init failed', message: err.message });
  }

  // Each month is split into ~5 seven-day chunks internally (see fetchFacilityMonth).
  // Run facility×month tasks in parallel. Price fetches run concurrently alongside.
  const genTasks = facilities.flatMap(f =>
    months.map(({ year: y, month: m }) =>
      fetchFacilityMonth(client, f.code, y, m, force)
        .then(data => ({ code: f.code, year: y, month: m, data }))
        .catch(err => { console.error(`[portfolio] gen fetch ${f.code} ${y}-${m}:`, err.message); return { code: f.code, year: y, month: m, data: {} }; })
    )
  );

  const priceTasks = months.map(({ year: y, month: m }) =>
    fetchPriceMonth(deliveryRegion, y, m, force)
      .then(data => ({ year: y, month: m, data }))
      .catch(err => { console.error(`[portfolio] price fetch ${deliveryRegion} ${y}-${m}:`, err.message); return { year: y, month: m, data: {} }; })
  );

  const [genResults, priceResults] = await Promise.all([
    Promise.all(genTasks),
    Promise.all(priceTasks),
  ]);

  // ── Assemble data maps ─────────────────────────────────────────────────────

  // genData[facilityCode][hourKey] = powerMW
  const genData = {};
  for (const { code, data } of genResults) {
    if (!genData[code]) genData[code] = {};
    Object.assign(genData[code], data);
  }

  // priceData[hourKey] = avgSpotPrice
  const priceData = {};
  for (const { data } of priceResults) {
    Object.assign(priceData, data);
  }

  // ── Build aligned hour key list ────────────────────────────────────────────
  // Union of all hour keys across all generation data sources (and prices),
  // filtered to only hours where at least one data source has data.

  const allHourKeys = new Set();
  for (const hourly of Object.values(genData)) {
    for (const k of Object.keys(hourly)) allHourKeys.add(k);
  }
  for (const k of Object.keys(priceData)) allHourKeys.add(k);

  const sortedHours = [...allHourKeys].sort();

  if (sortedHours.length === 0) {
    return res.status(503).json({
      error: 'No generation or price data found for the selected facilities and period.',
      facilities: rawFacilities, year, deliveryRegion,
    });
  }

  // ── Run dispatch simulation ────────────────────────────────────────────────

  const config = { facilities, targetMW, gasMW, gasSRMC, flatPrice, renewableLCOE };
  const { monthly, annual, worstWeek, hourlyRenewable } = runSimulation(sortedHours, genData, priceData, config);

  // ── Coverage curve (optional, computed from pre-built renewable array) ──────
  const coverageCurve = wantCoverageCurve ? buildCoverageCurve(hourlyRenewable, targetMW) : null;

  // ── Data quality report ────────────────────────────────────────────────────
  const dataQuality = {
    totalHourKeys: sortedHours.length,
    hourKeysWithPrice: Object.keys(priceData).length,
    facilityCoverage: rawFacilities.map(code => {
      const hours = Object.keys(genData[code] || {}).length;
      return { code, hoursFound: hours, pctOfExpected: sortedHours.length > 0 ? +(hours / sortedHours.length * 100).toFixed(1) : 0 };
    }),
  };

  return res.status(200).json({
    success: true,
    facilities: facilities.map(f => ({ ...f })),
    config: { targetMW, gasMW, gasSRMC, flatPrice, renewableLCOE, deliveryRegion, year },
    periodLabel: months.length === 12
      ? `${months[0].year}-${String(months[0].month).padStart(2,'0')} to ${months[11].year}-${String(months[11].month).padStart(2,'0')}`
      : `${months.length} months`,
    monthly,
    annual,
    worstWeek,
    coverageCurve,
    dataQuality,
    fetchedAt: new Date().toISOString(),
  });
};
