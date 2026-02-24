/**
 * bess-nsw.js  —  NSW BESS 5-minute charge, discharge & revenue
 *
 * KEY DATA MODEL (from OE docs):
 *   OE splits each battery facility into two separate units:
 *     • battery_discharging unit  → power is ALWAYS POSITIVE = MW exported to grid
 *     • battery_charging unit     → power is ALWAYS POSITIVE = MW imported from grid
 *
 *   Both units report positive-only values. You CANNOT split by sign after summing.
 *   You must route each unit's power to the correct bucket using unit_fueltech.
 *
 *   market_value for discharging units = revenue earned (positive)
 *   market_value for charging units    = cost incurred (negative)
 *   Sum of both = net arbitrage P&L
 *
 * CAPACITY:
 *   Only count battery_discharging unit capacity — the charging unit repeats
 *   the same figure, so summing both doubles the real installed capacity.
 */

// ─── Client ───────────────────────────────────────────────────────────────────

async function getClient() {
  const { OpenElectricityClient } = await import('openelectricity');
  const apiKey = process.env.OPENELECTRICITY_API_KEY;
  if (!apiKey) throw new Error('OPENELECTRICITY_API_KEY not set');
  return new OpenElectricityClient({ apiKey });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toLocalNaive(date) {
  const aest = new Date(date.getTime() + 10 * 3600 * 1000);
  return aest.toISOString().slice(0, 19);
}

function normaliseTs(ts) {
  if (!ts) return ts;
  const s = String(ts);
  if (s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s)) return s;
  return s + '+10:00';
}

// ─── Discover NSW batteries ───────────────────────────────────────────────────

async function discoverNSWBatteries(client) {
  console.log('[bess-nsw] Calling getFacilities (network_id=NEM, status_id=operating)');

  let allRows = [];
  try {
    const result = await client.getFacilities({
      network_id: 'NEM',
      status_id: ['operating'],
    });
    const tbl = result?.table ?? result;
    allRows = typeof tbl?.getRecords === 'function'
      ? tbl.getRecords()
      : (tbl?.rows ?? []);
  } catch (err) {
    console.error('[bess-nsw] getFacilities failed:', err.message);
    throw new Error('getFacilities API error: ' + err.message);
  }

  console.log('[bess-nsw] Total NEM rows received:', allRows.length);

  // Log first row keys so we can catch future field-name changes
  if (allRows.length > 0) {
    console.log('[bess-nsw] Row field names:', Object.keys(allRows[0]).join(', '));
  }

  // Filter: confirmed field names from 2026-02-22 logs:
  //   facility_region  (not network_region)
  //   unit_fueltech    (not fueltech_id)
  const nswBatteryRows = allRows.filter(r => {
    const region   = (r.facility_region || '').trim().toUpperCase();
    const fueltech = (r.unit_fueltech   || '').trim().toLowerCase();
    const isBattery = fueltech === 'battery_discharging'
                   || fueltech === 'battery_charging'
                   || fueltech === 'battery'
                   || fueltech === 'battery_energy'
                   || fueltech === 'storage';
    return region === 'NSW1' && isBattery;
  });

  console.log('[bess-nsw] NSW battery unit rows after filter:', nswBatteryRows.length);

  if (nswBatteryRows.length === 0 && allRows.length > 0) {
    // Log all distinct values so we can diagnose mismatches
    const regions   = [...new Set(allRows.map(r => r.facility_region || '?'))].sort();
    const fueltechs = [...new Set(allRows.map(r => r.unit_fueltech   || '?'))].sort();
    console.log('[bess-nsw] All facility_region values seen:', regions.join(', '));
    console.log('[bess-nsw] All unit_fueltech values seen:',   fueltechs.join(', '));
    return [];
  }

  // Group by facility_code, building a unit→fueltech map per facility.
  // IMPORTANT: only add capacity from battery_DISCHARGING units —
  // the charging unit repeats the same MW figure, so summing both doubles it.
  const byCode = {};
  for (const row of nswBatteryRows) {
    const code     = (row.facility_code || '').trim();
    const name     =  row.facility_name || code;
    const unitCode = (row.unit_code     || '').trim();
    const fueltech = (row.unit_fueltech || '').trim().toLowerCase();
    if (!code) continue;

    if (!byCode[code]) {
      byCode[code] = {
        code,
        name,
        region: 'NSW1',
        capacityMW: 0,
        unitMap: {},   // unitCode → fueltech, used during data fetch
      };
    }

    // Record this unit's fueltech so fetchBESSData can route power correctly
    if (unitCode) byCode[code].unitMap[unitCode] = fueltech;

    // Only accumulate capacity from discharging units (or generic 'battery' units)
    const cap = parseFloat(row.unit_capacity || 0) || 0;
    if (fueltech === 'battery_discharging' || fueltech === 'battery' || fueltech === 'battery_energy') {
      byCode[code].capacityMW += cap;
    }
  }

  const batteries = Object.values(byCode);
  batteries.sort((a, b) => b.capacityMW - a.capacityMW);

  console.log('[bess-nsw] Facilities found:',
    batteries.map(b => `${b.code}(${b.capacityMW}MW, units:[${Object.entries(b.unitMap).map(([u,f])=>`${u}=${f}`).join(',')}])`).join(' | ')
  );

  return batteries;
}

