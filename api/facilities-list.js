/**
 * api/facilities-list.js — Operating wind, solar and gas facilities from OpenElectricity
 *
 * getFacilities() returns UNIT-level records (one row per generating unit/DUID).
 * Confirmed field names from bess-nsw.js (working code in this codebase):
 *   facility_code, facility_name, facility_region  ← region is facility_region NOT network_region
 *   unit_code, unit_fueltech, unit_capacity
 *
 * We deduplicate to facility level, summing unit capacities, and keep only
 * fueltechs relevant to a flat-supply portfolio.
 */

'use strict';

const ALLOWED_FUELTECHS = new Set(['wind', 'solar_utility', 'gas_ocgt', 'gas_ccgt', 'gas_steam', 'gas_recip']);
const CACHE_KEY = 'aed:portfolio:facilities-list:v3';
const CACHE_TTL = 24 * 3600;

// ── Redis ──────────────────────────────────────────────────────────────────────

async function getRedis() {
  const { Redis } = await import('@upstash/redis');
  return new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
}
async function kvGet(key) {
  try {
    if (!process.env.UPSTASH_REDIS_REST_URL) return null;
    const r = await (await getRedis()).get(key);
    return r?.data ?? null;
  } catch (e) { console.warn('[facilities-list] kvGet:', e.message); return null; }
}
async function kvSet(key, value) {
  try {
    if (!process.env.UPSTASH_REDIS_REST_URL) return;
    await (await getRedis()).set(key, { data: value, cachedAt: new Date().toISOString() }, { ex: CACHE_TTL });
  } catch (e) { console.warn('[facilities-list] kvSet:', e.message); }
}

// ── OE client ──────────────────────────────────────────────────────────────────

async function getClient() {
  const { OpenElectricityClient } = await import('openelectricity');
  const apiKey = process.env.OPENELECTRICITY_API_KEY;
  if (!apiKey) throw new Error('OPENELECTRICITY_API_KEY not set');
  return new OpenElectricityClient({ apiKey });
}

// ── Handler ────────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const force   = req.query.force === 'true';
  const qFilter = (req.query.q      || '').trim().toLowerCase();
  const rFilter = (req.query.region || '').toUpperCase();

  // ── Cache check ───────────────────────────────────────────────────────────
  if (!force) {
    const cached = await kvGet(CACHE_KEY);
    if (Array.isArray(cached) && cached.length > 0) {
      return res.status(200).json({
        success: true,
        facilities: applyFilters(cached, qFilter, rFilter),
        fromCache: true,
        total: cached.length,
      });
    }
  }

  // ── Fetch from OE ─────────────────────────────────────────────────────────
  try {
    const client = await getClient();
    const result = await client.getFacilities({ network_id: 'NEM', status_id: ['operating'] });

    // Handle both possible SDK return shapes
    const tbl  = result?.table ?? result;
    const rows = typeof tbl?.getRecords === 'function' ? tbl.getRecords() : (tbl?.rows ?? []);

    console.log(`[facilities-list] total rows from OE: ${rows.length}`);

    if (rows.length > 0) {
      // Log field names of first row so we can debug any future SDK changes
      console.log('[facilities-list] row keys:', Object.keys(rows[0]).join(', '));
      console.log('[facilities-list] sample:', JSON.stringify(rows[0]).slice(0, 400));
    }

    // Deduplicate units → facilities
    // Key field names confirmed from bess-nsw.js (working code in this repo):
    //   facility_code, facility_name, facility_region, unit_fueltech, unit_capacity
    const facilityMap = {};

    for (const r of rows) {
      const facilityCode = (r.facility_code || '').trim().toUpperCase();
      const facilityName = (r.facility_name || '').trim();
      const region       = (r.facility_region || '').trim().toUpperCase();  // ← facility_region, NOT network_region
      const fueltech     = (r.unit_fueltech || '').trim().toLowerCase();
      const capacity     = parseFloat(r.unit_capacity || 0) || 0;

      if (!facilityCode || !facilityName || !region) continue;
      if (!ALLOWED_FUELTECHS.has(fueltech)) continue;

      if (!facilityMap[facilityCode]) {
        facilityMap[facilityCode] = { code: facilityCode, name: facilityName, region, fueltech, capacity: 0 };
      }
      facilityMap[facilityCode].capacity += capacity;
    }

    const facilities = Object.values(facilityMap)
      .map(f => ({ ...f, capacity: f.capacity > 0 ? Math.round(f.capacity) : null }))
      .sort((a, b) => a.region.localeCompare(b.region) || a.name.localeCompare(b.name));

    // Log summary for debugging
    const ftCounts = {};
    for (const f of facilities) ftCounts[f.fueltech] = (ftCounts[f.fueltech] || 0) + 1;
    console.log(`[facilities-list] after filter: ${facilities.length} facilities | fueltechs: ${JSON.stringify(ftCounts)}`);

    if (facilities.length === 0) {
      // Return raw fueltech values seen so we can debug
      const seenFT = [...new Set(rows.map(r => r.unit_fueltech || 'undefined'))].sort();
      console.warn('[facilities-list] 0 facilities matched. unit_fueltech values seen:', seenFT.join(', '));
      return res.status(200).json({
        success: true, facilities: [], fromCache: false, total: 0,
        debug: { rowCount: rows.length, seenFueltechs: seenFT, allowedFueltechs: [...ALLOWED_FUELTECHS] },
      });
    }

    await kvSet(CACHE_KEY, facilities);

    return res.status(200).json({
      success: true,
      facilities: applyFilters(facilities, qFilter, rFilter),
      fromCache: false,
      total: facilities.length,
    });

  } catch (err) {
    console.error('[facilities-list] error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};

function applyFilters(list, q, region) {
  return list.filter(f => {
    if (region && f.region !== region) return false;
    if (q) {
      const hay = `${f.code} ${f.name} ${f.region} ${f.fueltech}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
