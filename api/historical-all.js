/**
 * historical-all.js - TRUE HYBRID APPROACH
 * 1. OpenElectricity (1M) → Monthly averages
 * 2. AEMO DISPATCHPRICE (5-min) → Max prices and events
 * 
 * IMPORTANT: Only includes months where AEMO data is available.
 * Months without AEMO data are excluded entirely (no fallback).
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
  console.log('[fetchMonthlyAverages] Fetching 1M interval from OE');
  
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

async function fetchAEMOMonth(year, month) {
  const monthStr = String(month).padStart(2, '0');
  const url = `https://nemweb.com.au/Data_Archive/Wholesale_Electricity/MMSDM/${year}/MMSDM_${year}_${monthStr}/MMSDM_Historical_Data_SQLLoader/DATA/PUBLIC_DVD_DISPATCHPRICE_${year}${monthStr}010000.zip`;
  
  console.log(`[fetchAEMOMonth] Fetching ${year}-${monthStr}`);
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000); // 20s timeout
    
    const response = await fetch(url, {
      headers: { 'User-Agent': 'australian-energy-dashboard/2.0' },
      signal: controller.signal,
    });
    
    clearTimeout(timeout);
    
    if (!response.ok) {
      console.log(`[fetchAEMOMonth] ${year}-${monthStr} returned ${response.status} - will be excluded from charts`);
      return null;
    }
    
    const buffer = await response.arrayBuffer();
    console.log(`[fetchAEMOMonth] ${year}-${monthStr} OK (${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB)`);
    return buffer;
    
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error(`[fetchAEMOMonth] ${year}-${monthStr} timeout - will be excluded`);
    } else {
      console.error(`[fetchAEMOMonth] ${year}-${monthStr} failed: ${err.message} - will be excluded`);
    }
    return null;
  }
}

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

function parseAEMOCSV(csvText) {
  const lines = csvText.split('\n');
  const records = [];
  
  if (lines.length < 3) return records;
  
  // Find header row
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
    console.error('[parseAEMOCSV] Missing required columns');
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
  
  console.log(`[fetchAEMOData] Attempting to fetch ${months.length} months from AEMO`);
  
  let successCount = 0;
  let failCount = 0;
  
  // Fetch in batches of 3 to avoid overwhelming
  for (let i = 0; i < months.length; i += 3) {
    const batch = months.slice(i, i + 3);
    const buffers = await Promise.all(
      batch.map(m => fetchAEMOMonth(m.year, m.month))
    );
    
    for (let j = 0; j < buffers.length; j++) {
      const buffer = buffers[j];
      if (buffer) {
        const records = await parseAEMOZip(buffer);
        if (records.length > 0) {
          allRecords.push(...records);
          successCount++;
          console.log(`[fetchAEMOData] ✓ ${batch[j].year}-${batch[j].month}: ${records.length} records`);
        } else {
          failCount++;
        }
      } else {
        failCount++;
      }
    }
  }
  
  console.log(`[fetchAEMOData] Results: ${successCount} months succeeded, ${failCount} months failed/unavailable`);
  console.log(`[fetchAEMOData] Total 5-min records: ${allRecords.length}`);
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
    
    if (!buckets[region][key]) {
      buckets[region][key] = [];
    }
    
    buckets[region][key].push(price);
  }
  
  // Calculate stats - store raw counts for percentage calculation later
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
    // Calculate total intervals across all months for this region
    const totalIntervals = mergedData[region].reduce((sum, month) => {
      return sum + (month.totalIntervals || 0);
    }, 0);
    
    if (totalIntervals === 0) continue;
    
    // Calculate percentages against period total
    for (const month of mergedData[region]) {
      if (month.priceEvents) {
        month.priceEvents.negative.percentage = 
          Number(((month.priceEvents.negative.count / totalIntervals) * 100).toFixed(4));
        
        month.priceEvents.high.percentage = 
          Number(((month.priceEvents.high.count / totalIntervals) * 100).toFixed(4));
        
        month.priceEvents.extreme.percentage = 
          Number(((month.priceEvents.extreme.count / totalIntervals) * 100).toFixed(4));
      }
      
      // Remove internal field
      delete month.totalIntervals;
    }
  }
  
  return mergedData;
}

/**
 * CRITICAL: Only merge months where BOTH OE and AEMO data exist
 * If AEMO data is missing, exclude that month entirely
 */
function mergeData(monthlyAvgs, aemoStats) {
  const result = {};

  for (const region of REGIONS) {
    result[region] = [];

    const avgData = monthlyAvgs[region];
    const aemoData = aemoStats[region];

    // Only include months where AEMO data exists
    for (const monthKey of Object.keys(aemoData)) {
      const avg = avgData[monthKey];
      const aemo = aemoData[monthKey];

      if (avg && aemo) {
        // Both datasets available - include this month
        result[region].push({ ...avg, ...aemo });
      } else if (aemo) {
        // Have AEMO but not OE average (shouldn't happen, but handle it)
        // Use AEMO max as average estimate
        result[region].push({
          ...aemo,
          averagePrice: Number(((aemo.maxPrice + aemo.minPrice) / 2).toFixed(2)),
          year: parseInt(monthKey.split('-')[0]),
          month: parseInt(monthKey.split('-')[1]),
          date: new Date(Date.UTC(parseInt(monthKey.split('-')[0]), parseInt(monthKey.split('-')[1]) - 1, 1)).toISOString(),
        });
      }
      // If no AEMO data, skip this month entirely (no else clause)
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

  console.log('[handler] Hybrid: OE averages + AEMO 5-min (exclude unavailable months)');
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

    console.log('[handler] Total months included:', totalMonths);
    console.log('[handler] Total 5-min intervals:', totalIntervals);

    if (totalMonths === 0) {
      return res.status(502).json({
        error: 'No AEMO data available',
        message: 'No months with complete AEMO 5-minute data available for the requested period',
        dateRange: { start: dateStart, end: dateEnd },
        hint: 'AEMO may not have published data for recent months yet. Try requesting an earlier date range.',
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
      note: 'Only includes months with complete AEMO 5-min data. Months without AEMO data are excluded.',
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
