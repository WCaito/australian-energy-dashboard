/**
 * _cache.js — Shared Upstash Redis KV helpers for all API endpoints.
 *
 * Cache strategy:
 *   • All endpoints store results with a 24-hour TTL.
 *   • Pass ?force=true (or set x-refresh: true header) to bypass the cache
 *     and force a fresh fetch. This is what the "Refresh" button uses.
 *   • A nightly Vercel cron (2 AM AEST) pre-populates all caches so users
 *     always get instant data on first load.
 *
 * Cache keys (all prefixed with 'aed:' = Australian Energy Dashboard):
 *   aed:live-prices:v1
 *   aed:news:v1
 *   aed:facility-data:v1
 *   aed:bess-nsw:v1
 *   aed:historical-all:v2:<REGION>   (already used by historical-all.js)
 *
 * Environment variables required (Upstash Redis):
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 */

const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 hours

// All cache keys used across the project — used by refresh-all.js and cache-status.js
const CACHE_KEYS = {
  LIVE_PRICES:   'aed:live-prices:v1',
  NEWS:          'aed:news:v1',
  FACILITY_DATA: 'aed:facility-data:v1',
  BESS_NSW:      'aed:bess-nsw:v1',
  // historical-all.js stores everything in one key: historical-all:v2:<years>
  // The cron and frontend always use years=2, so this is the effective key.
  HISTORICAL_ALL: 'historical-all:v2:2',
};

async function getRedis() {
  const { Redis } = await import('@upstash/redis');
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error('Upstash Redis env vars not set (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)');
  }
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}

/**
 * Read a value from KV. Returns null on miss or if Redis is not configured.
 * The stored value is expected to be a JSON string with shape:
 *   { data: <any>, cachedAt: <ISO string> }
 */
async function kvGet(key) {
  try {
    if (!process.env.UPSTASH_REDIS_REST_URL) return null;
    const redis = await getRedis();
    return await redis.get(key); // Already parsed by @upstash/redis
  } catch (err) {
    console.warn(`[cache] kvGet(${key}) failed:`, err.message);
    return null;
  }
}

/**
 * Write a value to KV with the given TTL (default 24 h).
 * Wraps the value in a { data, cachedAt } envelope.
 */
async function kvSet(key, value, exSeconds = CACHE_TTL_SECONDS) {
  try {
    if (!process.env.UPSTASH_REDIS_REST_URL) return false;
    const redis = await getRedis();
    const envelope = { data: value, cachedAt: new Date().toISOString() };
    await redis.set(key, envelope, { ex: exSeconds });
    return true;
  } catch (err) {
    console.warn(`[cache] kvSet(${key}) failed:`, err.message);
    return false;
  }
}

/**
 * Delete a key from KV.
 */
async function kvDel(key) {
  try {
    if (!process.env.UPSTASH_REDIS_REST_URL) return false;
    const redis = await getRedis();
    await redis.del(key);
    return true;
  } catch (err) {
    console.warn(`[cache] kvDel(${key}) failed:`, err.message);
    return false;
  }
}

/**
 * Convenience: wrap an API handler with cache-first logic.
 *
 * Usage:
 *   module.exports = withCache('aed:live-prices:v1', async () => {
 *     // fetch and return data object
 *   });
 *
 * The wrapped handler:
 *   • Returns cached data immediately when available (adds cachedAt / fromCache fields).
 *   • Fetches fresh data when cache is empty or ?force=true is in the query string.
 *   • Stores fresh data back to KV with a 24-hour TTL.
 */
function withCache(cacheKey, fetcher, ttl = CACHE_TTL_SECONDS) {
  return async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-refresh');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const force = req.query?.force === 'true' || req.headers?.['x-refresh'] === 'true';

    // ── 1. Try cache ──────────────────────────────────────────────────────────
    if (!force) {
      const cached = await kvGet(cacheKey);
      if (cached && cached.data) {
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Cached-At', cached.cachedAt || '');
        return res.status(200).json({
          ...cached.data,
          fromCache: true,
          cachedAt: cached.cachedAt,
        });
      }
    }

    // ── 2. Fetch fresh data ───────────────────────────────────────────────────
    res.setHeader('X-Cache', 'MISS');
    try {
      const freshData = await fetcher(req);
      await kvSet(cacheKey, freshData, ttl);
      return res.status(200).json({
        ...freshData,
        fromCache: false,
        cachedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[cache] Fetcher for ${cacheKey} threw:`, err.message);

      // On error, try to serve stale cache as a fallback
      const stale = await kvGet(cacheKey);
      if (stale && stale.data) {
        res.setHeader('X-Cache', 'STALE');
        return res.status(200).json({
          ...stale.data,
          fromCache: true,
          stale: true,
          cachedAt: stale.cachedAt,
          warning: 'Serving stale cache — live fetch failed: ' + err.message,
        });
      }

      return res.status(502).json({
        success: false,
        error: 'Failed to fetch data and no cache available',
        message: err.message,
      });
    }
  };
}

module.exports = { kvGet, kvSet, kvDel, withCache, CACHE_KEYS, CACHE_TTL_SECONDS };
