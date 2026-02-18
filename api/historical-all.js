/**
 * historical-all.js - Fetch historical price data using OpenElectricity SDK
 * DEBUG VERSION - with extensive logging to understand SDK response structure
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
    console.log('[fetchPriceData] Calling getMarket with:', {
      network: 'NEM',
      metrics: ['price'],
      params: {
        interval: '1M',
        dateStart,
        dateEnd,
        primaryGrouping: 'network_region',
      }
    });

    const response = await client.getMarket('NEM', ['price'], {
      interval: '1M',
      dateStart,
      dateEnd,
      primaryGrouping: 'network_region',
    });

    // Log response structure
    console.log('[fetchPriceData] Response type:', typeof response);
    console.log('[fetchPriceData] Response keys:', Object.keys(response || {}));
    console.log('[fetchPriceData] Has datatable:', !!response?.datatable);
    
    if (response?.datatable) {
      console.log('[fetchPriceData] Datatable type:', typeof response.datatable);
      console.log('[fetchPriceData] Datatable keys:', Object.keys(response.datatable));
      console.log('[fetchPriceData] Datatable constructor:', response.datatable.constructor.name);
      
      // Check for various data access methods
      if (typeof response.datatable.getRecords === 'function') {
        console.log('[fetchPriceData] Has getRecords() method');
      }
      if (typeof response.datatable.toJSON === 'function') {
        console.log('[fetchPriceData] Has toJSON() method');
      }
      if (Array.isArray(response.datatable.records)) {
        console.log('[fetchPriceData] Has records array, length:', response.datatable.records.length);
      }
      if (Array.isArray(response.datatable.data)) {
        console.log('[fetchPriceData] Has data array, length:', response.datatable.data.length);
      }
    }

    return response;
  } catch (err) {
    console.error('[fetchPriceData] SDK error:', err);
    throw err;
  }
}

function parseResponse(response) {
  const out = Object.fromEntries(REGIONS.map(r => [r, []]));

  if (!response) {
    console.log('[parseResponse] No response');
    return out;
  }

  // Try multiple ways to access the data
  let records = [];
  
  if (response.datatable) {
    const dt = response.datatable;
    
    // Method 1: Direct records array
    if (Array.isArray(dt.records)) {
      console.log('[parseResponse] Found dt.records array, length:', dt.records.length);
      records = dt.records;
    }
    // Method 2: data array
    else if (Array.isArray(dt.data)) {
      console.log('[parseResponse] Found dt.data array, length:', dt.data.length);
      records = dt.data;
    }
    // Method 3: getRecords() method
    else if (typeof dt.getRecords === 'function') {
      console.log('[parseResponse] Calling dt.getRecords()');
      records = dt.getRecords();
    }
    // Method 4: toJSON() method
    else if (typeof dt.toJSON === 'function') {
      console.log('[parseResponse] Calling dt.toJSON()');
      const json = dt.toJSON();
      records = json.records || json.data || [];
    }
    // Method 5: Check if datatable itself is an array
    else if (Array.isArray(dt)) {
      console.log('[parseResponse] Datatable itself is an array, length:', dt.length);
      records = dt;
    }
  }

  console.log('[parseResponse] Processing', records.length, 'records');

  // Log first record structure if available
  if (records.length > 0) {
    console.log('[parseResponse] First record keys:', Object.keys(records[0]));
    console.log('[parseResponse] First record sample:', JSON.stringify(records[0]).slice(0, 200));
  }

  for (const record of records) {
    // Try different field names for region
    const region = record.network_region || record.region || record.id || record.name;
    
    // Try different field names for timestamp
    const timestamp = record.interval || record.timestamp || record.date || record.time;
    
    // Try different field names for price
    const price = record.price || record.value;

    if (!region || !REGIONS.includes(region)) {
      continue;
    }

    if (!timestamp || price == null) {
      continue;
    }

    const date = new Date(timestamp);
    if (isNaN(date.getTime())) continue;

    out[region].push({ date, value: price });
  }

  // Log parsing results
  for (const region of REGIONS) {
    console.log(`[parseResponse] ${region}: ${out[region].length} data points`);
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
  if (!Number.isFinite(years) || years <= 0) years = 4;
  if (years > 5) years = 5;

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
      // Return debug info to help diagnose
      return res.status(502).json({
        error: 'Empty response',
        message: 'OpenElectricity SDK returned data but no price records could be parsed',
        debug: {
          responseKeys: response ? Object.keys(response) : null,
          hasDatatable: !!response?.datatable,
          datatableType: response?.datatable ? typeof response.datatable : null,
          datatableKeys: response?.datatable ? Object.keys(response.datatable) : null,
        },
        dateRange: { start: dateStart, end: dateEnd },
        hint: 'Check Vercel function logs for detailed debug output. The SDK response structure may have changed.',
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
        hint: 'Vercel should install it automatically from package.json. Check build logs.',
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
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    });
  }
};
