/**
 * live-prices.js — Fetch real-time NEM prices from AEMO public API.
 *
 * Caching strategy:
 *   Results are stored in Upstash Redis for 24 hours.
 *   Pass ?force=true to bypass the cache and fetch fresh data.
 *   The nightly cron (/api/refresh-all-cron) pre-populates this cache.
 */

const { withCache, CACHE_KEYS } = require('./_cache');

const AEMO_URL = 'https://visualisations.aemo.com.au/aemo/apps/api/report/ELEC_NEM_SUMMARY';

const REGION_LABELS = {
  NSW1: 'NSW',
  VIC1: 'VIC',
  QLD1: 'QLD',
  SA1: 'SA',
  TAS1: 'TAS',
};

async function fetchLivePrices() {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 8000);

  const response = await fetch(AEMO_URL, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'AustralianEnergyDashboard/2.0',
    },
    signal: controller.signal,
  });
  clearTimeout(tid);

  if (!response.ok) throw new Error(`AEMO returned ${response.status}`);

  const raw = await response.json();
  if (!raw.ELEC_NEM_SUMMARY || !Array.isArray(raw.ELEC_NEM_SUMMARY)) {
    throw new Error('Unexpected AEMO response structure');
  }

  const prices = raw.ELEC_NEM_SUMMARY.map(r => ({
    region: REGION_LABELS[r.REGIONID] || r.REGIONID,
    regionId: r.REGIONID,
    price: parseFloat(r.PRICE).toFixed(2),
    priceRaw: r.PRICE,
    settlementDate: r.SETTLEMENTDATE,
    totalDemand: r.TOTALDEMAND,
    scheduledGeneration: r.SCHEDULEDGENERATION,
    semiScheduledGeneration: r.SEMISCHEDULEDGENERATION,
    netInterchange: r.NETINTERCHANGE,
    priceStatus: r.PRICE_STATUS,
  }));

  const numericPrices = prices.map(r => parseFloat(r.price));
  const avg = numericPrices.reduce((a, b) => a + b, 0) / numericPrices.length;

  const data = prices.map(r => {
    const deviation =
      avg !== 0
        ? (((parseFloat(r.price) - avg) / Math.abs(avg)) * 100).toFixed(2)
        : '0.00';
    return { ...r, change: deviation };
  });

  return {
    success: true,
    data,
    fetchedAt: new Date().toISOString(),
    source: 'AEMO NEM Summary (public)',
    settlementDate: raw.ELEC_NEM_SUMMARY[0]?.SETTLEMENTDATE,
  };
}

module.exports = withCache(CACHE_KEYS.LIVE_PRICES, fetchLivePrices);
