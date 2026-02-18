/**
 * historical-all.js - TRUE HYBRID APPROACH
 * 1. OpenElectricity (1M interval) → Monthly average prices (fast, reliable)
 * 2. AEMO DISPATCHPRICE CSV → 5-minute prices for max and events (accurate spikes)
 * 
 * AEMO Data Source: 
 * https://nemweb.com.au/Data_Archive/Wholesale_Electricity/MMSDM/{YEAR}/MMSDM_{YEAR}_{MONTH}/
 * MMSDM_Historical_Data_SQLLoader/DATA/PUBLIC_DVD_DISPATCHPRICE_{YYYYMM}010000.zip
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

/**
 * Fetch monthly averages from OpenElectricity (1M interval)
 */
async function fetchMonthlyAverages(dateStart, dateEnd, client) {
  console.log('[fetchMonthlyAverages] Fetching 1M interval from OE');
  
  const response = await client.getMarket('NEM', ['price'], {
    interval: '1M',
    dateStart,
    dateEnd,
    primaryGrouping: 'network_region',
  });

  return response;
}

/**
 * Parse OE monthly averages into lookup object
 */
function parseMonthlyAverages(response) {
  const out = Object.fromEntries(REGIONS.map(r => [r, {}]));

  if (!response?.datatable?.rows) {
    return out;
  }

  const rows = response.datatable.rows;
  console.log('[parseMonthlyAverages]', rows.length, 'months');

  for (const row of rows) {
    const region = row.region;
    const timestamp = row.interval;
    const price = row.price;

    if (!region || !REGIONS.includes(region) || !timestamp || price == null) {
      continue;
    }

    const date = new Date(timestamp);
    if (isNaN(date.getTime())) continue;

    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    out[region][key] = {
      averagePrice: Number(price.toFixed(2)),
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      date: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString(),
    };
  }

  return out;
}

/**
 * Fetch AEMO 5-minute DISPATCHPRICE data for one month
 */
async function fetchAEMOMonth(year, month) {
  const monthStr = String(month).padStart(2, '0');
  const url = `https://nemweb.com.au/Data_Archive/Wholesale_Electricity/MMSDM/${year}/MMSDM_${year}_${monthStr}/MMSDM_Historical_Data_SQLLoader/DATA/PUBLIC_DVD_DISPATCHPRICE_${year}${monthStr}010000.zip`;
  
  console.log(`[fetchAEMOMonth] Fetching ${year}-${monthStr}`);
  
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'australian-energy-dashboard/2.0' },
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const buffer = await response.arrayBuffer();
    return buffer;
  } catch (err) {
    console.error(`[fetchAEMOMonth] Failed ${year}-${monthStr}:`, err.message);
    return null;
  }
}

/**
 * Parse AEMO CSV from ZIP buffer
 */
async function parseAEMOZip(buffer) {
  // Node.js has zlib built-in, but we need a CSV parser
  // For Vercel serverless, we'll use a simple approach
  
  try {
    // Use JSZip if available, otherwise skip
    const JSZip = await import('jszip').then(m => m.default).catch(() => null);
    
    if (!JSZip) {
      console.log('[parseAEMOZip] JSZip not available, skipping AEMO data');
      return [];
    }
    
    const zip = await JSZip.loadAsync(buffer);
    const csvFile = Object.keys(zip.files).find(name => name.endsWith('.CSV'));
    
    if (!csvFile) {
      throw new Error('No CSV file found in ZIP');
    }
    
    const csvText = await zip.files[csvFile].async('text');
    return parseAEMOCSV(csvText);
    
  } catch (err) {
    console.error('[parseAEMOZip] Error:', err.message);
    return [];
  }
}

/**
 * Parse AEMO CSV text into price records
 */