// ─── Fetch 5-min power + market_value for one facility ───────────────────────

async function fetchBESSData(client, facilityCode, unitMap, dateStart, dateEnd) {
  try {
    const { datatable } = await client.getFacilityData(
      'NEM',
      facilityCode,
      ['power', 'market_value'],
      { interval: '5m', dateStart, dateEnd }
    );

    if (!datatable?.rows?.length) {
      console.warn('[bess-nsw] No data rows for', facilityCode);
      return [];
    }

    // Log what unit_code field looks like in datatable rows (first call only)
    const sampleRow = datatable.rows[0];
    console.log(`[bess-nsw] ${facilityCode} datatable sample keys:`, Object.keys(sampleRow).join(', '));
    console.log(`[bess-nsw] ${facilityCode} sample row:`, JSON.stringify({
      unit_code: sampleRow.unit_code,
      interval:  sampleRow.interval,
      power:     sampleRow.power,
      market_value: sampleRow.market_value,
    }));

    // Accumulate discharge and charge SEPARATELY per interval.
    // OE already splits units: discharging units always positive, charging units always positive.
    // We use unitMap (unit_code → fueltech) to route each row to the right bucket.
    const byInterval = {};

    for (const row of datatable.rows) {
      const ts = row.interval || row.date || row.timestamp;
      if (!ts) continue;
      const normTs = normaliseTs(ts);

      const power = typeof row.power        === 'number' ? row.power        : 0;
      const mv    = typeof row.market_value === 'number' ? row.market_value : 0;

      // Identify this unit's role
      const unitCode = row.unit_code || '';
      const fueltech = (unitMap[unitCode] || '').toLowerCase();

      if (!byInterval[normTs]) {
        byInterval[normTs] = { ts: normTs, dischargeMW: 0, chargeMW: 0, market_value: 0 };
      }

      if (fueltech === 'battery_discharging') {
        // Discharging unit — power is already positive = MW sent to grid
        byInterval[normTs].dischargeMW += power;
      } else if (fueltech === 'battery_charging') {
        // Charging unit — power is already positive = MW taken from grid
        byInterval[normTs].chargeMW += power;
      } else {
        // Fallback: bidirectional or unlabelled unit — split by sign
        // (positive = discharge, negative = charge)
        if (power >= 0) {
          byInterval[normTs].dischargeMW += power;
        } else {
          byInterval[normTs].chargeMW += Math.abs(power);
        }
      }

      // Revenue: discharging earns (positive mv), charging costs (negative mv)
      // Sum for net P&L
      byInterval[normTs].market_value += mv;
    }

    const result = Object.values(byInterval)
      .map(v => ({
        ts:          v.ts,
        dischargeMW: parseFloat(v.dischargeMW.toFixed(2)),
        chargeMW:    parseFloat(v.chargeMW.toFixed(2)),
        netMW:       parseFloat((v.dischargeMW - v.chargeMW).toFixed(2)),
        revenueAUD:  parseFloat(v.market_value.toFixed(2)),
      }))
      .sort((a, b) => new Date(a.ts) - new Date(b.ts));

    console.log(`[bess-nsw] ${facilityCode}: ${result.length} intervals, ` +
      `peak discharge ${Math.max(...result.map(r=>r.dischargeMW)).toFixed(1)}MW, ` +
      `peak charge ${Math.max(...result.map(r=>r.chargeMW)).toFixed(1)}MW`);

    return result;

  } catch (err) {
    console.error('[bess-nsw] Data fetch error for', facilityCode + ':', err.message);
    return [];
  }
}

