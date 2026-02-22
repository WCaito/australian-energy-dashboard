/**
 * bess-nsw.js  —  NSW BESS 5-minute charge, discharge & revenue
 *
 * getFacilities() only accepts: network_id, status_id
 * network_region filter causes 422 — we filter client-side instead.
 */

const BATTERY_FUELTECHS = new Set([
  'battery', 'battery_charging', 'battery_discharging',
  'battery_energy', 'storage',
]);

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

  // IMPORTANT: only network_id and status_id are accepted.
  // Passing network_region causes a 422 Unprocessable Entity error.
  // We filter to NSW1 client-side after receiving all facilities.
  let allRows = [];
  try {
    const result = await client.getFacilities({
      network_id: 'NEM',
      status_id: ['operating'],
    });
    // SDK returns { table } — table has getRecords() or rows
    const tbl = result?.table ?? result;
    allRows = typeof tbl?.getRecords === 'function'
      ? tbl.getRecords()
      : (tbl?.rows ?? []);
  } catch (err) {
    console.error('[bess-nsw] getFacilities failed:', err.message);
    throw new Error('getFacilities API error: ' + err.message);
  }

  console.log('[bess-nsw] Total NEM rows received:', allRows.length);

  // Log field names from first row to debug filter issues
  if (allRows.length > 0) {
    console.log('[bess-nsw] First row keys:', Object.keys(allRows[0]).join(', '));
    console.log('[bess-nsw] First row sample:', JSON.stringify({
      facility_code: allRows[0].facility_code,
      facility_name: allRows[0].facility_name,
      network_region: allRows[0].network_region,
      fueltech_id: allRows[0].fueltech_id,
      status_id: allRows[0].status_id,
    }));
  }

  // Actual API field names (confirmed from live logs):
  //   facility_region  (not network_region / region)
  //   unit_fueltech    (not fueltech_id / fueltech)
  const nswBatteryRows = allRows.filter(r => {
    const region   = (r.facility_region || '').trim().toUpperCase();
    const fueltech = (r.unit_fueltech   || '').trim().toLowerCase();
    return region === 'NSW1' && BATTERY_FUELTECHS.has(fueltech);
  });

  console.log('[bess-nsw] NSW battery rows after filter:', nswBatteryRows.length);

  if (nswBatteryRows.length === 0 && allRows.length > 0) {
    const regions   = [...new Set(allRows.map(r => r.facility_region || '?'))].sort();
    const fueltechs = [...new Set(allRows.map(r => r.unit_fueltech   || '?'))].sort();
    console.log('[bess-nsw] All facility_region values:', regions.join(', '));
    console.log('[bess-nsw] All unit_fueltech values:', fueltechs.join(', '));
  }

  // Group unit rows by facility_code
  const byCode = {};
  for (const row of nswBatteryRows) {
    const code = (row.facility_code || '').trim();
    const name =  row.facility_name || code;
    if (!code) continue;

    if (!byCode[code]) {
      byCode[code] = {
        code,
        name,
        region: 'NSW1',
        capacityMW: 0,
        capacityMWh: null,
        units: [],
      };
    }

    const cap = parseFloat(row.unit_capacity || 0) || 0;
    byCode[code].capacityMW += cap;

    byCode[code].units.push(row.unit_code || code);
  }

  const batteries = Object.values(byCode);
  batteries.sort((a, b) => b.capacityMW - a.capacityMW);
  console.log('[bess-nsw] Distinct NSW battery facilities:', batteries.map(b => `${b.code} (${b.capacityMW}MW)`).join(', ') || 'NONE');
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
      console.warn('[bess-nsw] No data rows for', facilityCode);
      return [];
    }

    const byInterval = {};
    for (const row of datatable.rows) {
      const ts = row.interval || row.date || row.timestamp;
      if (!ts) continue;
      const normTs = normaliseTs(ts);
      const power  = typeof row.power        === 'number' ? row.power        : 0;
      const mv     = typeof row.market_value === 'number' ? row.market_value : 0;

      if (!byInterval[normTs]) byInterval[normTs] = { ts: normTs, power: 0, market_value: 0 };
      byInterval[normTs].power        += power;
      byInterval[normTs].market_value += mv;
    }

    return Object.values(byInterval)
      .map(v => ({
        ts:          v.ts,
        dischargeMW: parseFloat(Math.max(0, v.power).toFixed(2)),
        chargeMW:    parseFloat(Math.abs(Math.min(0, v.power)).toFixed(2)),
        netMW:       parseFloat(v.power.toFixed(2)),
        revenueAUD:  parseFloat(v.market_value.toFixed(2)),
      }))
      .sort((a, b) => new Date(a.ts) - new Date(b.ts));

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

  const H = 5 / 60;
  const totalDischargeGWh = data.reduce((s, r) => s + r.dischargeMW * H, 0) / 1000;
  const totalChargeGWh    = data.reduce((s, r) => s + r.chargeMW    * H, 0) / 1000;
  const netRevenueAUD     = data.reduce((s, r) => s + r.revenueAUD, 0);
  const peakDischargeMW   = data.reduce((m, r) => Math.max(m, r.dischargeMW), 0);
  const peakChargeMW      = data.reduce((m, r) => Math.max(m, r.chargeMW),    0);

  const dch = data.filter(r => r.dischargeMW > 0);
  const chg = data.filter(r => r.chargeMW    > 0);
  const avgDischargeMW = dch.length ? dch.reduce((s, r) => s + r.dischargeMW, 0) / dch.length : 0;
  const avgChargeMW    = chg.length ? chg.reduce((s, r) => s + r.chargeMW,    0) / chg.length : 0;

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

// ─── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const now   = new Date();
  const start = new Date(now.getTime() - 8 * 24 * 3600 * 1000);
  const dateStart = toLocalNaive(start);
  const dateEnd   = toLocalNaive(now);

  try {
    const client    = await getClient();
    const batteries = await discoverNSWBatteries(client);

    if (!batteries.length) {
      return res.status(200).json({
        success: true,
        message: 'No operating NSW battery facilities found after filtering',
        batteries: [],
        dateStart, dateEnd, fetchedAt: now.toISOString(),
      });
    }

    const results = await Promise.allSettled(
      batteries.map(b => fetchBESSData(client, b.code, dateStart, dateEnd))
    );

    const batteryData = batteries.map((b, i) => {
      const data = results[i].status === 'fulfilled' ? results[i].value : [];
      return {
        code:        b.code,
        name:        b.name,
        region:      b.region,
        capacityMW:  +b.capacityMW.toFixed(1),
        capacityMWh: b.capacityMWh ? +b.capacityMWh.toFixed(0) : null,
        stats:       summarise(data, b.capacityMW),
        data,
      };
    });

    return res.status(200).json({
      success: true, dateStart, dateEnd,
      fetchedAt: now.toISOString(),
      region: 'NSW1', count: batteryData.length,
      batteries: batteryData,
    });

  } catch (err) {
    console.error('[bess-nsw] Fatal:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};
