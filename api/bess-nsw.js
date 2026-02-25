/**
 * bess-nsw.js — NSW BESS charge, discharge & energy-market revenue
 *
 * ══ DATA MODEL ════════════════════════════════════════════════════════════════
 *
 * OpenElectricity represents each battery as TWO units in its API:
 *
 *   battery_discharging  → power ALWAYS POSITIVE = MW exported to grid
 *                           market_value POSITIVE  = revenue earned ($/interval)
 *
 *   battery_charging     → power ALWAYS POSITIVE = MW imported from grid
 *                           market_value expected NEGATIVE (cost of buying at spot)
 *
 * Net energy-market P&L = sum(discharge mv) + sum(charge mv)
 *
 * ══ WHAT market_value DOES AND DOES NOT INCLUDE ═══════════════════════════════
 *
 *   INCLUDED:  energy × regional spot price (five-minute settlement)
 *
 *   NOT INCLUDED: FCAS (Frequency Control Ancillary Services) revenue.
 *     FCAS is a CAPACITY MARKET — batteries are paid $/MW/h just for being
 *     available to respond to frequency deviations, without physical dispatch.
 *     The OpenElectricity API does not expose FCAS clearing prices or enablement.
 *     FCAS can represent 40–60%+ of total battery revenue in some periods.
 *
 * ══ WHY WE USE 5-MINUTE RESOLUTION ══════════════════════════════════════════
 *
 *   Previous versions used 30-min bins which caused visual problems:
 *
 *   1. "Revenue with no visible dispatch": A battery dispatching 100 MW for one
 *      5-min interval at $15,000/MWh earns ~$125k but appears as only ~17 MW
 *      on a 30-min average. At 5-min resolution, power and revenue are aligned.
 *
 *   2. "Charging without discharge": Brief discharges were averaged away by the
 *      surrounding idle/charge intervals in the 30-min bin.
 *
 *   At 5-min resolution: dischargeMW × (5/60) × spotPrice ≈ dischargeMV
 *   so power and revenue are visually coherent.
 */

'use strict';

// ─── Client ───────────────────────────────────────────────────────────────────

async function getClient() {
  const { OpenElectricityClient } = await import('openelectricity');
  const apiKey = process.env.OPENELECTRICITY_API_KEY;
  if (!apiKey) throw new Error('OPENELECTRICITY_API_KEY not set');
  return new OpenElectricityClient({ apiKey });
}

// ─── Timestamp helpers ────────────────────────────────────────────────────────

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

// ─── Discover NSW batteries ───────────────────────────────────────────────────

async function discoverNSWBatteries(client) {
  console.log('[bess-nsw] getFacilities: NEM, operating');
  let allRows = [];
  try {
    const result = await client.getFacilities({ network_id: 'NEM', status_id: ['operating'] });
    const tbl = result?.table ?? result;
    allRows = typeof tbl?.getRecords === 'function' ? tbl.getRecords() : (tbl?.rows ?? []);
  } catch (err) {
    throw new Error('getFacilities failed: ' + err.message);
  }

  console.log('[bess-nsw] Total NEM facility rows:', allRows.length);

  const BATTERY_FUELTECHS = new Set([
    'battery_discharging', 'battery_charging', 'battery', 'battery_energy', 'storage',
  ]);

  const nswBatteryRows = allRows.filter(r => {
    const region   = (r.facility_region || '').trim().toUpperCase();
    const fueltech = (r.unit_fueltech   || '').trim().toLowerCase();
    return region === 'NSW1' && BATTERY_FUELTECHS.has(fueltech);
  });

  console.log('[bess-nsw] NSW battery unit rows:', nswBatteryRows.length);

  if (nswBatteryRows.length === 0 && allRows.length > 0) {
    const regions   = [...new Set(allRows.map(r => r.facility_region || '?'))].sort();
    const fueltechs = [...new Set(allRows.map(r => r.unit_fueltech   || '?'))].sort();
    console.log('[bess-nsw] Regions seen:', regions.join(', '));
    console.log('[bess-nsw] Fueltechs seen:', fueltechs.join(', '));
    return [];
  }

  const byCode = {};
  for (const row of nswBatteryRows) {
    const code     = (row.facility_code || '').trim();
    const name     =  row.facility_name || code;
    const unitCode = (row.unit_code     || '').trim();
    const fueltech = (row.unit_fueltech || '').trim().toLowerCase();
    if (!code) continue;

    if (!byCode[code]) byCode[code] = { code, name, region: 'NSW1', capacityMW: 0, unitMap: {} };
    if (unitCode) byCode[code].unitMap[unitCode] = fueltech;

    const cap = parseFloat(row.unit_capacity || 0) || 0;
    if (fueltech === 'battery_discharging' || fueltech === 'battery' || fueltech === 'battery_energy') {
      byCode[code].capacityMW += cap;
    }
  }

  const batteries = Object.values(byCode).sort((a, b) => b.capacityMW - a.capacityMW);
  console.log('[bess-nsw] Discovered:',
    batteries.map(b => `${b.code}(${b.capacityMW}MW)`).join(' | ')
  );
  return batteries;
}

