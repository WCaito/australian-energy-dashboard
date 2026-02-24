/**
 * refresh-all-cron.js — Nightly cron: pre-populate ALL API caches.
 *
 * Replaces the old historical-all-cron.js with a single job that refreshes
 * every data source at 2 AM AEST (16:00 UTC previous day).
 *
 * Schedule in vercel.json:
 *   { "crons": [{ "path": "/api/refresh-all-cron", "schedule": "0 2 * * *" }] }
 *
 * Security:
 *   Vercel automatically sends Authorization: Bearer <CRON_SECRET> for cron
 *   requests. Set CRON_SECRET in your Vercel environment variables.
 *
 * Timeout budget: 300 s (Hobby plan). The historical fan-out is the slowest
 * part (~60–90 s for 5 regions in parallel). Total should be well under 300 s.
 */

const { kvSet, kvDel, CACHE_KEYS } = require('./_cache');

const HISTORICAL_REGIONS = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'];

function getBaseUrl(req) {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host  = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  return `${proto}://${host}`;
}

async function fetchWithTimeout(url, timeoutMs = 55000) {
  const start = Date.now();
  try {
    const r = await fetch(url, {
      headers: { 'x-refresh': 'true' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const elapsed = Date.now() - start;
    return r.ok
      ? { url, status: 'ok', httpStatus: r.status, ms: elapsed }
      : { url, status: 'error', httpStatus: r.status, ms: elapsed };
  } catch (err) {
    return { url, status: 'error', error: err.message, ms: Date.now() - start };
  }
}

module.exports = async function handler(req, res) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const startedAt = new Date();
  const base = getBaseUrl(req);
  console.log('[refresh-all-cron] Starting nightly refresh at', startedAt.toISOString());

  // ── 1. Clear all caches first ─────────────────────────────────────────────
  const allKeys = [
    CACHE_KEYS.LIVE_PRICES,
    CACHE_KEYS.NEWS,
    CACHE_KEYS.FACILITY_DATA,
    CACHE_KEYS.BESS_NSW,
    CACHE_KEYS.HISTORICAL_ALL,
  ];
  await Promise.allSettled(allKeys.map(k => kvDel(k)));
  console.log('[refresh-all-cron] Cache cleared');

  // ── 2. Fetch fast endpoints ────────────────────────────────────────────────
  const fastResults = await Promise.all([
    fetchWithTimeout(`${base}/api/live-prices?force=true`),
    fetchWithTimeout(`${base}/api/news?force=true`),
  ]);
  console.log('[refresh-all-cron] Fast endpoints:', fastResults.map(r => `${r.url.split('/').pop()} ${r.status}`).join(', '));

  // ── 3. Fetch slow endpoints (OpenElectricity) in parallel ─────────────────
  //    Each of these can take up to 30 s. Running in parallel should fit in budget.
  const slowResults = await Promise.all([
    fetchWithTimeout(`${base}/api/facility-data?force=true`, 90000),
    fetchWithTimeout(`${base}/api/bess-nsw?force=true`, 90000),
    // Historical: fan out per-region, each region fetches in ~10–15 s
    ...HISTORICAL_REGIONS.map(r =>
      fetchWithTimeout(`${base}/api/historical-all?region=${r}&force=true`, 90000)
    ),
  ]);
  console.log('[refresh-all-cron] Slow endpoints:', slowResults.map(r => {
    const name = r.url.includes('region=') ? 'hist-' + r.url.split('region=')[1].split('&')[0] : r.url.split('/').pop().split('?')[0];
    return `${name}:${r.status}`;
  }).join(' '));

  const allResults = [...fastResults, ...slowResults];
  const errors = allResults.filter(r => r.status !== 'ok');
  const elapsed = Date.now() - startedAt.getTime();

  console.log(`[refresh-all-cron] Done in ${elapsed}ms. ${errors.length} errors.`);

  return res.status(200).json({
    success: errors.length === 0,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    elapsedMs: elapsed,
    results: allResults,
    errors: errors.length,
    errorDetails: errors,
  });
};
