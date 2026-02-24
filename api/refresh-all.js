/**
 * refresh-all.js — Manually clear and re-populate all API caches.
 *
 * Called by the "Refresh Data" button in the dashboard UI.
 *
 * Behaviour:
 *   1. Deletes all KV cache keys.
 *   2. Re-fetches live-prices and news immediately (fast, ~1–2 s).
 *   3. Kicks off facility-data and bess-nsw fetches in the background
 *      (these use the OpenElectricity API and can take 10–30 s).
 *   4. For historical data, fans out per-region fetches (also background).
 *      They merge their results into the shared historical-all KV key.
 *
 * Security:
 *   Protected by REFRESH_SECRET env var (optional but recommended).
 *   Set REFRESH_SECRET in Vercel → the button must send the matching secret.
 *   If not set, the endpoint is publicly accessible (fine for a read-only
 *   dashboard — worst case someone wastes a few upstream API calls).
 */

const { kvDel, CACHE_KEYS } = require('./_cache');

const HISTORICAL_REGIONS = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'];

function getBaseUrl(req) {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host  = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  return `${proto}://${host}`;
}

async function clearAllCaches() {
  const keys = [
    CACHE_KEYS.LIVE_PRICES,
    CACHE_KEYS.NEWS,
    CACHE_KEYS.FACILITY_DATA,
    CACHE_KEYS.BESS_NSW,
    CACHE_KEYS.HISTORICAL_ALL,
  ];
  await Promise.allSettled(keys.map(k => kvDel(k)));
  console.log('[refresh-all] Cleared', keys.length, 'cache keys');
}

async function refetchEndpoint(base, path, label) {
  const start = Date.now();
  try {
    const r = await fetch(`${base}${path}`, {
      headers: { 'x-refresh': 'true' },
      signal: AbortSignal.timeout(55000),
    });
    const elapsed = Date.now() - start;
    return r.ok
      ? { label, status: 'ok', ms: elapsed }
      : { label, status: 'error', httpStatus: r.status, ms: elapsed };
  } catch (err) {
    return { label, status: 'error', error: err.message, ms: Date.now() - start };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Auth check ────────────────────────────────────────────────────────────
  const secret = process.env.REFRESH_SECRET;
  if (secret) {
    const provided = req.query.secret || (req.headers.authorization || '').replace('Bearer ', '');
    if (provided !== secret) {
      return res.status(401).json({ error: 'Unauthorized — set REFRESH_SECRET in Vercel env vars' });
    }
  }

  const startedAt = new Date().toISOString();
  const base = getBaseUrl(req);

  // ── 1. Clear all caches ───────────────────────────────────────────────────
  await clearAllCaches();

  // ── 2. Re-fetch fast endpoints in parallel (respond after these complete) ─
  const fastResults = await Promise.all([
    refetchEndpoint(base, '/api/live-prices?force=true', 'live-prices'),
    refetchEndpoint(base, '/api/news?force=true', 'news'),
  ]);

  // ── 3. Fire-and-forget slow endpoints ────────────────────────────────────
  const slowFetches = [
    refetchEndpoint(base, '/api/facility-data?force=true', 'facility-data'),
    refetchEndpoint(base, '/api/bess-nsw?force=true', 'bess-nsw'),
    ...HISTORICAL_REGIONS.map(r =>
      refetchEndpoint(base, `/api/historical-all?region=${r}&force=true`, `historical-${r}`)
    ),
  ];

  Promise.allSettled(slowFetches).then(results => {
    const errors = results.filter(r => r.value?.status !== 'ok');
    if (errors.length) console.warn('[refresh-all] Background errors:', errors.map(e => e.value));
    else console.log('[refresh-all] All background fetches complete');
  }).catch(err => console.error('[refresh-all] Background fetch threw:', err.message));

  return res.status(200).json({
    success: true,
    startedAt,
    completedAt: new Date().toISOString(),
    message: 'Cache cleared. Live prices & news refreshed immediately. Facility data, BESS, and historical data are refreshing in the background (15–30 s).',
    immediate: fastResults,
    background: ['facility-data', 'bess-nsw', ...HISTORICAL_REGIONS.map(r => `historical-${r}`)],
  });
};