// ─── Fetch 5-minute data for one facility ─────────────────────────────────────

async function fetchBESSData(client, facilityCode, unitMap, dateStart, dateEnd) {
  try {
    const { datatable } = await client.getFacilityData(
      'NEM', facilityCode,
      ['power', 'market_value'],
      { interval: '5m', dateStart, dateEnd }
    );

    if (!datatable?.rows?.length) {
      console.warn(`[bess-nsw] ${facilityCode}: no rows`);
      return [];
    }

    const s0 = datatable.rows[0];
    console.log(`[bess-nsw] ${facilityCode} sample:`, JSON.stringify({
      unit_code: s0.unit_code, power: s0.power, market_value: s0.market_value,
    }));

    // Accumulate discharge + charge per 5-min slot
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

      const fueltech = (unitMap[(row.unit_code || '').trim()] || '').toLowerCase();

      if (!by5min[binTs]) {
        by5min[binTs] = {
          ts: binTs,
          dischargeMW: 0, chargeMW: 0,
          dischargeEnergy: 0, chargeEnergy: 0,
          dischargeMV: 0, chargeMV: 0,
        };
      }

      const slot = by5min[binTs];

      if (fueltech === 'battery_discharging') {
        slot.dischargeMW     += power;
        slot.dischargeEnergy += energy;
        slot.dischargeMV     += mv;
      } else if (fueltech === 'battery_charging') {
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

    // Diagnostics
    const slots = Object.values(by5min);
    const dchMVPos = slots.filter(s => s.dischargeMV > 0).length;
    const dchMVNeg = slots.filter(s => s.dischargeMV < 0).length;
    const chgMVPos = slots.filter(s => s.chargeMV > 0).length;
    const chgMVNeg = slots.filter(s => s.chargeMV < 0).length;
    console.log(`[bess-nsw] ${facilityCode} mv signs: dch +${dchMVPos}/-${dchMVNeg} chg +${chgMVPos}/-${chgMVNeg}`);

    const result = slots
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

    const peakD = result.reduce((m, r) => Math.max(m, r.dischargeMW), 0);
    const peakC = result.reduce((m, r) => Math.max(m, r.chargeMW), 0);
    const dchMV = result.reduce((s, r) => s + r.dischargeMV, 0);
    const chgMV = result.reduce((s, r) => s + r.chargeMV, 0);
    console.log(`[bess-nsw] ${facilityCode}: ${result.length} 5-min pts peak-D ${peakD.toFixed(1)}MW peak-C ${peakC.toFixed(1)}MW net-MV $${(dchMV+chgMV).toFixed(0)}`);

    return result;

  } catch (err) {
    console.error(`[bess-nsw] ${facilityCode} fetch failed:`, err.message);
    return [];
  }
}

// ─── NSW1 spot price (kept at 5-min) ─────────────────────────────────────────

async function fetchNSW1Price(client, dateStart, dateEnd) {
  try {
    const { datatable } = await client.getMarket(
      'NEM', ['price'],
      { interval: '5m', dateStart, dateEnd, primaryGrouping: 'network_region' }
    );

    if (!datatable?.rows?.length) return [];

    const by5min = {};
    for (const row of datatable.rows) {
      const region = (row.network_region || row.region || '').trim().toUpperCase();
      if (region !== 'NSW1') continue;
      const ts    = row.interval || row.date || row.timestamp;
      const ms    = toEpochMs(ts);
      if (isNaN(ms)) continue;
      const price = typeof row.price === 'number' ? row.price : null;
      if (price === null) continue;
      const binTs = bin5minTs(ms);
      if (!by5min[binTs]) by5min[binTs] = { ts: binTs, price, hasSpike: false };
      if (price > 300 || price < 0) by5min[binTs].hasSpike = true;
    }

    const result = Object.values(by5min)
      .map(b => ({ ts: b.ts, price: +b.price.toFixed(2), hasSpike: b.hasSpike }))
      .sort((a, b) => new Date(a.ts) - new Date(b.ts));

    const spikes = result.filter(r => r.hasSpike).length;
    console.log(`[bess-nsw] NSW1 price: ${result.length} 5-min pts, ${spikes} spikes`);
    return result;

  } catch (err) {
    console.warn('[bess-nsw] NSW1 price fetch failed (non-fatal):', err.message);
    return [];
  }
}

// ─── Summary stats ────────────────────────────────────────────────────────────

function summarise(data, capacityMW) {
  if (!data.length) return {
    totalDischargeGWh: null, totalChargeGWh: null, netEnergyGWh: null,
    totalDischargeMV: null, totalChargeMV: null, netEnergyMarketMV: null,
    peakDischargeMW: null, peakChargeMW: null,
    avgActiveDischargeMW: null, avgActiveChargeMW: null,
    capacityFactorPct: null, intervals: 0,
    dispatchedIntervals: 0, chargedIntervals: 0,
  };

  const totalDischargeGWh = data.reduce((s, r) => s + r.dischargeEnergy, 0) / 1000;
  const totalChargeGWh    = data.reduce((s, r) => s + r.chargeEnergy,    0) / 1000;
  const netEnergyGWh      = totalDischargeGWh - totalChargeGWh;
  const totalDischargeMV  = data.reduce((s, r) => s + r.dischargeMV, 0);
  const totalChargeMV     = data.reduce((s, r) => s + r.chargeMV,    0);
  const netEnergyMarketMV = totalDischargeMV + totalChargeMV;
  const peakDischargeMW   = data.reduce((m, r) => Math.max(m, r.dischargeMW), 0);
  const peakChargeMW      = data.reduce((m, r) => Math.max(m, r.chargeMW),    0);

  const THRESHOLD = 0.5;
  const dchActive = data.filter(r => r.dischargeMW > THRESHOLD);
  const chgActive = data.filter(r => r.chargeMW    > THRESHOLD);
  const avgActiveDischargeMW = dchActive.length
    ? +(dchActive.reduce((s, r) => s + r.dischargeMW, 0) / dchActive.length).toFixed(1) : 0;
  const avgActiveChargeMW = chgActive.length
    ? +(chgActive.reduce((s, r) => s + r.chargeMW,    0) / chgActive.length).toFixed(1) : 0;

  const hoursInPeriod = data.length * (5 / 60);
  const capacityFactorPct = capacityMW > 0
    ? +((totalDischargeGWh * 1000) / (capacityMW * hoursInPeriod) * 100).toFixed(1)
    : null;

  return {
    totalDischargeGWh:    +totalDischargeGWh.toFixed(3),
    totalChargeGWh:       +totalChargeGWh.toFixed(3),
    netEnergyGWh:         +netEnergyGWh.toFixed(3),
    totalDischargeMV:     +totalDischargeMV.toFixed(0),
    totalChargeMV:        +totalChargeMV.toFixed(0),
    netEnergyMarketMV:    +netEnergyMarketMV.toFixed(0),
    peakDischargeMW,
    peakChargeMW,
    avgActiveDischargeMW,
    avgActiveChargeMW,
    capacityFactorPct,
    intervals:            data.length,
    dispatchedIntervals:  dchActive.length,
    chargedIntervals:     chgActive.length,
  };
}

// ─── Caching wrapper ──────────────────────────────────────────────────────────

const { withCache, CACHE_KEYS } = require('./_cache');

async function fetchBESSNSW() {
  const now   = new Date();
  const start = new Date(now.getTime() - 8 * 24 * 3600 * 1000);
  const dateStart = toLocalNaive(start);
  const dateEnd   = toLocalNaive(now);

  const client    = await getClient();
  const batteries = await discoverNSWBatteries(client);

  if (!batteries.length) {
    return {
      success: true, message: 'No operating NSW battery facilities found',
      batteries: [], nsw1Price: [], dateStart, dateEnd, fetchedAt: now.toISOString(),
    };
  }

  const [priceResult, ...batteryResults] = await Promise.allSettled([
    fetchNSW1Price(client, dateStart, dateEnd),
    ...batteries.map(b => fetchBESSData(client, b.code, b.unitMap, dateStart, dateEnd)),
  ]);

  const nsw1Price = priceResult.status === 'fulfilled' ? priceResult.value : [];

  const batteryData = batteries.map((b, i) => {
    const data = batteryResults[i].status === 'fulfilled' ? batteryResults[i].value : [];
    if (batteryResults[i].status === 'rejected') {
      console.error(`[bess-nsw] ${b.code} rejected:`, batteryResults[i].reason?.message);
    }
    return {
      code:       b.code,
      name:       b.name,
      region:     b.region,
      capacityMW: +b.capacityMW.toFixed(1),
      stats:      summarise(data, b.capacityMW),
      data,
    };
  });

  return {
    success:     true,
    dateStart, dateEnd,
    fetchedAt:   now.toISOString(),
    region:      'NSW1',
    count:       batteryData.length,
    binInterval: '5min',
    nsw1Price,
    batteries:   batteryData,
  };
}

module.exports = withCache(CACHE_KEYS.BESS_NSW, fetchBESSNSW);
