/**
 * historical-all.js - AEMO CSV Price and Demand Data
 * 
 * Uses AEMO's lightweight price and demand CSV files
 * URL: https://www.aemo.com.au/aemo/data/nem/priceanddemand/PRICE_AND_DEMAND_YYYYMM_REGION.csv
 * 
 * Each file is ~3-5 MB (much smaller than 190 MB archives)
 * Contains: REGION, SETTLEMENTDATE, TOTALDEMAND, RRP, PERIODTYPE
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

async function fetchMonthlyAverages(dateStart, dateEnd, client) {
  console.log('[fetchMonthlyAverages] Fetching from OE');
  
  const response = await client.getMarket('NEM', ['price'], {
    interval: '1M',
    dateStart,
    dateEnd,
    primaryGrouping: 'network_region',
  });

  return response;
}

function parseMonthlyAverages(response) {
  const out = Object.fromEntries(REGIONS.map(r => [r, {}]));

  if (!response?.datatable?.rows) return out;

  const rows = response.datatable.rows;
  console.log('[parseMonthlyAverages]', rows.length, 'months');

  for (const row of rows) {
    const region = row.region;
    const timestamp = row.interval;
    const price = row.price;

    if (!region || !REGIONS.includes(region) || !timestamp || price == null) continue;

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
 * Fetch AEMO CSV for a specific month and region
 * URL format: PRICE_AND_DEMAND_YYYYMM_REGION.csv
 */
async function fetchAEMOCSV(year, month, region) {
  const yearMonth = `${year}${String(month).padStart(2, '0')}`;
  const url = `https://www.aemo.com.au/aemo/data/nem/priceanddemand/PRICE_AND_DEMAND_${yearMonth}_${region}.csv`;
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    
    const response = await fetch(url, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      signal: controller.signal,
    });
    
    clearTimeout(timeout);
    
    if (response.ok) {
      const csvText = await response.text();
      return csvText;
    }
    
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Parse AEMO CSV format
 * Columns: REGION, SETTLEMENTDATE, TOTALDEMAND, RRP, PERIODTYPE
 */
function parseAEMOCSV(csvText, region) {
  const lines = csvText.split('\n');
  const records = [];
  
  if (lines.length < 2) return records;
  
  // First line is header
  const headers = lines[0].split(',').map(h => h.trim().toUpperCase());
  
  const dateIdx = headers.indexOf('SETTLEMENTDATE');
  const priceIdx = headers.indexOf('RRP');
  const regionIdx = headers.indexOf('REGION');
  
  if (dateIdx === -1 || priceIdx === -1) {
    console.log(`[parseAEMOCSV] Missing required columns for ${region}`);
    return records;
  }
  
  // Parse data rows (skip header)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const cols = line.split(',');
    if (cols.length <= Math.max(dateIdx, priceIdx)) continue;
    
    const timestamp = cols[dateIdx].trim();
    const priceStr = cols[priceIdx].trim();
    const price = parseFloat(priceStr);
    
    if (!timestamp || isNaN(price)) continue;
    
    records.push({ timestamp, region, price });
  }
  
  return records;
}

async function fetchAEMOData(startYear, startMonth, endYear, endMonth) {
  const allRecords = [];
  
  // Generate month list
  const months = [];
  let y = startYear, m = startMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    months.push({ year: y, month: m });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  
  console.log(`[fetchAEMOData] Fetching ${months.length} months × ${REGIONS.length} regions from AEMO CSV`);
  
  let successCount = 0;
  let totalAttempts = 0;
  
  // Fetch each month for each region
  for (const { year, month } of months) {
    const monthKey = `${year}-${String(month).padStart(2, '0')}`;
    
    for (const region of REGIONS) {
      totalAttempts++;
      
      const csvText = await fetchAEMOCSV(year, month, region);
      
      if (csvText) {
        const records = parseAEMOCSV(csvText, region);
        if (records.length > 0) {
          allRecords.push(...records);
          successCount++;
        }
      }
    }
    
    console.log(`[fetchAEMOData] ${monthKey}: fetched ${successCount}/${totalAttempts} region-months so far`);
  }
  
  console.log(`[fetchAEMOData] Final: ${successCount}/${totalAttempts} region-months, ${allRecords.length} records`);
  return allRecords;
}

