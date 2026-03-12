/**
 * bess-nsw.js — Generalised NEM facility data
 *
 * Replaces the NSW-battery-only endpoint with a dynamic query endpoint.
 *
 * Query params:
 *   fueltech  battery | wind | solar | gas | coal   (default: battery)
 *   region    NSW1 | VIC1 | QLD1 | SA1 | TAS1 | all (default: NSW1)
 *   force     true   (accepted but unused — all fetches are live)
 *
 * Returns top 12 facilities by installed capacity for the selected combination.
 *
 * ══ BATTERY DATA MODEL ════════════════════════════════════════════════════════
 * OpenElectricity represents each battery as TWO units:
 *   battery_discharging  → power POSITIVE = MW exported; market_value = revenue
 *   battery_charging     → power POSITIVE = MW imported; market_value = cost
 * Net energy-market P&L = sum(discharge mv) + sum(charge mv)
 * FCAS revenue is NOT available through OpenElectricity API.
 *
 * ══ OTHER TECH DATA MODEL ═════════════════════════════════════════════════════
 * power = MW generated at each 5-min interval
 * market_value not fetched for non-battery techs (not meaningful without
 * the discharge/charge unit split).
 */

'use strict';

// ─── Fueltech mappings (frontend label → OpenElectricity fueltech codes) ──────

const FUELTECH_MAP = {
  battery: ['battery_discharging', 'battery_charging', 'battery', 'battery_energy', 'storage'],
  wind:    ['wind'],
  solar:   ['solar_utility', 'solar_thermal'],
  gas:     ['gas_ccgt', 'gas_ocgt', 'gas_steam', 'gas_recip', 'gas_wcmg'],
  coal:    ['black_coal', 'brown_coal'],
};

const BATTERY_DISCHARGE_FT = new Set(['battery_discharging', 'battery']);
const BATTERY_CHARGE_FT    = new Set(['battery_charging']);
const ALL_BATTERY_FT       = new Set(FUELTECH_MAP.battery);
const ALL_REGIONS          = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'];
const MAX_FACILITIES       = 12;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getClient() {
  const { OpenElectricityClient } = await import('openelectricity');
  const apiKey = process.env.OPENELECTRICITY_API_KEY;
  if (!apiKey) throw new Error('OPENELECTRICITY_API_KEY not set');
  return new OpenElectricityClient({ apiKey });
}

function toLocalNaive(date) {
  const aest = new Date(date.getTime() + 10 * 3600 * 1000);
  return aest.toISOString().slice(0, 19);
}

function toEpochMs(ts) {
  if (!ts) return NaN;
  const s = String(ts);
  if (s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s)) return new Date(s).getTime();
  return new Date(s + '+10:00').getTime();
}

function bin5minTs(ms) {
  const fiveMin = 5 * 60 * 1000;
  return new Date(Math.floor(ms / fiveMin) * fiveMin).toISOString();
}

function normaliseTs(ts) {
  if (!ts) return ts;
  const s = String(ts);
  if (s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s)) return s;
  return s + '+10:00';
}

// ─── Discover matching facilities ─────────────────────────────────────────────

async function discoverFacilities(client, fueltech, regions) {
  const targetFTs = new Set(FUELTECH_MAP[fueltech] || []);
  const regionSet = new Set(regions.map(r => r.trim().toUpperCase()));
  const isBattery = fueltech === 'battery';

  let allRows = [];
  try {
    const result = await client.getFacilities({ network_id: 'NEM', status_id: ['operating'] });
    const tbl = result?.table ?? result;
    allRows = typeof tbl?.getRecords === 'function' ? tbl.getRecords() : (tbl?.rows ?? []);
  } catch (err) {
    throw new Error('getFacilities failed: ' + err.message);
  }

  console.log(`[facilities] Total NEM rows: ${allRows.length}. Filtering fueltech=${fueltech} regions=${[...regionSet].join(',')}`);

  // Log all unique fueltechs seen (helpful for debugging)
  const seenFTs = [...new Set(allRows.map(r => r.unit_fueltech || '?'))].sort();
  console.log('[facilities] Fueltechs seen:', seenFTs.join(', '));

  const matchingRows = allRows.filter(r => {
    const region   = (r.facility_region || '').trim().toUpperCase();
    const ft       = (r.unit_fueltech   || '').trim().toLowerCase();
    return regionSet.has(region) && targetFTs.has(ft);
  });

  console.log(`[facilities] Matching rows: ${matchingRows.length}`);

  // Group by facility code
  const byCode = {};
  for (const row of matchingRows) {
    const code     = (row.facility_code || '').trim();
    const name     =  row.facility_name || code;
    const region   = (row.facility_region || '').trim().toUpperCase();
    const unitCode = (row.unit_code     || '').trim();
    const ft       = (row.unit_fueltech || '').trim().toLowerCase();
    const cap      = parseFloat(row.unit_capacity || 0) || 0;
    if (!code) continue;

    if (!byCode[code]) byCode[code] = { code, name, region, capacityMW: 0, unitMap: {} };

    if (unitCode) byCode[code].unitMap[unitCode] = ft;

    // For batteries: capacity = sum of discharge units only
    // For others: capacity = sum of all matching units
    if (isBattery) {
      if (BATTERY_DISCHARGE_FT.has(ft) || ft === 'battery_energy') byCode[code].capacityMW += cap;
    } else {
      byCode[code].capacityMW += cap;
    }
  }

  const facilities = Object.values(byCode)
    .sort((a, b) => b.capacityMW - a.capacityMW)
    .slice(0, MAX_FACILITIES);

  console.log(`[facilities] Top ${facilities.length}:`,
    facilities.map(f => `${f.code}(${f.capacityMW.toFixed(0)}MW)`).join(' | '));

  return facilities;
}

