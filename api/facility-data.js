/**
 * facility-data.js  —  Per-facility 5-minute power + price data
 *
 * STRATEGY:
 *   1. Call getFacilities() to discover correct facility codes by name
 *   2. Fetch 8 days of 5-min power data per facility (getFacilityData)
 *   3. Fetch 8 days of 5-min regional price data (getMarket)
 *   4. Merge and return combined dataset
 *
 * The name-matching approach means this works even if the exact facility
 * codes differ from expectations — it finds them at runtime.
 *
 * TARGET FACILITIES:
 *   Townsville Power Station    QLD  gas/thermal
 *   Collector Wind Farm         NSW  wind
 *   Mount Emerald Wind Farm     QLD  wind
 *   Collinsville Solar Farm     QLD  solar
 *   Starfish Hill Wind Farm     SA   wind
 *   Windy Hill Wind Farm        QLD  wind
 */

// Target facilities — searchTerms: ALL must appear in facility_name (case-insensitive).
//                  excludeTerms: ANY match disqualifies the row.
//
// ORDERING: put more specific entries BEFORE broader ones for the same name prefix.
//   Stage 2 is listed before Stage 1 so it claims its code first. Stage 1 then
//   matches whatever Lincoln Gap facility remains (may have no stage suffix at all).
//
// MOUNT EMERALD: excludeTerms:['solar'] prevents matching "Mount Emerald Solar Farm"
//   which also contains "emerald" and appears in the facility list.
const TARGET_FACILITIES = [
  { searchTerms: ['townsville'],              displayName: 'Townsville Power Station',         region: 'QLD1', type: 'gas',   hintCode: 'YABULU'    },
  { searchTerms: ['collector'],               displayName: 'Collector Wind Farm',              region: 'NSW1', type: 'wind',  hintCode: 'COLLECTOR' },
  { searchTerms: ['emerald', 'wind'],          displayName: 'Mount Emerald Wind Farm',          region: 'QLD1', type: 'wind',  hintCode: 'MEWF1' },
  { searchTerms: ['collinsville'],            displayName: 'Collinsville Solar Farm',          region: 'QLD1', type: 'solar', hintCode: 'CSPVPS'    },
  { searchTerms: ['starfish'],                displayName: 'Starfish Hill Wind Farm',          region: 'SA1',  type: 'wind',  hintCode: 'STARFHILL' },
  { searchTerms: ['windy hill'],              displayName: 'Windy Hill Wind Farm',             region: 'QLD1', type: 'wind',  hintCode: 'WINDHILL'  },
  { searchTerms: ['lincoln gap'],             displayName: 'Lincoln Gap Wind Farm',            region: 'SA1',  type: 'wind',  hintCode: 'LGAPWF1'   },
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
  // OE API expects naive local (AEST = UTC+10) datetime strings
  const aest = new Date(date.getTime() + 10 * 3600 * 1000);
  return aest.toISOString().slice(0, 19);
}

// Normalise a timestamp to an unambiguous ISO string.
// The OE SDK returns naive AEST strings like "2026-02-12T14:30:00" (no Z, no offset).
// We append +10:00 so the browser parses them as the correct wall-clock AEST time
// rather than as local browser time.
function normaliseTs(ts) {
  if (!ts) return ts;
  const s = String(ts);
  // Already has Z or explicit offset — leave alone
  if (s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s)) return s;
  // Naive string — treat as AEST (UTC+10)
  return s + '+10:00';
}

// ─── Facility discovery by name ────────────────────────────────────────────────

