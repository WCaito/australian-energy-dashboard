/**
 * api/facilities-list.js — Operating wind, solar and gas facilities from OpenElectricity
 *
 * getFacilities() returns UNIT-level records (one row per generating unit/DUID).
 * Field names from the OE JS SDK RecordTable:
 *   facility_code, facility_name, network_region,
 *   unit_code, unit_fueltech, unit_capacity, unit_status
 *
 * We deduplicate to facility level, summing unit capacities.
 * Fueltechs kept: wind, solar_utility, gas_ocgt, gas_ccgt, gas_steam, gas_recip
 */

'use strict';

const ALLOWED_FUELTECHS = ['wind', 'solar_utility', 'gas_ocgt', 'gas_ccgt', 'gas_steam', 'gas_recip'];
const CACHE_KEY = 'aed:portfolio:facilities-list:v2';
const CACHE_TTL = 24 * 3600;

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
        success: true, facilities: applyFilters(cached, qFilter, rFilter),
        fromCache: true, total: cached.length,
      });
    }
  }

  // ── Fetch from OE ─────────────────────────────────────────────────────────
  try {
    const client = await getClient();
    const { table } = await client.getFacilities({ network_id: 'NEM', status_id: ['operating'] });
    const rows = table?.getRecords ? table.getRecords() : (table?.rows ?? []);

    console.log(`[facilities-list] raw rows: ${rows.length}`);

    // Log first row so we can see the actual field names
    if (rows.length > 0) {
      console.log('[facilities-list] sample row keys:', Object.keys(rows[0]).join(', '));
      console.log('[facilities-list] sample row:', JSON.stringify(rows[0]).slice(0, 300));
    }

    // Build facility map — deduplicate units into facilities
    // Try both naming conventions (SDK may evolve)
    const facilityMap = {};

    for (const r of rows) {
      // Facility-level fields
      const facilityCode = (r.facility_code || r.code || '').toUpperCase();
      const facilityName = r.facility_name || r.name || '';
      const region       = (r.network_region || r.region || '').toUpperCase();

      // Unit-level fields — SDK uses unit_fueltech, unit_capacity
      const fueltech  = (r.unit_fueltech || r.fueltech || r.fueltech_id || '').toLowerCase();
      const capacity  = parseFloat(r.unit_capacity || r.registered_capacity || r.capacity || 0) || 0;

      if (!facilityCode || !facilityName || !region) continue;
      if (!ALLOWED_FUELTECHS.includes(fueltech)) continue;

      if (!facilityMap[facilityCode]) {
        facilityMap[facilityCode] = {
          code: facilityCode,
          name: facilityName,
          region,
          fueltech,
          capacity: 0,
        };
      }
      facilityMap[facilityCode].capacity += capacity;
    }

    const facilities = Object.values(facilityMap)
      .map(f => ({ ...f, capacity: f.capacity > 0 ? Math.round(f.capacity) : null }))
      .sort((a, b) => a.region.localeCompare(b.region) || a.name.localeCompare(b.name));

    console.log(`[facilities-list] after filter+dedup: ${facilities.length} facilities`);

    // Log fueltech distribution for debugging
    const ftCounts = {};
    for (const f of facilities) ftCounts[f.fueltech] = (ftCounts[f.fueltech] || 0) + 1;
    console.log('[facilities-list] fueltech counts:', JSON.stringify(ftCounts));

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
