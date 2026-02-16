// historical-all.js
// Serverless handler to fetch and aggregate NEM price data from OpenElectricity v4

const https = require('https');

/**
 * Fetch price data from OpenElectricity API v4
 * Docs: Base URL + Bearer auth (v4)  → https://docs.openelectricity.org.au/api-reference/overview
 *       Network time-series endpoint  → /v4/data/network/{network_code}
 *       Use snake_case params: date_start, date_end; add primary_grouping=network_region
 */
function fetchOpenElectricityData(startDate, endDate, apiKey) {
  return new Promise((resolve, reject) => {
    // ✅ FIX: snake_case parameter names + region grouping so we get NSW1/VIC1/etc
    const params = new URLSearchParams({
      metrics: 'price',
      interval: '1d',
      date_start: startDate,         // was dateStart
      date_end: endDate,             // was dateEnd
      primary_grouping: 'network_region'
    });

    const path = `/v4/data/network/NEM?${params.toString()}`;
    const options = {
      hostname: 'api.openelectricity.org.au',
      port: 443,
      path,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,   // ✅ Bearer token per API overview
        'Accept': 'application/json'
      }
    };

    console.log(`Fetching OpenElectricity: https://${options.hostname}${path}`);
    console.log(`Date range: ${startDate} → ${endDate}`);

    const req = https.request(options, (res) => {
      let data = '';

      console.log(`Response status: ${res.statusCode}`);
      const requestId = res.headers['x-request-id'] || res.headers['X-Request-ID'];
      if (requestId) console.log(`request-id: ${requestId}`);

      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            console.error(`Error body (truncated): ${data.slice(0, 800)}`);
            return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
          }
          const json = JSON.parse(data);
          return resolve(json);
        } catch (err) {
          console.error('JSON parse error:', err);
          console.error('Data (truncated):', data.slice(0, 500));
          return reject(err);
        }
      });
    });

    req.on('error', (err) => {
      console.error('Request error:', err);
      reject(err);
    });

    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout after 30s'));
    });

    req.end();
  });
}

/**
 * Process v4 time-series response into monthly stats and price event counts.
 * v4 response shape (relevant bits):
 *   data: [
 *     {
 *       metric: "price",
 *       results: [
 *         {
 *           name: "NSW1" | ...            // or columns.network_region
 *           columns?: { network_region?: "NSW1" }
 *           data: [ { timestamp: ISO8601, value: number }, ... ]
 *         },
 *         ...
 *       ]
 *     }
 *   ]
 * See SDK/client patterns that use `timestamp`/`value` data points. [4](https://learn.microsoft.com/en-us/power-platform/admin/programmability-authentication)[5](https://github.com/opennem/openelectricity-typescript/blob/main/README.md)
 */
