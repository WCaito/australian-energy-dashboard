/**
 * historical-all.js - Fetch historical price data using OpenElectricity SDK
 * FIXED VERSION - correctly accesses datatable.rows
 */

const REGIONS = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'];

async function getClient() {
  try {
    const { OpenElectricityClient } = await import('openelectricity');
    const apiKey = process.env.OPENELECTRICITY_API_KEY;
    
    if (!apiKey) {
      throw new Error('OPENELECTRICITY_API_KEY environment variable not set');
    }

    return new OpenElectricityClient({ apiKey });
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') {
      const installErr = new Error('OpenElectricity SDK not installed');
      installErr.type = 'MISSING_DEPENDENCY';
      throw installErr;
    }
    throw err;
  }
}

function toAESTLocal(date) {
  const aest = new Date(date.getTime() + 10 * 60 * 60 * 1000);
  return aest.toISOString().replace('Z', '').split('.')[0];
}

async function fetchPriceData(dateStart, dateEnd) {
  const client = await getClient();
  
  try {
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
 * Parse SDK DataTable response
 * The datatable has: { rows, groupings, metrics, cache, rowsMap }
 */
function parseResponse(response) {
  const out = Object.fromEntries(REGIONS.map(r => [r, []]));

  if (!response?.datatable?.rows) {
    console.log('[parseResponse] No datatable.rows found');
    return out;
  }

  const rows = response.datatable.rows;
  console.log('[parseResponse] Processing', rows.length, 'rows');

  // Log first row structure if available
  if (rows.length > 0) {
    console.log('[parseResponse] First row keys:', Object.keys(rows[0]));
    console.log('[parseResponse] First row sample:', JSON.stringify(rows[0]).slice(0, 300));
  }

  for (const row of rows) {
    // The DataTable rows contain the data with proper field names
    const region = row.network_region;
    const timestamp = row.interval || row.date || row.timestamp;
    const price = row.price;

    if (!region || !REGIONS.includes(region)) {
      continue;
    }

    if (!timestamp || price == null) {
      continue;
    }

    const date = new Date(timestamp);
    if (isNaN(date.getTime())) {
      console.log('[parseResponse] Invalid date:', timestamp);
      continue;
    }

    out[region].push({ date, value: price });
  }

  // Log parsing results
  for (const region of REGIONS) {
    if (out[region].length > 0) {
      console.log(`[parseResponse] ${region}: ${out[region].length} data points`);
    }
  }

  return out;
}

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
  if (years > 1) years = 1;

  const now = new Date();
  const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const startDate = new Date(endDate);
  startDate.setUTCFullYear(endDate.getUTCFullYear() - years);

  const dateStart = toAESTLocal(startDate);
  const dateEnd = toAESTLocal(endDate);

  console.log('[handler] Date range:', { dateStart, dateEnd, years });

  try {
    const response = await fetchPriceData(dateStart, dateEnd);
    const rawByRegion = parseResponse(response);

    const processed = {};
    for (const region of REGIONS) {
      processed[region] = buildMonthlyOutput(rawByRegion[region] || []);
    }

    const totalMonths = Object.values(processed).reduce(
      (sum, arr) => sum + arr.length,
      0
    );

    console.log('[handler] Total months processed:', totalMonths);

    if (totalMonths === 0) {
      // Return debug info
      return res.status(502).json({
        error: 'Empty response',
        message: 'OpenElectricity SDK returned no parseable price data',
        debug: {
          rowsCount: response?.datatable?.rows?.length || 0,
          hasRows: !!response?.datatable?.rows,
          firstRowSample: response?.datatable?.rows?.[0] 
            ? JSON.stringify(response.datatable.rows[0]).slice(0, 500)
            : null,
        },
        dateRange: { start: dateStart, end: dateEnd },
        hint: 'The date range may not have data, or the API key may not have access. Check Vercel logs for details.',
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
    console.error('[handler] Error:', err);
    console.error('[handler] Error stack:', err.stack);

    if (err.type === 'MISSING_DEPENDENCY') {
      return res.status(500).json({
        error: 'Missing dependency',
        message: 'OpenElectricity SDK not installed',
        hint: 'Vercel should install it automatically. Check build logs.',
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
      type: err.constructor.name,
    });
  }
};
