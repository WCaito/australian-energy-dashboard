/**
 * api/facilities-list.js — Operating wind, solar and gas facilities from OpenElectricity
 *
 * Returns all NEM facilities with operating status, filtered to fueltechs
 * relevant to a flat-supply portfolio: wind, solar_utility, gas_ocgt, gas_ccgt.
 *
 * Used by portfolio.html to populate the facility search/selector.
 *
 * CACHING: 24 h Redis TTL (facility registry changes rarely).
 *
 * QUERY PARAMS
 *   ?force=true   Bypass cache and re-fetch from OE
 *   ?q=abc        Optional text filter (applied server-side for convenience)
 *   ?region=SA1   Optional region filter
 */

'use strict';

const ALLOWED_FUELTECHS = ['wind', 'solar_utility', 'gas_ocgt', 'gas_ccgt', 'gas_steam', 'gas_recip'];
const CACHE_KEY = 'aed:portfolio:facilities-list:v1';
const CACHE_TTL = 24 * 3600;

// ── Redis helpers ──────────────────────────────────────────────────────────────

async function getRedis() {
  const { Redis } = await import('@upstash/redis');
  return new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}

async function kvGet(key) {
  try {
    if (!process.env.UPSTASH_REDIS_REST_URL) return null;
    const cached = await (await getRedis()).get(key);
    return cached?.data ?? null;
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

// ── Normalise fueltech string from OE ─────────────────────────────────────────
// OE returns values like "wind", "solar_utility", "gas_ocgt" etc.
// We check if the lowercase fueltech contains any of our allowed keywords.

function isAllowedFueltech(ft) {
  if (!ft) return false;
  const f = ft.toLowerCase().replace(/[^a-z_]/g, '');
  return ALLOWED_FUELTECHS.some(a => f === a || f.includes(a.replace('_', '')));
}

// ── Handler ────────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const force     = req.query.force === 'true';
  const qFilter   = (req.query.q     || '').trim().toLowerCase();
  const rFilter   = (req.query.region || '').toUpperCase();

  // ── Cache check ───────────────────────────────────────────────────────────
  if (!force) {
    const cached = await kvGet(CACHE_KEY);
    if (Array.isArray(cached) && cached.length > 0) {
      const filtered = applyFilters(cached, qFilter, rFilter);
      return res.status(200).json({ success: true, facilities: filtered, fromCache: true, total: cached.length });
    }
  }

  // ── Fetch from OE ─────────────────────────────────────────────────────────
  try {
    const client = await getClient();
    const { table } = await client.getFacilities({ network_id: 'NEM', status_id: ['operating'] });
    const rows = table?.getRecords ? table.getRecords() : (table?.rows ?? []);

    const facilities = rows
      .map(r => {
        const ft = r.fueltech || r.fueltech_id || r.fueltech_code || '';
        return {
          code:     (r.facility_code || r.code || '').toUpperCase(),
          name:     r.facility_name || r.name || '',
          region:   (r.network_region || r.region || '').toUpperCase(),
          fueltech: ft.toLowerCase(),
          capacity: r.capacity || r.registered_capacity || r.registered_capacity_mw || null,
        };
      })
      .filter(r => r.code && r.name && r.region && isAllowedFueltech(r.fueltech))
      .sort((a, b) => a.region.localeCompare(b.region) || a.name.localeCompare(b.name));

    await kvSet(CACHE_KEY, facilities);

    const filtered = applyFilters(facilities, qFilter, rFilter);
    return res.status(200).json({ success: true, facilities: filtered, fromCache: false, total: facilities.length });

  } catch (err) {
    console.error('[facilities-list] error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};

function applyFilters(list, q, region) {
  return list.filter(f => {
    if (region && f.region !== region) return false;
    if (q) {
      const haystack = `${f.code} ${f.name} ${f.region} ${f.fueltech}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}
