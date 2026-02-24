/**
 * facility-data.js  —  Per-facility 5-minute power + price data
 *
 * Facility codes are HARDCODED — no name-matching guesswork.
 * Confirmed codes from live API logs and OpenElectricity explorer:
 *
 *   YABULU    Townsville Power Station     QLD1  gas
 *   COLWF01   Collector Wind Farm          NSW1  wind
 *   MEWF      Mount Emerald Wind Farm      QLD1  wind  (MEWF1 is the unit DUID, MEWF is the facility code)
 *   CSPVPS    Collinsville Solar Farm      QLD1  solar
 *   STARFHILL Starfish Hill Wind Farm      SA1   wind
 *   WINDHILL  Windy Hill Wind Farm         QLD1  wind
 *   LGAPWF1   Lincoln Gap Wind Farm        SA1   wind
 *
 * The API is called with each code directly. The actual facility name
 * is fetched from getFacilities() and used as the display name so we
 * always show what the API calls it, not our own label.
 */

const FACILITIES = [
  { code: 'YABULU',    region: 'QLD1', type: 'gas',   fallbackName: 'Townsville Power Station'  },
  { code: 'COLWF01',   region: 'NSW1', type: 'wind',  fallbackName: 'Collector Wind Farm'        },
  { code: 'MEWF',     region: 'QLD1', type: 'wind',  fallbackName: 'Mount Emerald Wind Farm'    },
  { code: 'CSPVPS',    region: 'QLD1', type: 'solar', fallbackName: 'Collinsville Solar Farm'    },
  { code: 'STARFHILL', region: 'SA1',  type: 'wind',  fallbackName: 'Starfish Hill Wind Farm'    },
  { code: 'WINDHILL',  region: 'QLD1', type: 'wind',  fallbackName: 'Windy Hill Wind Farm'       },
  { code: 'LGAPWF1',   region: 'SA1',  type: 'wind',  fallbackName: 'Lincoln Gap Wind Farm'      },
];

// ─── OpenElectricity client ────────────────────────────────────────────────────

async function getClient() {
  const { OpenElectricityClient } = await import('openelectricity');
  const apiKey = process.env.OPENELECTRICITY_API_KEY;
  if (!apiKey) throw new Error('OPENELECTRICITY_API_KEY environment variable not set');
  return new OpenElectricityClient({ apiKey });
}

// ─── Date helpers ──────────────────────────────────────────────────────────────

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

// ─── Resolve actual facility names from API ───────────────────────────────────
// Fetch the full facility list once and build a code→name map.
// This way we display exactly what the API calls each facility.

async function resolveNames(client) {
  const nameMap = {};
  try {
    const { table } = await client.getFacilities({
      network_id: 'NEM',
      status_id: ['operating'],
    });
    const rows = table?.getRecords ? table.getRecords() : (table?.rows ?? []);

    for (const row of rows) {
      const code = row.facility_code || row.code;
      const name = row.facility_name || row.name;
      if (code && name && !nameMap[code]) {
        nameMap[code] = name;
      }
    }

    // Log what we found for our target codes
    for (const f of FACILITIES) {
      if (nameMap[f.code]) {
        console.log(`[facility-data] ${f.code} → "${nameMap[f.code]}"`);
      } else {
        console.warn(`[facility-data] ${f.code} not found in facility list — will use fallback name`);
      }
    }
  } catch (err) {
    console.warn('[facility-data] getFacilities failed, using fallback names:', err.message);
  }
  return nameMap;
}

// ─── Per-facility power data ───────────────────────────────────────────────────

async function fetchFacilityPower(client, facilityCode, dateStart, dateEnd) {
  try {
    const { datatable } = await client.getFacilityData(
      'NEM',
      facilityCode,
      ['power'],
      { interval: '5m', dateStart, dateEnd }
    );

    if (!datatable?.rows?.length) {
      console.warn(`[facility-data] No power data for ${facilityCode}`);
      return [];
    }

    const byInterval = {};
    for (const row of datatable.rows) {
      const ts = row.interval || row.date || row.timestamp;
      if (!ts) continue;
      const normTs = normaliseTs(ts);
      const p = typeof row.power === 'number' ? row.power : 0;
      if (!byInterval[normTs]) byInterval[normTs] = { ts: normTs, power: 0 };
      byInterval[normTs].power += p;
    }

    return Object.values(byInterval)
      .map(v => ({ ts: v.ts, power: parseFloat(v.power.toFixed(2)) }))
      .sort((a, b) => new Date(a.ts) - new Date(b.ts));

  } catch (err) {
    console.error(`[facility-data] Power fetch error for ${facilityCode}:`, err.message);
    return [];
  }
}

