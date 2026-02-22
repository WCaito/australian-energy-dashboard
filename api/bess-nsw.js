/**
 * bess-nsw.js  —  NSW BESS 5-minute charge, discharge & revenue data
 *
 * STRATEGY:
 *   1. getFacilities(NSW1, battery fueltechs) → discover all operating NSW BESS
 *   2. For each facility: getFacilityData(power, market_value) at 5m over 8 days
 *   3. Split bidirectional power into charge (negative MW) and discharge (positive MW)
 *   4. Return per-facility time series + summary stats
 *
 * BATTERY MODEL (OE docs):
 *   power > 0  →  discharging (exporting to grid)
 *   power < 0  →  charging   (importing from grid)
 *   market_value > 0  →  revenue earned (discharging)
 *   market_value < 0  →  cost incurred  (charging)
 *   net market_value  →  net revenue (arbitrage profit)
 */

// Fueltechs that indicate battery storage in OE
const BATTERY_FUELTECHS = new Set([
  'battery', 'battery_charging', 'battery_discharging',
  'battery_energy', 'storage',
]);

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

function normaliseTs(ts) {
  if (!ts) return ts;
  const s = String(ts);
  if (s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s)) return s;
  return s + '+10:00';
}

// ─── Discover NSW BESS from OE ────────────────────────────────────────────────

async function discoverNSWBatteries(client) {
  console.log('[bess-nsw] Fetching NSW facility list');

  let rows = [];
  try {
    const result = await client.getFacilities({
      network_id: 'NEM',
      network_region: 'NSW1',
      status_id: ['operating', 'commissioning'],
    });
    // SDK may return a table or raw data
    rows = result?.table?.getRecords
      ? result.table.getRecords()
      : result?.table?.rows ?? result?.rows ?? [];
  } catch (err) {
    console.error('[bess-nsw] getFacilities error:', err.message);
    throw new Error('Could not retrieve facility list: ' + err.message);
  }

  console.log(`[bess-nsw] Got ${rows.length} NSW facilities`);

  // Group by facility_code — the API often returns one row per unit
  const byCode = {};
  for (const row of rows) {
    const fueltech = (row.fueltech_id || row.fueltech || '').toLowerCase();
    if (!BATTERY_FUELTECHS.has(fueltech)) continue;

    const code = row.facility_code || row.code;
    const name = row.facility_name || row.name || code;
    if (!code) continue;

    if (!byCode[code]) {
      byCode[code] = {
        code,
        name,
        region: 'NSW1',
        units: [],
        capacityMW: 0,
        capacityMWh: null,
        status: row.status_id || row.status || 'operating',
      };
    }

    const unitCapacity = parseFloat(row.unit_capacity || row.capacity_registered || 0);
    byCode[code].capacityMW += unitCapacity;

    // Storage capacity if available
    const storageMWh = parseFloat(row.capacity_storage || row.storage_capacity || 0);
    if (storageMWh > 0) byCode[code].capacityMWh = (byCode[code].capacityMWh || 0) + storageMWh;

    byCode[code].units.push(row.unit_code || row.unit || code);
  }

  const batteries = Object.values(byCode).filter(b => b.capacityMW > 0 || b.units.length > 0);
  console.log(`[bess-nsw] Found ${batteries.length} NSW battery facilities:`, batteries.map(b => b.code));
  return batteries;
}

// ─── Fetch 5-min power + market_value for one facility ───────────────────────

async function fetchBESSData(client, facilityCode, dateStart, dateEnd) {
  try {
    const { datatable } = await client.getFacilityData(
      'NEM',
      facilityCode,
      ['power', 'market_value'],
      { interval: '5m', dateStart, dateEnd }
    );

    if (!datatable?.rows?.length) {
      console.warn(`[bess-nsw] No data for ${facilityCode}`);
      return [];
    }

    // Sum across units per interval
    const byInterval = {};
    for (const row of datatable.rows) {
      const ts = row.interval || row.date || row.timestamp;
      if (!ts) continue;
      const normTs = normaliseTs(ts);
      const power = typeof row.power === 'number' ? row.power : 0;
      const mv    = typeof row.market_value === 'number' ? row.market_value : 0;

      if (!byInterval[normTs]) byInterval[normTs] = { ts: normTs, power: 0, market_value: 0 };
      byInterval[normTs].power        += power;
      byInterval[normTs].market_value += mv;
    }

    return Object.values(byInterval)
      .map(v => ({
        ts:           v.ts,
        // Discharge: positive power (export to grid)
        dischargeMW:  Math.max(0, parseFloat(v.power.toFixed(2))),
        // Charge: absolute value of negative power (import from grid)
        chargeMW:     Math.abs(Math.min(0, parseFloat(v.power.toFixed(2)))),
        // Net power (positive = net export)
        netMW:        parseFloat(v.power.toFixed(2)),
        // Revenue: positive = earned, negative = cost paid for charging
        revenueAUD:   parseFloat(v.market_value.toFixed(2)),
      }))
      .sort((a, b) => new Date(a.ts) - new Date(b.ts));

  } catch (err) {
    console.error(`[bess-nsw] Data error for ${facilityCode}:`, err.message);
    return [];
  }
}

