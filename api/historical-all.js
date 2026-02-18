/**
 * historical-all.js - TRUE HYBRID APPROACH (FIXED)
 * 1. OpenElectricity (1M) → Monthly averages
 * 2. AEMO DISPATCHPRICE (5-min) → Max prices and events
 * 
 * FIXES:
 * - Better AEMO data availability handling (recent months may not be published yet)
 * - Price event percentages now calculated across ENTIRE period, not per month
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
 * Fetch monthly averages from OpenElectricity
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
 * Parse OE monthly averages
 */
function parseMonthlyAverages(response) {
  const out = Object.fromEntries(REGIONS.map(r => [r, {}]));

  if (!response?.datatable?.rows) {
    return out;
  }

  const rows = response.datatable.rows;
  console.log('[parseMonthlyAverages]', rows.length, 'months from OE');

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
 * Fetch AEMO DISPATCHPRICE for one month
 * NOTE: Recent months (last 1-2 months) may not be published yet
 */
async function fetchAEMOMonth(year, month) {
  const monthStr = String(month).padStart(2, '0');
  const url = `https://nemweb.com.au/Data_Archive/Wholesale_Electricity/MMSDM/${year}/MMSDM_${year}_${monthStr}/MMSDM_Historical_Data_SQLLoader/DATA/PUBLIC_DVD_DISPATCHPRICE_${year}${monthStr}010000.zip`;
  
  console.log(`[fetchAEMOMonth] Fetching ${year}-${monthStr}`);
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15s per file
    
    const response = await fetch(url, {
      headers: { 'User-Agent': 'australian-energy-dashboard/2.0' },
      signal: controller.signal,
    });
    
    clearTimeout(timeout);
    
    if (!response.ok) {
      console.log(`[fetchAEMOMonth] ${year}-${monthStr} returned ${response.status} (may not be published yet)`);
      return null;
    }
    
    const buffer = await response.arrayBuffer();
    console.log(`[fetchAEMOMonth] ${year}-${monthStr} downloaded (${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB)`);
    return buffer;
    
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error(`[fetchAEMOMonth] ${year}-${monthStr} timeout`);
    } else {
      console.error(`[fetchAEMOMonth] ${year}-${monthStr} failed:`, err.message);
    }
    return null;
  }
}

/**
 * Parse AEMO ZIP file
 */
async function parseAEMOZip(buffer) {
  try {
    const JSZip = await import('jszip').then(m => m.default).catch(() => null);
    
    if (!JSZip) {
      console.log('[parseAEMOZip] JSZip not available');
      return [];
    }
    
    const zip = await JSZip.loadAsync(buffer);
    const csvFile = Object.keys(zip.files).find(name => 
      name.toUpperCase().includes('DISPATCHPRICE') && name.endsWith('.CSV')
    );
    
    if (!csvFile) {
      console.error('[parseAEMOZip] No DISPATCHPRICE CSV found');
      return [];
    }
    
    const csvText = await zip.files[csvFile].async('text');
    return parseAEMOCSV(csvText);
    
  } catch (err) {
    console.error('[parseAEMOZip] Error:', err.message);
    return [];
  }
}

/**
 * Parse AEMO CSV
 */
