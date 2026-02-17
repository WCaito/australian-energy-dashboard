/**
 * live-prices.js — Fetch real-time NEM prices from AEMO public API.
 * No API key required. Data updates every 5 minutes.
 */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const AEMO_URL = 'https://visualisations.aemo.com.au/aemo/apps/api/report/ELEC_NEM_SUMMARY';

  const REGION_LABELS = {
    NSW1: 'NSW',
    VIC1: 'VIC',
    QLD1: 'QLD',
    SA1: 'SA',
    TAS1: 'TAS',
  };

  try {
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

    if (!response.ok) {
      throw new Error(`AEMO returned ${response.status}`);
    }

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

    // Calculate deviation from the cross-region average for a relative indicator
    const numericPrices = prices.map(r => parseFloat(r.price));
    const avg = numericPrices.reduce((a, b) => a + b, 0) / numericPrices.length;

    const data = prices.map(r => {
      const deviation =
        avg !== 0
          ? (((parseFloat(r.price) - avg) / Math.abs(avg)) * 100).toFixed(2)
          : '0.00';
      return { ...r, change: deviation };
    });

    return res.status(200).json({
      success: true,
      data,
      fetchedAt: new Date().toISOString(),
      source: 'AEMO NEM Summary (public)',
      settlementDate: raw.ELEC_NEM_SUMMARY[0]?.SETTLEMENTDATE,
    });
  } catch (err) {
    console.error('[live-prices] Error:', err.message);
    const isTimeout = err.name === 'AbortError';
    return res.status(isTimeout ? 504 : 502).json({
      success: false,
      error: isTimeout ? 'AEMO API timed out' : 'Failed to fetch live prices',
      message: err.message,
    });
  }
};