async function discoverFacilities(client) {
  console.log('[facility-data] Fetching facility list from OpenElectricity');

  let allFacilities = [];
  try {
    const { table } = await client.getFacilities({
      network_id: 'NEM',
      status_id: ['operating'],
    });
    allFacilities = table.getRecords ? table.getRecords() : (table.rows || []);
  } catch (err) {
    console.warn('[facility-data] getFacilities failed:', err.message);
    // Fall back to hint codes
    return TARGET_FACILITIES.map(t => ({ ...t, facilityCode: t.hintCode, found: false }));
  }

  console.log(`[facility-data] Got ${allFacilities.length} facility rows from API`);

  // De-duplicate rows to one per facility_code (API returns one row per unit).
  // Keep the row with the largest unit_capacity for a meaningful capacity figure.
  const byFacilityCode = {};
  for (const row of allFacilities) {
    const code = row.facility_code || row.code;
    if (!code) continue;
    const cap = parseFloat(row.unit_capacity || 0) || 0;
    if (!byFacilityCode[code] || cap > (parseFloat(byFacilityCode[code].unit_capacity) || 0)) {
      byFacilityCode[code] = row;
    }
  }
  const uniqueFacilities = Object.values(byFacilityCode);
  console.log(`[facility-data] ${uniqueFacilities.length} distinct facility codes`);

  // Log Lincoln Gap entries explicitly so we can see real names & codes
  const lgRows = uniqueFacilities.filter(f =>
    (f.facility_name || '').toLowerCase().includes('lincoln')
  );
  if (lgRows.length) {
    console.log('[facility-data] Lincoln Gap entries:',
      lgRows.map(r => `${r.facility_code} — "${r.facility_name}" (${r.unit_capacity} MW)`).join(' | ')
    );
  } else {
    console.log('[facility-data] WARNING: No Lincoln Gap entries found in facility list');
  }

  // Track claimed codes so two targets can never match the same facility_code.
  // This prevents Stage 1 and Stage 2 searches from both resolving to the same record.
  const claimedCodes = new Set();

  const resolved = [];
  for (const target of TARGET_FACILITIES) {
    const terms = target.searchTerms;

    // Every term in searchTerms must appear in the facility_name (case-insensitive).
    // Using multiple terms lets us match non-contiguous words, e.g. "lincoln gap"
    // AND "stage 1" both appear in "Lincoln Gap Wind Farm Stage 1" but the single
    // string "lincoln gap stage 1" does NOT (because "wind farm" is in between).
    const excludes = target.excludeTerms || [];
    const match = uniqueFacilities.find(f => {
      const name = (f.facility_name || f.name || '').toLowerCase();
      const code = f.facility_code || f.code;
      // Must not be already claimed, all searchTerms must be present,
      // and none of the excludeTerms may be present
      return !claimedCodes.has(code)
          && terms.every(t => name.includes(t))
          && excludes.every(x => !name.includes(x));
    });

    if (match) {
      const code = match.facility_code || match.code || target.hintCode;
      const capacity = parseFloat(match.unit_capacity || match.capacity) || null;
      claimedCodes.add(code);
      console.log(`[facility-data] MATCHED "${target.displayName}" → ${code} (${capacity} MW) terms:[${terms.join(', ')}]`);
      resolved.push({ ...target, facilityCode: code, capacity, found: true, rawRecord: match });
    } else {
      const excStr = excludes.length ? ` exclude:[${excludes.join(', ')}]` : '';
      console.warn(`[facility-data] NOT FOUND: "${target.displayName}" — falling back to hint code ${target.hintCode} — terms:[${terms.join(', ')}]${excStr}`);
      resolved.push({ ...target, facilityCode: target.hintCode, found: false });
    }
  }

  return resolved;
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

    // Aggregate across all units (sum power per interval)
    const byInterval = {};
    for (const row of datatable.rows) {
      const ts = row.interval || row.date || row.timestamp;
      if (!ts) continue;
      const p = typeof row.power === 'number' ? row.power : 0;
      if (!byInterval[ts]) byInterval[ts] = { ts, power: 0, units: new Set() };
      byInterval[ts].power += p;
      if (row.unit_code) byInterval[ts].units.add(row.unit_code);
    }

    return Object.values(byInterval)
      .map(v => ({
        // Normalise to proper UTC ISO string.
        // OE returns naive AEST strings (no Z); append Z so the browser
        // doesn't misread them as local time — they ARE already UTC+10,
        // so we store them as explicit UTC+10 offset.
        ts: normaliseTs(v.ts),
        power: parseFloat(v.power.toFixed(2)),
      }))
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
      {
        interval: '5m',
        dateStart,
        dateEnd,
        primaryGrouping: 'network_region',
      }
    );

    if (!datatable?.rows?.length) {
      console.warn('[facility-data] No price data from getMarket');
      return {};
    }

    // Indexed as { region: { ts: price } }
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
  const prices = merged.map(r => r.price).filter(p => p !== null && !isNaN(p));

  const avgPower = powers.length ? powers.reduce((a, b) => a + b, 0) / powers.length : null;
  const maxPower = powers.length ? Math.max(...powers) : null;
  const minPower = powers.length ? Math.min(...powers) : null;
  const avgPrice = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;

  const cf = capacity && avgPower != null ? (avgPower / capacity) * 100 : null;

  return {
    avgPowerMW:       avgPower  != null ? +avgPower.toFixed(2)  : null,
    maxPowerMW:       maxPower  != null ? +maxPower.toFixed(2)  : null,
    minPowerMW:       minPower  != null ? +minPower.toFixed(2)  : null,
    avgPricePerMWh:   avgPrice  != null ? +avgPrice.toFixed(2)  : null,
    capacityFactorPct:cf        != null ? +cf.toFixed(1)        : null,
    intervals: merged.length,
  };
}

// ─── Main handler ──────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const now    = new Date();
  const start  = new Date(now.getTime() - 8 * 24 * 3600 * 1000);
  const dateStart = toLocalNaive(start);
  const dateEnd   = toLocalNaive(now);

  try {
    const client = await getClient();

    // 1. Discover facility codes by name
    const resolved = await discoverFacilities(client);

    // 2. Fetch all power data in parallel
    const powerResults = await Promise.allSettled(
      resolved.map(f => fetchFacilityPower(client, f.facilityCode, dateStart, dateEnd))
    );

    // 3. Fetch regional prices once (covers QLD1, NSW1, SA1 all in one call)
    const prices = await fetchRegionalPrices(client, dateStart, dateEnd);

    // 4. Build final response
    const facilities = resolved.map((f, i) => {
      const powerRows = powerResults[i].status === 'fulfilled' ? powerResults[i].value : [];
      const merged    = mergePowerPrice(powerRows, prices, f.region);
      const stats     = summarise(merged, f.capacity);

      return {
        code:        f.facilityCode,
        name:        f.displayName,
        region:      f.region,
        type:        f.type,
        capacity:    f.capacity,
        found:       f.found,
        stats,
        data:        merged,   // [{ts, power, price}]
      };
    });

    // Unique regions fetched for price
    const priceRegions = [...new Set(resolved.map(f => f.region))];

    return res.status(200).json({
      success:     true,
      dateStart,
      dateEnd,
      fetchedAt:   now.toISOString(),
      priceRegions,
      facilities,
    });

  } catch (err) {
    console.error('[facility-data] Fatal error:', err);
    return res.status(500).json({
      success: false,
      error:   err.message || 'Internal server error',
      hint:    err.type === 'MISSING_DEPENDENCY'
        ? 'Run: npm install openelectricity'
        : 'Check OPENELECTRICITY_API_KEY env var',
    });
  }
};