function parseAEMOCSV(csvText) {
  const lines = csvText.split('\n');
  const records = [];
  
  if (lines.length < 3) return records;
  
  // Find header row (starts with "D," for data)
  let headerRow = null;
  let dataStartRow = 0;
  
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    if (lines[i].startsWith('D,DISPATCHPRICE') || lines[i].includes('SETTLEMENTDATE')) {
      headerRow = lines[i];
      dataStartRow = i + 1;
      break;
    }
  }
  
  if (!headerRow) {
    console.error('[parseAEMOCSV] No header row found');
    return records;
  }
  
  const headers = headerRow.split(',').map(h => h.replace(/"/g, '').trim());
  const dateIdx = headers.findIndex(h => h === 'SETTLEMENTDATE');
  const regionIdx = headers.findIndex(h => h === 'REGIONID');
  const priceIdx = headers.findIndex(h => h === 'RRP');
  
  if (dateIdx === -1 || regionIdx === -1 || priceIdx === -1) {
    console.error('[parseAEMOCSV] Missing columns. Headers:', headers.slice(0, 10));
    return records;
  }
  
  // Parse data rows
  for (let i = dataStartRow; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || !line.startsWith('D,')) continue;
    
    const cols = line.split(',');
    if (cols.length <= Math.max(dateIdx, regionIdx, priceIdx)) continue;
    
    const timestamp = cols[dateIdx].replace(/"/g, '').trim();
    const region = cols[regionIdx].replace(/"/g, '').trim();
    const priceStr = cols[priceIdx].replace(/"/g, '').trim();
    const price = parseFloat(priceStr);
    
    if (!timestamp || !region || isNaN(price)) continue;
    if (!REGIONS.includes(region)) continue;
    
    records.push({ timestamp, region, price });
  }
  
  return records;
}

/**
 * Fetch AEMO data for date range
 */
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
  
  console.log(`[fetchAEMOData] Fetching ${months.length} months from AEMO`);
  
  // Fetch in batches of 4 to avoid timeout
  for (let i = 0; i < months.length; i += 4) {
    const batch = months.slice(i, i + 4);
    const buffers = await Promise.all(
      batch.map(m => fetchAEMOMonth(m.year, m.month))
    );
    
    for (let j = 0; j < buffers.length; j++) {
      const buffer = buffers[j];
      if (buffer) {
        const records = await parseAEMOZip(buffer);
        if (records.length > 0) {
          allRecords.push(...records);
          console.log(`[fetchAEMOData] Parsed ${records.length} records from ${batch[j].year}-${batch[j].month}`);
        }
      }
    }
  }
  
  console.log(`[fetchAEMOData] Total 5-min records: ${allRecords.length}`);
  return allRecords;
}

/**
 * Aggregate AEMO records into monthly stats
 * NOTE: Stores raw counts, percentages calculated later across entire period
 */
function aggregateAEMOMonthly(records) {
  const out = Object.fromEntries(REGIONS.map(r => [r, {}]));
  
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
  
  // Calculate max/min and RAW COUNTS (percentages calculated later)
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

/**
 * Calculate percentage across ENTIRE PERIOD (not per month)
 */
function calculatePeriodPercentages(mergedData) {
  for (const region of REGIONS) {
    // Calculate total intervals across all months
    const totalIntervals = mergedData[region].reduce((sum, month) => {
      return sum + (month.totalIntervals || 0);
    }, 0);
    
    if (totalIntervals === 0) continue;
    
    // Update each month's percentages based on period total
    for (const month of mergedData[region]) {
      if (month.priceEvents) {
        month.priceEvents.negative.percentage = 
          Number(((month.priceEvents.negative.count / totalIntervals) * 100).toFixed(4));
        
        month.priceEvents.high.percentage = 
          Number(((month.priceEvents.high.count / totalIntervals) * 100).toFixed(4));
        
        month.priceEvents.extreme.percentage = 
          Number(((month.priceEvents.extreme.count / totalIntervals) * 100).toFixed(4));
      }
      
      // Remove totalIntervals from final output (internal use only)
      delete month.totalIntervals;
    }
  }
  
  return mergedData;
}

/**
 * Merge OE averages with AEMO max/events
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
        // Both datasets available
        result[region].push({ ...avg, ...aemo });
      } else if (avg) {
        // Only OE average available (AEMO data not published yet)
        result[region].push({
          ...avg,
          maxPrice: avg.averagePrice,
          minPrice: avg.averagePrice,
          totalIntervals: 0,
          priceEvents: {
            negative: { count: 0, avgPrice: 0 },
            high: { count: 0, avgPrice: 0 },
            extreme: { count: 0, avgPrice: 0 },
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

  console.log('[handler] Hybrid: OE averages + AEMO 5-min');
  console.log('[handler] Date range:', { dateStart, dateEnd, years });

  try {
    const client = await getClient();
    
    // Fetch OE monthly averages
    const oeResponse = await fetchMonthlyAverages(dateStart, dateEnd, client);
    const monthlyAvgs = parseMonthlyAverages(oeResponse);
    
    // Fetch AEMO 5-min data
    const aemoRecords = await fetchAEMOData(
      startDate.getUTCFullYear(),
      startDate.getUTCMonth() + 1,
      endDate.getUTCFullYear(),
      endDate.getUTCMonth()
    );
    
    const aemoStats = aggregateAEMOMonthly(aemoRecords);
    let merged = mergeData(monthlyAvgs, aemoStats);
    
    // Calculate percentages across entire period
    merged = calculatePeriodPercentages(merged);

    const totalMonths = Object.values(merged).reduce((sum, arr) => sum + arr.length, 0);
    const totalIntervals = aemoRecords.length;

    console.log('[handler] Total months:', totalMonths);
    console.log('[handler] Total 5-min intervals:', totalIntervals);

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
      aemoRecords: totalIntervals,
      note: 'Price event percentages calculated across entire period (all 5-min intervals)',
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