function processOpenElectricityResponse(apiResponse) {
  console.log('Processing response...');
  if (!apiResponse || apiResponse.success === false) {
    console.error('API response indicates failure or is empty');
    return {};
  }
  if (!apiResponse.data || !Array.isArray(apiResponse.data)) {
    console.error('Missing or invalid `data` array in response');
    return {};
  }

  const regions = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'];
  const allData = {};
  regions.forEach((r) => { allData[r] = {}; });

  console.log(`Top-level series count: ${apiResponse.data.length}`);

  // Loop each time series (expecting metric: "price")
  apiResponse.data.forEach((series, idx) => {
    console.log(`Series[${idx}] metric=${series.metric} interval=${series.interval} results=${series.results?.length ?? 0}`);

    if (series.metric && series.metric.toLowerCase() !== 'price') {
      console.log(`Skipping non-price metric: ${series.metric}`);
      return;
    }
    if (!Array.isArray(series.results)) {
      console.log('No results[] on series; skipping');
      return;
    }

    // Each result is one region (when grouped by network_region)
    series.results.forEach((result) => {
      const region =
        result?.columns?.network_region ||
        result?.name ||
        result?.id;

      if (!region || !regions.includes(region)) {
        console.log(`Skipping unknown region label: ${region}`);
        return;
      }

      // ✅ v4 uses result.data[] with { timestamp, value } (fallback to history[] if present)
      const points = Array.isArray(result.data)
        ? result.data
        : (Array.isArray(result.history) ? result.history : []);

      if (!points.length) {
        console.log(`No data points for region ${region}`);
        return;
      }

      console.log(`Processing ${points.length} points for ${region}`);

      points.forEach((pt) => {
        const ts = pt.timestamp || pt.interval;     // tolerate either field
        const val = pt.value;
        if (val === null || val === undefined) return;

        const d = new Date(ts);
        const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

        if (!allData[region][monthKey]) {
          allData[region][monthKey] = {
            year: d.getFullYear(),
            month: d.getMonth() + 1,
            date: new Date(d.getFullYear(), d.getMonth(), 1).toISOString(),
            prices: [],
            negativeCount: 0,
            highCount: 0,
            extremeCount: 0,
            highPrices: [],
            extremePrices: []
          };
        }

        // Track prices + event thresholds
        allData[region][monthKey].prices.push(val);
        if (val < 0) {
          allData[region][monthKey].negativeCount++;
        } else if (val >= 300 && val < 1000) {
          allData[region][monthKey].highCount++;
          allData[region][monthKey].highPrices.push(val);
        } else if (val >= 1000) {
          allData[region][monthKey].extremeCount++;
          allData[region][monthKey].extremePrices.push(val);
        }
      });
    });
  });

  // Aggregate per-month stats per region
  const result = {};
  regions.forEach((region) => {
    const monthly = Object.values(allData[region])
      .filter((m) => m.prices.length > 0)
      .map((m) => {
        const avg = m.prices.reduce((a, b) => a + b, 0) / m.prices.length;
        const max = Math.max(...m.prices);
        const totalN = m.prices.length;

        const avgHigh = m.highPrices.length
          ? m.highPrices.reduce((a, b) => a + b, 0) / m.highPrices.length
          : 0;
        const avgExtreme = m.extremePrices.length
          ? m.extremePrices.reduce((a, b) => a + b, 0) / m.extremePrices.length
          : 0;

        return {
          year: m.year,
          month: m.month,
          date: m.date,
          averagePrice: parseFloat(avg.toFixed(2)),
          maxPrice: parseFloat(max.toFixed(2)),
          priceEvents: {
            negative: {
              count: m.negativeCount,
              percentage: ((m.negativeCount / totalN) * 100).toFixed(2)
            },
            high: {
              count: m.highCount,
              percentage: ((m.highCount / totalN) * 100).toFixed(2),
              avgPrice: parseFloat(avgHigh.toFixed(2))
            },
            extreme: {
              count: m.extremeCount,
              percentage: ((m.extremeCount / totalN) * 100).toFixed(2),
              avgPrice: parseFloat(avgExtreme.toFixed(2))
            }
          }
        };
      })
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    result[region] = monthly;
    console.log(`Region ${region}: ${monthly.length} months`);
  });

  console.log('Processing complete.');
  return result;
}

/**
 * Serverless function handler
 */
module.exports = async (req, res) => {
  // ✅ CORS for browser calls
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const API_KEY = process.env.OPENELECTRICITY_API_KEY; // Set this in your host
  if (!API_KEY) {
    console.error('OPENELECTRICITY_API_KEY not set');
    return res.status(500).json({
      error: 'API key not configured',
      message: 'OPENELECTRICITY_API_KEY environment variable not set'
    });
  }
  console.log(`API key configured (prefix): ${API_KEY.substring(0, 10)}...`);

  try {
    const years = Number.parseInt(req.query.years, 10) || 4;
    // To avoid partial data on the latest day, go back 2 days
    const endDate = new Date();
    endDate.setDate(endDate.getDate() - 2);
    const startDate = new Date(endDate);
    startDate.setFullYear(endDate.getFullYear() - years);

    const endDateStr = endDate.toISOString().slice(0, 10);
    const startDateStr = startDate.toISOString().slice(0, 10);

    console.log(`Requesting ${years} years: ${startDateStr} → ${endDateStr}`);

    const apiResponse = await fetchOpenElectricityData(startDateStr, endDateStr, API_KEY);
    const processedData = processOpenElectricityResponse(apiResponse);

    const totalMonths = Object.values(processedData)
      .reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);

    if (totalMonths === 0) {
      console.error('No data points after processing.');
      return res.status(404).json({
        error: 'No data available',
        message: 'OpenElectricity API returned data but processing yielded no results',
        debug: {
          apiResponseSuccess: apiResponse?.success,
          apiDataLength: apiResponse?.data?.length,
          startDate: startDateStr,
          endDate: endDateStr
        }
      });
    }

    return res.status(200).json({
      data: processedData,
      fetchedAt: new Date().toISOString(),
      source: 'OpenElectricity API (openelectricity.org.au)',
      dataPoints: totalMonths,
      yearsFetched: years,
      dateRange: { start: startDateStr, end: endDateStr },
      endpoint: '/v4/data/network/NEM',
      note: 'Daily interval price data aggregated by month with price event analysis'
    });
  } catch (err) {
    console.error('=== ERROR ===');
    console.error(err.stack || err);
    return res.status(500).json({
      error: 'Failed to fetch data from OpenElectricity API',
      message: err.message,
      endpoint: '/v4/data/network/NEM',
      hint: 'Ensure your API key is valid and the v4 endpoint/params are correct'
    });
  }
};