function parseAEMOCSV(csvText) {
  const lines = csvText.split('\n');
  const records = [];
  
  // AEMO CSV format: row 2 has headers, then data rows
  if (lines.length < 3) return records;
  
  const headers = lines[1].split(',');
  const dateIdx = headers.indexOf('SETTLEMENTDATE');
  const regionIdx = headers.indexOf('REGIONID');
  const priceIdx = headers.indexOf('RRP');
  
  if (dateIdx === -1 || regionIdx === -1 || priceIdx === -1) {
    console.error('[parseAEMOCSV] Missing required columns');
    return records;
  }
  
  // Parse data rows (skip first 2 header rows and last row which is often a trailer)
  for (let i = 2; i < lines.length - 1; i++) {
    const cols = lines[i].split(',');
    if (cols.length <= Math.max(dateIdx, regionIdx, priceIdx)) continue;
    
    const timestamp = cols[dateIdx].replace(/"/g, '').trim();
    const region = cols[regionIdx].replace(/"/g, '').trim();
    const price = parseFloat(cols[priceIdx]);
    
    if (!timestamp || !region || isNaN(price)) continue;
    if (!REGIONS.includes(region)) continue;
    
    records.push({ timestamp, region, price });
  }
  
  return records;
}

/**
 * Fetch and aggregate AEMO data for date range
 */
async function fetchAEMOData(startYear, startMonth, endYear, endMonth) {
  const allRecords = [];
  
  // Generate list of months to fetch
  const months = [];
  let y = startYear, m = startMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    months.push({ year: y, month: m });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  
  console.log(`[fetchAEMOData] Fetching ${months.length} months of AEMO data`);
  
  // Fetch in batches to avoid timeout (4 months at a time)
  for (let i = 0; i < Math.min(months.length, 24); i += 4) {
    const batch = months.slice(i, i + 4);
    const buffers = await Promise.all(
      batch.map(m => fetchAEMOMonth(m.year, m.month))
    );
    
    for (const buffer of buffers) {
      if (buffer) {
        const records = await parseAEMOZip(buffer);
        allRecords.push(...records);
      }
    }
  }
  
  console.log(`[fetchAEMOData] Parsed ${allRecords.length} 5-min price records`);
  return allRecords;
}

/**
 * Aggregate 5-min AEMO records into monthly stats
 */
function aggregateAEMOMonthly(records) {
  const out = Object.fromEntries(REGIONS.map(r => [r, {}]));
  
  // Group by month and region
  const buckets = {};
  REGIONS.forEach(r => buckets[r] = {});
  
  for (const { timestamp, region, price } of records) {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) continue;
    
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    
    if (!buckets[region][key]) {
      buckets[region][key] = [];
    }
    
    buckets[region][key].push(price);
  }
  
  // Calculate max and price events for each month
  for (const region of REGIONS) {
    for (const [monthKey, prices] of Object.entries(buckets[region])) {
      if (prices.length === 0) continue;
      
      const max = Math.max(...prices);
      const min = Math.min(...prices);
      
      const negCount = prices.filter(p => p < 0).length;
      const highPrices = prices.filter(p => p >= 300 && p < 1000);
      const extremePrices = prices.filter(p => p >= 1000);
      const n = prices.length;
      
      out[region][monthKey] = {
        maxPrice: Number(max.toFixed(2)),
        minPrice: Number(min.toFixed(2)),
        priceEvents: {
          negative: {
            count: negCount,
            percentage: Number(((negCount / n) * 100).toFixed(2)),
          },
          high: {
            count: highPrices.length,
            percentage: Number(((highPrices.length / n) * 100).toFixed(2)),
            avgPrice: highPrices.length
              ? Number((highPrices.reduce((a, b) => a + b, 0) / highPrices.length).toFixed(2))
              : 0,
          },
          extreme: {
            count: extremePrices.length,
            percentage: Number(((extremePrices.length / n) * 100).toFixed(2)),
            avgPrice: extremePrices.length
              ? Number((extremePrices.reduce((a, b) => a + b, 0) / extremePrices.length).toFixed(2))
              : 0,
          },
        },
      };
    }
  }
  
  return out;
}

/**
 * Merge OE monthly averages with AEMO max/events
 */
function mergeData(monthlyAvgs, aemoStats) {
  const result = {};

  for (const region of REGIONS) {
    result[region] = [];

    const avgData = monthlyAvgs[region];
    const aemoData = aemoStats[region];

    const allKeys = new Set([...Object.keys(avgData), ...Object.keys(aemoData)]);

    for (const monthKey of allKeys) {
      const avg = avgData[monthKey];
      const aemo = aemoData[monthKey];

      if (avg && aemo) {
        result[region].push({ ...avg, ...aemo });
      } else if (avg) {
        result[region].push({
          ...avg,
          maxPrice: avg.averagePrice,
          minPrice: avg.averagePrice,
          priceEvents: {
            negative: { count: 0, percentage: 0 },
            high: { count: 0, percentage: 0, avgPrice: 0 },
            extreme: { count: 0, percentage: 0, avgPrice: 0 },
          },
        });
      }
    }

    result[region].sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  return result;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(200).end();

  let years = parseInt(req.query.years, 10);
  if (!Number.isFinite(years) || years <= 0) years = 2;
  if (years > 2) years = 2;

  const now = new Date();
  const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const startDate = new Date(endDate);
  startDate.setUTCFullYear(endDate.getUTCFullYear() - years);

  const dateStart = toAESTLocal(startDate);
  const dateEnd = toAESTLocal(endDate);

  console.log('[handler] Hybrid approach: OE averages + AEMO 5-min max/events');
  console.log('[handler] Date range:', { dateStart, dateEnd, years });

  try {
    const client = await getClient();
    
    // Fetch OE monthly averages
    const oeResponse = await fetchMonthlyAverages(dateStart, dateEnd, client);
    const monthlyAvgs = parseMonthlyAverages(oeResponse);
    
    // Fetch AEMO 5-minute data
    const aemoRecords = await fetchAEMOData(
      startDate.getUTCFullYear(),
      startDate.getUTCMonth() + 1,
      endDate.getUTCFullYear(),
      endDate.getUTCMonth()
    );
    
    const aemoStats = aggregateAEMOMonthly(aemoRecords);
    const merged = mergeData(monthlyAvgs, aemoStats);

    const totalMonths = Object.values(merged).reduce((sum, arr) => sum + arr.length, 0);

    console.log('[handler] Total months:', totalMonths);

    if (totalMonths === 0) {
      return res.status(502).json({
        error: 'Empty response',
        message: 'No data available',
        dateRange: { start: dateStart, end: dateEnd },
      });
    }

    return res.status(200).json({
      success: true,
      data: merged,
      fetchedAt: new Date().toISOString(),
      source: 'Hybrid: OpenElectricity (avg) + AEMO DISPATCHPRICE (5-min max/events)',
      dateRange: { start: dateStart, end: dateEnd },
      years,
      aemoRecords: aemoRecords.length,
    });

  } catch (err) {
    console.error('[handler] Error:', err);

    if (err.type === 'MISSING_DEPENDENCY') {
      return res.status(500).json({
        error: 'Missing dependency',
        message: 'OpenElectricity SDK not installed',
      });
    }

    if (err.message && err.message.includes('OPENELECTRICITY_API_KEY')) {
      return res.status(500).json({
        error: 'Configuration error',
        message: 'OPENELECTRICITY_API_KEY not set',
      });
    }

    return res.status(500).json({
      error: 'Internal server error',
      message: err.message || String(err),
    });
  }
};
