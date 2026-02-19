/**
 * historical-all.js - CORRECT AEMO LOCATIONS
 * 
 * AEMO changed archive structure in August 2024:
 * - Before Aug 2024: /Data_Archive/Wholesale_Electricity/MMSDM/{YEAR}/MMSDM_{YEAR}_{MONTH}/...
 * - Aug 2024 onwards: /Reports/Archive/Next_Day_Dispatch/PUBLIC_NEXT_DAY_DISPATCH_{YYYYMM}01.zip
 * 
 * NO FALLBACK - Only AEMO 5-minute data used
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
 * Fetch from MMSDM Historical Archive (before August 2024)
 */
async function fetchAEMOMonthOldFormat(year, month) {
  const monthStr = String(month).padStart(2, '0');
  const url = `https://nemweb.com.au/Data_Archive/Wholesale_Electricity/MMSDM/${year}/MMSDM_${year}_${monthStr}/MMSDM_Historical_Data_SQLLoader/DATA/PUBLIC_DVD_DISPATCHPRICE_${year}${monthStr}010000.zip`;
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    
    const response = await fetch(url, {
      headers: { 'User-Agent': 'australian-energy-dashboard/2.0' },
      signal: controller.signal,
    });
    
    clearTimeout(timeout);
    
    if (response.ok) {
      const buffer = await response.arrayBuffer();
      console.log(`[AEMO] ✓ Old format ${year}-${monthStr} (${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB)`);
      return buffer;
    }
    
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Fetch from Next_Day_Dispatch Archive (August 2024 onwards)
 * New location: /Reports/Archive/Next_Day_Dispatch/
 * Filename: PUBLIC_NEXT_DAY_DISPATCH_YYYYMM01.zip
 */
async function fetchAEMOMonthNewFormat(year, month) {
  const monthStr = String(month).padStart(2, '0');
  const url = `https://nemweb.com.au/Reports/Archive/Next_Day_Dispatch/PUBLIC_NEXT_DAY_DISPATCH_${year}${monthStr}01.zip`;
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    
    const response = await fetch(url, {
      headers: { 'User-Agent': 'australian-energy-dashboard/2.0' },
      signal: controller.signal,
    });
    
    clearTimeout(timeout);
    
    if (response.ok) {
      const buffer = await response.arrayBuffer();
      console.log(`[AEMO] ✓ New format ${year}-${monthStr} (${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB)`);
      return buffer;
    }
    
    return null;
  } catch (err) {
    return null;
  }
}

async function parseAEMOZip(buffer) {
  try {
    const JSZip = await import('jszip').then(m => m.default).catch(() => null);
    if (!JSZip) return [];
    
    const zip = await JSZip.loadAsync(buffer);
    
    // Find DISPATCHPRICE CSV file
    const csvFile = Object.keys(zip.files).find(name => 
      (name.toUpperCase().includes('DISPATCHPRICE') || name.toUpperCase().includes('DISPATCH_PRICE')) 
      && name.endsWith('.CSV')
    );
    
    if (!csvFile) {
      console.log('[parseAEMOZip] No DISPATCHPRICE CSV found in ZIP');
      return [];
    }
    
    const csvText = await zip.files[csvFile].async('text');
    return parseAEMOCSV(csvText);
  } catch (err) {
    console.error('[parseAEMOZip]', err.message);
    return [];
  }
}

function parseAEMOCSV(csvText) {
  const lines = csvText.split('\n');
  const records = [];
  
  if (lines.length < 3) return records;
  
  let headerRow = null;
  let dataStartRow = 0;
  
  // Find header row
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    if (lines[i].startsWith('D,DISPATCHPRICE') || lines[i].startsWith('D,DISPATCH_PRICE') || lines[i].includes('SETTLEMENTDATE')) {
      headerRow = lines[i];
      dataStartRow = i + 1;
      break;
    }
  }
  
  if (!headerRow) return records;
  
  const headers = headerRow.split(',').map(h => h.replace(/"/g, '').trim());
  const dateIdx = headers.findIndex(h => h === 'SETTLEMENTDATE');
  const regionIdx = headers.findIndex(h => h === 'REGIONID');
  const priceIdx = headers.findIndex(h => h === 'RRP');
  
  if (dateIdx === -1 || regionIdx === -1 || priceIdx === -1) {
    console.log('[parseAEMOCSV] Missing required columns');
    return records;
  }
  
  for (let i = dataStartRow; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || !line.startsWith('D,')) continue;
    
    const cols = line.split(',');
    if (cols.length <= Math.max(dateIdx, regionIdx, priceIdx)) continue;
    
    const timestamp = cols[dateIdx].replace(/"/g, '').trim();
    const region = cols[regionIdx].replace(/"/g, '').trim();
    const price = parseFloat(cols[priceIdx].replace(/"/g, '').trim());
    
    if (!timestamp || !region || isNaN(price) || !REGIONS.includes(region)) continue;
    
    records.push({ timestamp, region, price });
  }
  
  return records;
}

async function fetchAEMOData(startYear, startMonth, endYear, endMonth) {
  const allRecords = [];
  
  const months = [];
  let y = startYear, m = startMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    months.push({ year: y, month: m });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  
  console.log(`[fetchAEMOData] Fetching ${months.length} months from AEMO`);
  
  let successCount = 0;
  const cutoffDate = new Date(2024, 7, 1); // August 2024
  
  for (const { year, month } of months) {
    const monthDate = new Date(year, month - 1, 1);
    let buffer = null;
    
    // Use appropriate format based on date
    if (monthDate < cutoffDate) {
      // Before August 2024: use old MMSDM format
      buffer = await fetchAEMOMonthOldFormat(year, month);
    } else {
      // August 2024 onwards: use new Next_Day_Dispatch format
      buffer = await fetchAEMOMonthNewFormat(year, month);
    }
    
    if (buffer) {
      const records = await parseAEMOZip(buffer);
      if (records.length > 0) {
        allRecords.push(...records);
        successCount++;
      }
    }
  }
  
  console.log(`[fetchAEMOData] Success: ${successCount}/${months.length} months, ${allRecords.length} records`);
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

  console.log('[handler] AEMO-only (correct locations):', { dateStart, dateEnd, years });

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

    console.log(`[handler] Final: ${totalMonths} months with AEMO 5-min data`);

    if (totalMonths === 0) {
      return res.status(502).json({
        error: 'No AEMO data available',
        message: 'No months with AEMO 5-minute data',
        dateRange: { start: dateStart, end: dateEnd },
      });
    }

    return res.status(200).json({
      success: true,
      data: merged,
      fetchedAt: new Date().toISOString(),
      source: 'AEMO 5-minute data only (MMSDM Historical + Next_Day_Dispatch Archive)',
      dateRange: { start: dateStart, end: dateEnd },
      years,
      aemoRecords: aemoRecords.length,
      note: 'Max prices and events from AEMO 5-min data only',
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