// ─── Summary stats ────────────────────────────────────────────────────────────

function summarise(data, capacityMW) {
  if (!data.length) return {
    totalDischargeGWh: null, totalChargeGWh: null, netRevenueAUD: null,
    peakDischargeMW: null, peakChargeMW: null, avgDischargeMW: null,
    avgChargeMW: null, capacityFactorPct: null, intervals: 0,
  };

  const H = 5 / 60; // 5-min → hours
  const totalDischargeGWh = data.reduce((s, r) => s + r.dischargeMW * H, 0) / 1000;
  const totalChargeGWh    = data.reduce((s, r) => s + r.chargeMW    * H, 0) / 1000;
  const netRevenueAUD     = data.reduce((s, r) => s + r.revenueAUD, 0);
  const peakDischargeMW   = data.reduce((m, r) => Math.max(m, r.dischargeMW), 0);
  const peakChargeMW      = data.reduce((m, r) => Math.max(m, r.chargeMW),    0);

  const dchIntervals = data.filter(r => r.dischargeMW > 0.1);
  const chgIntervals = data.filter(r => r.chargeMW    > 0.1);
  const avgDischargeMW = dchIntervals.length
    ? dchIntervals.reduce((s, r) => s + r.dischargeMW, 0) / dchIntervals.length : 0;
  const avgChargeMW = chgIntervals.length
    ? chgIntervals.reduce((s, r) => s + r.chargeMW,    0) / chgIntervals.length : 0;

  const capacityFactorPct = capacityMW > 0
    ? (totalDischargeGWh * 1000) / (capacityMW * 8 * 24) * 100
    : null;

  return {
    totalDischargeGWh:   +totalDischargeGWh.toFixed(3),
    totalChargeGWh:      +totalChargeGWh.toFixed(3),
    netRevenueAUD:       +netRevenueAUD.toFixed(0),
    peakDischargeMW:     +peakDischargeMW.toFixed(1),
    peakChargeMW:        +peakChargeMW.toFixed(1),
    avgDischargeMW:      +avgDischargeMW.toFixed(1),
    avgChargeMW:         +avgChargeMW.toFixed(1),
    capacityFactorPct:   capacityFactorPct !== null ? +capacityFactorPct.toFixed(1) : null,
    intervals:           data.length,
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
      success: true,
      message: 'No operating NSW battery facilities found',
      batteries: [], dateStart, dateEnd, fetchedAt: now.toISOString(),
    };
  }

  const results = await Promise.allSettled(
    batteries.map(b => fetchBESSData(client, b.code, b.unitMap, dateStart, dateEnd))
  );

  const batteryData = batteries.map((b, i) => {
    const data = results[i].status === 'fulfilled' ? results[i].value : [];
    if (results[i].status === 'rejected') {
      console.error(`[bess-nsw] ${b.code} fetch rejected:`, results[i].reason?.message);
    }
    return {
      code:        b.code,
      name:        b.name,
      region:      b.region,
      capacityMW:  +b.capacityMW.toFixed(1),
      unitMap:     b.unitMap,
      stats:       summarise(data, b.capacityMW),
      data,
    };
  });

  return {
    success: true, dateStart, dateEnd,
    fetchedAt: now.toISOString(),
    region: 'NSW1', count: batteryData.length,
    batteries: batteryData,
  };
}

module.exports = withCache(CACHE_KEYS.BESS_NSW, fetchBESSNSW);