// ─── Summary stats ────────────────────────────────────────────────────────────

function summarise(data, capacityMW, capacityMWh) {
  if (!data.length) {
    return {
      totalDischargeGWh: null, totalChargeGWh: null,
      netRevenueAUD: null, peakDischargeMW: null, peakChargeMW: null,
      avgDischargeMW: null, avgChargeMW: null, capacityFactorPct: null,
      intervalMinutes: 5, intervals: 0,
    };
  }

  const INTERVAL_H = 5 / 60; // 5-min intervals → hours

  const totalDischargeGWh = data.reduce((s, r) => s + r.dischargeMW * INTERVAL_H, 0) / 1000;
  const totalChargeGWh    = data.reduce((s, r) => s + r.chargeMW    * INTERVAL_H, 0) / 1000;
  const netRevenueAUD     = data.reduce((s, r) => s + r.revenueAUD, 0);

  const peakDischargeMW = data.reduce((m, r) => Math.max(m, r.dischargeMW), 0);
  const peakChargeMW    = data.reduce((m, r) => Math.max(m, r.chargeMW),    0);

  const dischargeIntervals = data.filter(r => r.dischargeMW > 0);
  const chargeIntervals    = data.filter(r => r.chargeMW    > 0);

  const avgDischargeMW = dischargeIntervals.length
    ? dischargeIntervals.reduce((s, r) => s + r.dischargeMW, 0) / dischargeIntervals.length
    : 0;
  const avgChargeMW = chargeIntervals.length
    ? chargeIntervals.reduce((s, r) => s + r.chargeMW, 0) / chargeIntervals.length
    : 0;

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

// ─── Main handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const now   = new Date();
  const start = new Date(now.getTime() - 8 * 24 * 3600 * 1000);
  const dateStart = toLocalNaive(start);
  const dateEnd   = toLocalNaive(now);

  try {
    const client = await getClient();

    // 1. Discover all NSW batteries dynamically
    const batteries = await discoverNSWBatteries(client);
    if (!batteries.length) {
      return res.status(200).json({
        success: true,
        message: 'No operating NSW battery facilities found',
        batteries: [],
        dateStart, dateEnd, fetchedAt: now.toISOString(),
      });
    }

    // 2. Fetch power + market_value for each in parallel
    const results = await Promise.allSettled(
      batteries.map(b => fetchBESSData(client, b.code, dateStart, dateEnd))
    );

    // 3. Assemble response
    const batteryData = batteries.map((b, i) => {
      const data = results[i].status === 'fulfilled' ? results[i].value : [];
      if (results[i].status === 'rejected') {
        console.error(`[bess-nsw] ${b.code} failed:`, results[i].reason);
      }
      return {
        code:        b.code,
        name:        b.name,
        region:      b.region,
        status:      b.status,
        capacityMW:  +b.capacityMW.toFixed(1),
        capacityMWh: b.capacityMWh ? +b.capacityMWh.toFixed(0) : null,
        stats:       summarise(data, b.capacityMW, b.capacityMWh),
        data,        // [{ts, dischargeMW, chargeMW, netMW, revenueAUD}]
      };
    });

    // Sort by capacity descending (largest first)
    batteryData.sort((a, b) => b.capacityMW - a.capacityMW);

    return res.status(200).json({
      success:    true,
      dateStart,
      dateEnd,
      fetchedAt:  now.toISOString(),
      region:     'NSW1',
      count:      batteryData.length,
      batteries:  batteryData,
    });

  } catch (err) {
    console.error('[bess-nsw] Fatal:', err);
    return res.status(500).json({
      success: false,
      error:   err.message,
    });
  }
};