// ─── Regional price data ───────────────────────────────────────────────────────

async function fetchRegionalPrices(client, dateStart, dateEnd) {
  try {
    const { datatable } = await client.getMarket(
      'NEM',
      ['price'],
      { interval: '5m', dateStart, dateEnd, primaryGrouping: 'network_region' }
    );

    if (!datatable?.rows?.length) {
      console.warn('[facility-data] No price data from getMarket');
      return {};
    }

    const out = {};
    for (const row of datatable.rows) {
      const region = row.region || row.network_region;
      const ts     = row.interval || row.date || row.timestamp;
      const price  = row.price;
      if (!region || !ts || price == null) continue;
      if (!out[region]) out[region] = {};
      out[region][normaliseTs(ts)] = parseFloat(price.toFixed(2));
    }
    return out;
  } catch (err) {
    console.error('[facility-data] Price fetch error:', err.message);
    return {};
  }
}

// ─── Merge power + price ───────────────────────────────────────────────────────

function mergePowerPrice(powerRows, prices, region) {
  const regionPrices = prices[region] || {};
  return powerRows.map(row => ({
    ts:    row.ts,
    power: row.power,
    price: regionPrices[row.ts] ?? null,
  }));
}

// ─── Summary stats ─────────────────────────────────────────────────────────────

function summarise(merged, capacity) {
  const powers = merged.map(r => r.power).filter(p => p !== null && !isNaN(p));

  const avgPower = powers.length ? powers.reduce((a, b) => a + b, 0) / powers.length : null;
  const maxPower = powers.length ? Math.max(...powers) : null;
  const cf       = capacity && avgPower != null ? (avgPower / capacity) * 100 : null;

  // Generation-weighted average price: sum(power * price) / sum(power)
  // Only intervals where power > 0 AND price is non-null are included.
  // This gives the actual revenue-per-MWh achieved, which is more meaningful
  // for variable generators than a simple time-average of spot prices.
  const validPairs       = merged.filter(r => r.power > 0 && r.price !== null && !isNaN(r.price));
  const totalWeighted    = validPairs.reduce((s, r) => s + r.power * r.price, 0);
  const totalWeight      = validPairs.reduce((s, r) => s + r.power, 0);
  const avgPrice         = totalWeight > 0 ? totalWeighted / totalWeight : null;

  return {
    avgPowerMW:        avgPower != null ? +avgPower.toFixed(2) : null,
    maxPowerMW:        maxPower != null ? +maxPower.toFixed(2) : null,
    avgPricePerMWh:    avgPrice != null ? +avgPrice.toFixed(2) : null,
    capacityFactorPct: cf       != null ? +cf.toFixed(1)       : null,
    intervals: merged.length,
  };
}

// ─── Caching wrapper ──────────────────────────────────────────────────────────

const { withCache, CACHE_KEYS } = require('./_cache');

async function fetchFacilityData() {
  const now       = new Date();
  const start     = new Date(now.getTime() - 8 * 24 * 3600 * 1000);
  const dateStart = toLocalNaive(start);
  const dateEnd   = toLocalNaive(now);

  const client = await getClient();

  // 1. Resolve actual names from API (non-fatal if it fails)
  const nameMap = await resolveNames(client);

  // 2. Fetch all power data in parallel
  const powerResults = await Promise.allSettled(
    FACILITIES.map(f => fetchFacilityPower(client, f.code, dateStart, dateEnd))
  );

  // 3. Fetch regional prices once
  const prices = await fetchRegionalPrices(client, dateStart, dateEnd);

  // 4. Build response
  const facilities = FACILITIES.map((f, i) => {
    const powerRows = powerResults[i].status === 'fulfilled' ? powerResults[i].value : [];
    if (powerResults[i].status === 'rejected') {
      console.error(`[facility-data] ${f.code} power fetch rejected:`, powerResults[i].reason?.message);
    }
    const merged   = mergePowerPrice(powerRows, prices, f.region);
    const capacity = powerRows.length > 0 ? Math.max(...powerRows.map(r => r.power)) : null;

    return {
      code:     f.code,
      name:     nameMap[f.code] || f.fallbackName,
      region:   f.region,
      type:     f.type,
      capacity: capacity,
      found:    !!nameMap[f.code],
      stats:    summarise(merged, capacity),
      data:     merged,
    };
  });

  return {
    success:      true,
    dateStart,
    dateEnd,
    fetchedAt:    now.toISOString(),
    priceRegions: [...new Set(FACILITIES.map(f => f.region))],
    facilities,
  };
}

module.exports = withCache(CACHE_KEYS.FACILITY_DATA, fetchFacilityData);
