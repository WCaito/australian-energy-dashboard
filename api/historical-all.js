/**
 * historical-all.js - Fetch historical price data using OpenElectricity SDK
 * 
 * Uses the official openelectricity npm package instead of raw HTTP calls
 * since the API endpoints are not well-documented for direct HTTP access.
 */

const REGIONS = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'];

/**
 * Lazy-load the OpenElectricity client
 */
async function getClient() {
  try {
    const { OpenElectricityClient } = await import('openelectricity');
    const apiKey = process.env.OPENELECTRICITY_API_KEY;
    
    if (!apiKey) {
      throw new Error('OPENELECTRICITY_API_KEY environment variable not set');
    }

    return new OpenElectricityClient({
      apiKey,
    });
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') {
      const installErr = new Error('OpenElectricity SDK not installed. Run: npm install openelectricity');
      installErr.type = 'MISSING_DEPENDENCY';
      throw installErr;
    }
    throw err;
  }
}

/**
 * Convert UTC date to AEST (UTC+10) timezone-naive ISO string
 */
function toAESTLocal(date) {
  const aest = new Date(date.getTime() + 10 * 60 * 60 * 1000);
  return aest.toISOString().replace('Z', '').split('.')[0];
}

/**
 * Fetch price data using the SDK's getMarket method
 */
async function fetchPriceData(dateStart, dateEnd) {
  const client = await getClient();
  
  try {
    // Use the getMarket() method for price data
    const response = await client.getMarket('NEM', ['price'], {
      interval: '1M',
      dateStart,
      dateEnd,
      primaryGrouping: 'network_region',
    });

    return response;
  } catch (err) {
    console.error('[fetchPriceData] SDK error:', err);
    throw err;
  }
}

/**
 * Parse SDK response - datatable structure
 */
function parseDataTableResponse(response) {
  const out = Object.fromEntries(REGIONS.map(r => [r, []]));

  if (!response || !response.datatable) {
    return out;
  }

  const { datatable } = response;
  
  // The datatable has methods like filter(), groupBy(), etc
  // but we need to extract raw data
  const records = datatable.records || datatable.data || [];

  for (const record of records) {
    const region = record.network_region;
    const timestamp = record.interval || record.timestamp || record.date;
    const price = record.price;

    if (!region || !REGIONS.includes(region) || !timestamp || price == null) {
      continue;
    }

    const date = new Date(timestamp);
    if (isNaN(date.getTime())) continue;

    out[region].push({ date, value: price });
  }

  return out;
}

/**
 * Aggregate raw data points into monthly summaries
 */
function buildMonthlyOutput(rawPoints) {
  const buckets = {};

  for (const { date, value } of rawPoints) {
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    
    if (!buckets[key]) {
      buckets[key] = {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        date: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString(),
        prices: [],
      };
    }
    
    buckets[key].prices.push(value);
  }

  return Object.values(buckets)
    .map(bucket => {
      const prices = bucket.prices;
      const avg = prices.reduce((sum, p) => sum + p, 0) / prices.length;
      const max = Math.max(...prices);
      
      const negCount = prices.filter(p => p < 0).length;
      const highPrices = prices.filter(p => p >= 300 && p < 1000);
      const extremePrices = prices.filter(p => p >= 1000);
      const n = prices.length;

      return {
        year: bucket.year,
        month: bucket.month,
        date: bucket.date,
        averagePrice: Number(avg.toFixed(2)),
        maxPrice: Number(max.toFixed(2)),
        priceEvents: {
          negative: {
            count: negCount,
            percentage: n ? Number(((negCount / n) * 100).toFixed(2)) : 0,
          },
          high: {
            count: highPrices.length,
            percentage: n ? Number(((highPrices.length / n) * 100).toFixed(2)) : 0,
            avgPrice: highPrices.length
              ? Number((highPrices.reduce((a, b) => a + b, 0) / highPrices.length).toFixed(2))
              : 0,
          },
          extreme: {
            count: extremePrices.length,
            percentage: n ? Number(((extremePrices.length / n) * 100).toFixed(2)) : 0,
            avgPrice: extremePrices.length
              ? Number((extremePrices.reduce((a, b) => a + b, 0) / extremePrices.length).toFixed(2))
              : 0,
          },
        },
      };
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(200).end();

  let years = parseInt(req.query.years, 10);
  if (!Number.isFinite(years) || years <= 0) years = 1;
  if (years > 5) years = 5;

  const now = new Date();
  const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const startDate = new Date(endDate);
  startDate.setUTCFullYear(endDate.getUTCFullYear() - years);

  const dateStart = toAESTLocal(startDate);
  const dateEnd = toAESTLocal(endDate);

  try {
    const response = await fetchPriceData(dateStart, dateEnd);
    const rawByRegion = parseDataTableResponse(response);

    const processed = {};
    for (const region of REGIONS) {
      processed[region] = buildMonthlyOutput(rawByRegion[region] || []);
    }

    const totalMonths = Object.values(processed).reduce(
      (sum, arr) => sum + arr.length,
      0
    );

    if (totalMonths === 0) {
      return res.status(502).json({
        error: 'Empty response',
        message: 'OpenElectricity SDK returned data but no price records could be parsed',
        dateRange: { start: dateStart, end: dateEnd },
        hint: 'Check your API key permissions and that price data is available for the requested date range',
      });
    }

    return res.status(200).json({
      success: true,
      data: processed,
      fetchedAt: new Date().toISOString(),
      source: 'OpenElectricity API v4 via official SDK',
      dateRange: { start: dateStart, end: dateEnd },
      years,
    });

  } catch (err) {
    console.error('[historical-all] Error:', err);

    if (err.type === 'MISSING_DEPENDENCY') {
      return res.status(500).json({
        error: 'Missing dependency',
        message: err.message,
        hint: 'Add "openelectricity": "^0.5.0" to package.json dependencies and redeploy',
      });
    }

    if (err.message && err.message.includes('OPENELECTRICITY_API_KEY')) {
      return res.status(500).json({
        error: 'Configuration error',
        message: 'OPENELECTRICITY_API_KEY environment variable not set',
        hint: 'Add your API key in Vercel Settings → Environment Variables',
      });
    }

    return res.status(500).json({
      error: 'Internal server error',
      message: err.message || String(err),
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    });
  }
};
