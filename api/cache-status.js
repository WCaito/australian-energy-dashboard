/**
 * cache-status.js — Returns the cache age for every data source.
 *
 * Used by the dashboard UI to show "Data cached X hours ago" and
 * to decide whether a manual refresh is warranted.
 */

const { kvGet, CACHE_KEYS } = require('./_cache');

const HISTORICAL_REGIONS = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'];

// Entries we check. Historical data is all in ONE key (merged object).
const SIMPLE_ENTRIES = [
  { key: CACHE_KEYS.LIVE_PRICES,   label: 'Live Prices'   },
  { key: CACHE_KEYS.FACILITY_DATA, label: 'Facility Data' },
  { key: CACHE_KEYS.BESS_NSW,      label: 'NSW Batteries' },
];

function ageHuman(minutes) {
  if (minutes < 1)  return 'just now';
  if (minutes < 60) return `${Math.round(minutes)} min ago`;
  const h = Math.round(minutes / 60);
  if (h < 24)       return `${h} hour${h !== 1 ? 's' : ''} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d !== 1 ? 's' : ''} ago`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const redisConfigured = !!process.env.UPSTASH_REDIS_REST_URL;
  const checkedAt = new Date();

  // Check simple entries
  const simpleResults = await Promise.all(
    SIMPLE_ENTRIES.map(async ({ key, label }) => {
      const cached = await kvGet(key);
      if (!cached || !cached.cachedAt) {
        return { key, label, present: false, cachedAt: null, ageMinutes: null, ageHuman: 'no cache' };
      }
      const ageMinutes = (checkedAt - new Date(cached.cachedAt)) / 60000;
      return { key, label, present: true, cachedAt: cached.cachedAt, ageMinutes: +ageMinutes.toFixed(1), ageHuman: ageHuman(ageMinutes) };
    })
  );

  // Check historical (one key, check which regions are populated)
  const historical = await kvGet(CACHE_KEYS.HISTORICAL_ALL);
  const coveredRegions = historical && typeof historical === 'object'
    ? HISTORICAL_REGIONS.filter(r => Array.isArray(historical[r]) && historical[r].length > 0)
    : [];
  
  // Historical doesn't use the { data, cachedAt } envelope — it's stored raw
  // So we check if data exists rather than cachedAt
  const historicalEntry = {
    key: CACHE_KEYS.HISTORICAL_ALL,
    label: 'Historical Data',
    present: coveredRegions.length === HISTORICAL_REGIONS.length,
    coveredRegions,
    missingRegions: HISTORICAL_REGIONS.filter(r => !coveredRegions.includes(r)),
    cachedAt: null,  // historical-all doesn't store a cachedAt timestamp in the envelope
    ageMinutes: null,
    ageHuman: coveredRegions.length === HISTORICAL_REGIONS.length ? 'present (no timestamp)' : 'partial or missing',
  };

  const entries = [...simpleResults, historicalEntry];
  const presentSimple = simpleResults.filter(e => e.present);
  const oldestAgeMinutes = presentSimple.length
    ? Math.max(...presentSimple.map(e => e.ageMinutes))
    : null;

  return res.status(200).json({
    success: true,
    checkedAt: checkedAt.toISOString(),
    redisConfigured,
    oldestAgeMinutes,
    oldestAgeHuman: oldestAgeMinutes !== null ? ageHuman(oldestAgeMinutes) : 'no cache',
    allPresent: entries.every(e => e.present),
    entries,
  });
};