// ─── Fetch data for a battery facility ────────────────────────────────────────

async function fetchBatteryData(client, facilityCode, unitMap, dateStart, dateEnd) {
  try {
    const { datatable } = await client.getFacilityData(
      'NEM', facilityCode,
      ['power', 'market_value'],
      { interval: '5m', dateStart, dateEnd }
    );

    if (!datatable?.rows?.length) {
      console.warn(`[facilities] ${facilityCode}: no battery rows`);
      return [];
    }

    const by5min = {};
    for (const row of datatable.rows) {
      const ts = row.interval || row.date || row.timestamp;
      if (!ts) continue;
      const epochMs = toEpochMs(ts);
      if (isNaN(epochMs)) continue;

      const binTs  = bin5minTs(epochMs);
      const power  = typeof row.power        === 'number' ? row.power        : 0;
      const mv     = typeof row.market_value === 'number' ? row.market_value : 0;
      const energy = power * (5 / 60);
      const ft     = (unitMap[(row.unit_code || '').trim()] || '').toLowerCase();

      if (!by5min[binTs]) {
        by5min[binTs] = {
          ts: binTs,
          dischargeMW: 0, chargeMW: 0,
          dischargeEnergy: 0, chargeEnergy: 0,
          dischargeMV: 0, chargeMV: 0,
        };
      }

      const slot = by5min[binTs];
      if (BATTERY_DISCHARGE_FT.has(ft)) {
        slot.dischargeMW     += power;
        slot.dischargeEnergy += energy;
        slot.dischargeMV     += mv;
      } else if (BATTERY_CHARGE_FT.has(ft)) {
        slot.chargeMW     += power;
        slot.chargeEnergy += energy;
        slot.chargeMV     += mv;
      } else {
        // Bidirectional fallback
        if (power >= 0) {
          slot.dischargeMW     += power;
          slot.dischargeEnergy += energy;
          slot.dischargeMV     += mv;
        } else {
          slot.chargeMW     += Math.abs(power);
          slot.chargeEnergy += Math.abs(energy);
          slot.chargeMV     += mv;
        }
      }
    }

    return Object.values(by5min)
      .map(s => ({
        ts:              s.ts,
        dischargeMW:     +s.dischargeMW.toFixed(2),
        chargeMW:        +s.chargeMW.toFixed(2),
        netMW:           +(s.dischargeMW - s.chargeMW).toFixed(2),
        dischargeEnergy: +s.dischargeEnergy.toFixed(4),
        chargeEnergy:    +s.chargeEnergy.toFixed(4),
        netEnergy:       +(s.dischargeEnergy - s.chargeEnergy).toFixed(4),
        dischargeMV:     +s.dischargeMV.toFixed(2),
        chargeMV:        +s.chargeMV.toFixed(2),
        netMV:           +(s.dischargeMV + s.chargeMV).toFixed(2),
      }))
      .sort((a, b) => new Date(a.ts) - new Date(b.ts));

  } catch (err) {
    console.error(`[facilities] Battery ${facilityCode} failed:`, err.message);
    return [];
  }
}

// ─── Fetch data for a non-battery facility ────────────────────────────────────