function aggregateAEMOMonthly(records) {
  const out = Object.fromEntries(REGIONS.map(r => [r, {}]));
  
  const buckets = {};
  REGIONS.forEach(r => buckets[r] = {});
  
  for (const { timestamp, region, price } of records) {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) continue;
    
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    
    if (!buckets[region][key]) buckets[region][key] = [];
    buckets[region][key].push(price);
  }
  
  for (const region of REGIONS) {
    for (const [monthKey, prices] of Object.entries(buckets[region])) {
      if (prices.length === 0) continue;
      
      const max = Math.max(...prices);
      const min = Math.min(...prices);
      
      const negCount = prices.filter(p => p < 0).length;
      const highPrices = prices.filter(p => p >= 300 && p < 1000);
      const extremePrices = prices.filter(p => p >= 1000);
      
      out[region][monthKey] = {
        maxPrice: Number(max.toFixed(2)),
        minPrice: Number(min.toFixed(2)),
        totalIntervals: prices.length,
        priceEvents: {
          negative: {
            count: negCount,
            avgPrice: negCount > 0 
              ? Number((prices.filter(p => p < 0).reduce((a, b) => a + b, 0) / negCount).toFixed(2))
              : 0,
          },
          high: {
            count: highPrices.length,
            avgPrice: highPrices.length
              ? Number((highPrices.reduce((a, b) => a + b, 0) / highPrices.length).toFixed(2))
              : 0,
          },
          extreme: {
            count: extremePrices.length,
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

function calculatePeriodPercentages(mergedData) {
  for (const region of REGIONS) {
    const totalIntervals = mergedData[region].reduce((sum, month) => {
      return sum + (month.totalIntervals || 0);
    }, 0);
    
    if (totalIntervals === 0) continue;
    
    for (const month of mergedData[region]) {
      if (month.priceEvents) {
        month.priceEvents.negative.percentage = 
          Number(((month.priceEvents.negative.count / totalIntervals) * 100).toFixed(4));
        
        month.priceEvents.high.percentage = 
          Number(((month.priceEvents.high.count / totalIntervals) * 100).toFixed(4));
        
        month.priceEvents.extreme.percentage = 
          Number(((month.priceEvents.extreme.count / totalIntervals) * 100).toFixed(4));
      }
      
      delete month.totalIntervals;
    }
  }
  
  return mergedData;
}

function mergeData(monthlyAvgs, aemoStats) {
  const result = {};

  for (const region of REGIONS) {
    result[region] = [];

    const avgData = monthlyAvgs[region];
    const aemoData = aemoStats[region];

    // Only include months with AEMO data
    for (const monthKey of Object.keys(aemoData)) {
      const avg = avgData[monthKey];
      const aemo = aemoData[monthKey];

      if (avg && aemo) {
        result[region].push({ ...avg, ...aemo });
      } else if (aemo) {
        result[region].push({
          ...aemo,
          averagePrice: Number(((aemo.maxPrice + aemo.minPrice) / 2).toFixed(2)),
          year: parseInt(monthKey.split('-')[0]),
          month: parseInt(monthKey.split('-')[1]),
          date: new Date(Date.UTC(parseInt(monthKey.split('-')[0]), parseInt(monthKey.split('-')[1]) - 1, 1)).toISOString(),
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

  console.log('[handler] AEMO CSV (lightweight):', { dateStart, dateEnd, years });

  try {
    const client = await getClient();
    
    const oeMonthlyResponse = await fetchMonthlyAverages(dateStart, dateEnd, client);
    const monthlyAvgs = parseMonthlyAverages(oeMonthlyResponse);
    
    const aemoRecords = await fetchAEMOData(
      startDate.getUTCFullYear(),
      startDate.getUTCMonth() + 1,
      endDate.getUTCFullYear(),
      endDate.getUTCMonth()
    );
    
    const aemoStats = aggregateAEMOMonthly(aemoRecords);
    let merged = mergeData(monthlyAvgs, aemoStats);
    merged = calculatePeriodPercentages(merged);

    const totalMonths = Object.values(merged).reduce((sum, arr) => sum + arr.length, 0);

    console.log(`[handler] Final: ${totalMonths} months with AEMO data`);

    if (totalMonths === 0) {
      return res.status(502).json({
        error: 'No AEMO data available',
        message: 'No months with AEMO data',
        dateRange: { start: dateStart, end: dateEnd },
      });
    }

    return res.status(200).json({
      success: true,
      data: merged,
      fetchedAt: new Date().toISOString(),
      source: 'AEMO Price & Demand CSV (5-minute intervals)',
      dateRange: { start: dateStart, end: dateEnd },
      years,
      aemoRecords: aemoRecords.length,
      note: 'Max prices and events from AEMO CSV data',
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