async function fetchPowerData(client, facilityCode, dateStart, dateEnd) {
  try {
    const { datatable } = await client.getFacilityData(
      'NEM', facilityCode,
      ['power'],
      { interval: '5m', dateStart, dateEnd }
    );

    if (!datatable?.rows?.length) {
      console.warn(`[facilities] ${facilityCode}: no power rows`);
      return [];
    }

    // Aggregate all units per 5-min bin
    const byBin = {};
    for (const row of datatable.rows) {
      const ts = row.interval || row.date || row.timestamp;
      if (!ts) continue;
      const normTs = normaliseTs(String(ts));
      const power  = typeof row.power === 'number' ? row.power : 0;
      if (!byBin[normTs]) byBin[normTs] = { ts: normTs, power: 0 };
      byBin[normTs].power += power;
    }

    return Object.values(byBin)
      .map(v => ({ ts: v.ts, power: +v.power.toFixed(2) }))
      .sort((a, b) => new Date(a.ts) - new Date(b.ts));

  } catch (err) {
    console.error(`[facilities] Power ${facilityCode} failed:`, err.message);
    return [];
  }
}

// ─── Fetch regional spot prices ───────────────────────────────────────────────

async function fetchRegionalPrices(client, regions, dateStart, dateEnd) {
  try {
    const { datatable } = await client.getMarket(
      'NEM', ['price'],
      { interval: '5m', dateStart, dateEnd, primaryGrouping: 'network_region' }
    );

    if (!datatable?.rows?.length) return {};

    const out = {};
    for (const row of datatable.rows) {
      const region = (row.network_region || row.region || '').trim().toUpperCase();
      if (!regions.includes(region)) continue;
      const ts    = row.interval || row.date || row.timestamp;
      const price = typeof row.price === 'number' ? row.price : null;
      if (!ts || price === null) continue;
      const normTs = normaliseTs(String(ts));
      if (!out[region]) out[region] = {};
      out[region][normTs] = +price.toFixed(2);
    }
    return out;

  } catch (err) {
    console.warn('[facilities] Price fetch failed (non-fatal):', err.message);
    return {};
  }
}

// ─── Summary stats — battery ──────────────────────────────────────────────────

function summariseBattery(data, capacityMW) {
  if (!data.length) return {
    totalDischargeGWh: null, totalChargeGWh: null, netEnergyGWh: null,
    totalDischargeMV: null, totalChargeMV: null, netEnergyMarketMV: null,
    peakDischargeMW: null, peakChargeMW: null,
    avgActiveDischargeMW: null, capacityFactorPct: null,
    intervals: 0, dispatchedIntervals: 0, chargedIntervals: 0,
  };

  const THRESH = 0.5;
  const dchActive = data.filter(r => r.dischargeMW > THRESH);
  const chgActive = data.filter(r => r.chargeMW    > THRESH);

  const totalDischargeGWh = data.reduce((s, r) => s + r.dischargeEnergy, 0) / 1000;
  const totalChargeGWh    = data.reduce((s, r) => s + r.chargeEnergy,    0) / 1000;
  const totalDischargeMV  = data.reduce((s, r) => s + r.dischargeMV, 0);
  const totalChargeMV     = data.reduce((s, r) => s + r.chargeMV,    0);
  const peakDischargeMW   = data.reduce((m, r) => Math.max(m, r.dischargeMW), 0);
  const peakChargeMW      = data.reduce((m, r) => Math.max(m, r.chargeMW),    0);
  const netEnergyMarketMV = totalDischargeMV + totalChargeMV;

  const avgActiveDischargeMW = dchActive.length
    ? +(dchActive.reduce((s, r) => s + r.dischargeMW, 0) / dchActive.length).toFixed(1) : 0;

  const hoursInPeriod    = data.length * (5 / 60);
  const capacityFactorPct = capacityMW > 0
    ? +((totalDischargeGWh * 1000) / (capacityMW * hoursInPeriod) * 100).toFixed(1) : null;

  return {
    totalDischargeGWh:   +totalDischargeGWh.toFixed(3),
    totalChargeGWh:      +totalChargeGWh.toFixed(3),
    netEnergyGWh:        +(totalDischargeGWh - totalChargeGWh).toFixed(3),
    totalDischargeMV:    +totalDischargeMV.toFixed(0),
    totalChargeMV:       +totalChargeMV.toFixed(0),
    netEnergyMarketMV:   +netEnergyMarketMV.toFixed(0),
    peakDischargeMW:     +peakDischargeMW.toFixed(1),
    peakChargeMW:        +peakChargeMW.toFixed(1),
    avgActiveDischargeMW,
    capacityFactorPct,
    intervals:           data.length,
    dispatchedIntervals: dchActive.length,
    chargedIntervals:    chgActive.length,
  };
}

// ─── Summary stats — power (non-battery) ─────────────────────────────────────

function summarisePower(data, capacityMW, regionPrices) {
  if (!data.length) return {
    avgPowerMW: null, maxPowerMW: null, capacityFactorPct: null,
    gwap: null, totalGenerationGWh: null, intervals: 0,
  };

  const powers  = data.map(r => r.power).filter(p => p !== null && !isNaN(p));
  const avgPower = powers.length ? powers.reduce((a, b) => a + b, 0) / powers.length : null;
  const maxPower = powers.length ? Math.max(...powers) : null;

  const totalGenerationGWh = powers.reduce((s, p) => s + p * (5 / 60), 0) / 1000;

  const hoursInPeriod    = data.length * (5 / 60);
  const capacityFactorPct = capacityMW > 0 && avgPower !== null
    ? +((avgPower / capacityMW) * 100).toFixed(1) : null;

  // Generation-weighted average price
  const priceMap = regionPrices || {};
  const validPairs = data.filter(r => r.power > 0 && priceMap[r.ts] !== undefined);
  const totalWeighted = validPairs.reduce((s, r) => s + r.power * priceMap[r.ts], 0);
  const totalWeight   = validPairs.reduce((s, r) => s + r.power, 0);
  const gwap          = totalWeight > 0 ? +(totalWeighted / totalWeight).toFixed(2) : null;

  return {
    avgPowerMW:          avgPower !== null ? +avgPower.toFixed(2) : null,
    maxPowerMW:          maxPower !== null ? +maxPower.toFixed(2) : null,
    capacityFactorPct,
    gwap,
    totalGenerationGWh:  +totalGenerationGWh.toFixed(3),
    intervals:           data.length,
  };
}

// ─── Main handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-refresh');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Parse & validate params ───────────────────────────────────────────────
  const fueltech = (req.query?.fueltech || 'battery').toLowerCase();
  const regionParam = (req.query?.region || 'NSW1').toUpperCase();

  if (!FUELTECH_MAP[fueltech]) {
    return res.status(400).json({ error: `Unknown fueltech: ${fueltech}. Valid: ${Object.keys(FUELTECH_MAP).join(', ')}` });
  }

  const regions = regionParam === 'ALL' ? ALL_REGIONS : [regionParam];
  if (!regionParam === 'ALL' && !ALL_REGIONS.includes(regionParam)) {
    return res.status(400).json({ error: `Unknown region: ${regionParam}. Valid: ${ALL_REGIONS.join(', ')} or ALL` });
  }

  const isBattery = fueltech === 'battery';

  // ── Date window ───────────────────────────────────────────────────────────
  const now       = new Date();
  const start     = new Date(now.getTime() - 8 * 24 * 3600 * 1000);
  const dateStart = toLocalNaive(start);
  const dateEnd   = toLocalNaive(now);

  console.log(`[facilities] fueltech=${fueltech} regions=${regions.join(',')} window=${dateStart}→${dateEnd}`);

  try {
    const client = await getClient();

    // ── Discover top-N facilities ────────────────────────────────────────────
    const facilities = await discoverFacilities(client, fueltech, regions);

    if (!facilities.length) {
      return res.status(200).json({
        success: true, fueltech, regions, isBattery,
        message: `No operating ${fueltech} facilities found in ${regions.join(', ')}`,
        facilities: [], regionPrices: {}, dateStart, dateEnd, fetchedAt: now.toISOString(),
      });
    }

    // ── Fetch facility data + prices in parallel ──────────────────────────────
    const [priceResult, ...dataResults] = await Promise.allSettled([
      fetchRegionalPrices(client, regions, dateStart, dateEnd),
      ...facilities.map(f =>
        isBattery
          ? fetchBatteryData(client, f.code, f.unitMap, dateStart, dateEnd)
          : fetchPowerData(client, f.code, dateStart, dateEnd)
      ),
    ]);

    const regionPrices = priceResult.status === 'fulfilled' ? priceResult.value : {};

    const facilityData = facilities.map((f, i) => {
      const data = dataResults[i].status === 'fulfilled' ? dataResults[i].value : [];
      if (dataResults[i].status === 'rejected') {
        console.error(`[facilities] ${f.code} rejected:`, dataResults[i].reason?.message);
      }

      const facilityPrices = regionPrices[f.region] || {};
      const stats = isBattery
        ? summariseBattery(data, f.capacityMW)
        : summarisePower(data, f.capacityMW, facilityPrices);

      return {
        code:       f.code,
        name:       f.name,
        region:     f.region,
        fueltech,
        capacityMW: +f.capacityMW.toFixed(1),
        stats,
        data,
      };
    });

    return res.status(200).json({
      success:     true,
      fueltech,
      regions,
      isBattery,
      dateStart, dateEnd,
      fetchedAt:   now.toISOString(),
      binInterval: '5min',
      regionPrices,
      facilities:  facilityData,
    });

  } catch (err) {
    console.error('[facilities] Handler error:', err.message, err.stack);
    return res.status(502).json({
      success: false,
      error:   err.message || 'Internal server error',
    });
  }
};
