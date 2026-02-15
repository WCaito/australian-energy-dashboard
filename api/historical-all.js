const http = require('http');
const https = require('https');

/**
 * Fetch AEMO CSV data for a specific region and month
 */
function fetchAEMOCSV(region, year, month) {
    return new Promise((resolve, reject) => {
        const yearMonth = `${year}${month.toString().padStart(2, '0')}`;
        const url = `https://www.aemo.com.au/aemo/data/nem/priceanddemand/PRICE_AND_DEMAND_${yearMonth}_${region}.csv`;
        
        console.log(`Fetching: ${url}`);

        https.get(url, (res) => {
            // Handle redirects
            if (res.statusCode === 301 || res.statusCode === 302) {
                const redirectUrl = res.headers.location;
                console.log(`Following redirect to: ${redirectUrl}`);
                
                const protocol = redirectUrl.startsWith('https') ? https : http;
                
                protocol.get(redirectUrl, (redirectRes) => {
                    let data = '';
                    
                    if (redirectRes.statusCode !== 200) {
                        console.log(`HTTP ${redirectRes.statusCode} after redirect for ${region} ${yearMonth}`);
                        reject(new Error(`HTTP ${redirectRes.statusCode}`));
                        return;
                    }
                    
                    redirectRes.on('data', (chunk) => { data += chunk; });
                    redirectRes.on('end', () => {
                        try {
                            const stats = parseCSVAndCalculateStats(data);
                            if (stats === null) {
                                reject(new Error('No valid price data'));
                                return;
                            }
                            console.log(`✓ ${region} ${yearMonth}: Avg $${stats.average.toFixed(2)}, Max $${stats.max.toFixed(2)}/MWh`);
                            resolve(stats);
                        } catch (error) {
                            reject(error);
                        }
                    });
                }).on('error', reject);
                return;
            }

            if (res.statusCode !== 200) {
                console.log(`HTTP ${res.statusCode} for ${region} ${yearMonth}`);
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }

            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const stats = parseCSVAndCalculateStats(data);
                    if (stats === null) {
                        reject(new Error('No valid price data'));
                        return;
                    }
                    console.log(`✓ ${region} ${yearMonth}: Avg $${stats.average.toFixed(2)}, Max $${stats.max.toFixed(2)}/MWh`);
                    resolve(stats);
                } catch (error) {
                    reject(error);
                }
            });
        }).on('error', (error) => {
            console.log(`Error fetching ${region} ${yearMonth}: ${error.message}`);
            reject(error);
        });
    });
}

/**
 * Parse AEMO CSV and calculate price statistics
 * Returns: { average, max, priceEvents: { negative, high, extreme } }
 */
function parseCSVAndCalculateStats(csvText) {
    const lines = csvText.split('\n');
    const prices = [];
    
    // AEMO CSV format:
    // Line 1: Header metadata
    // Line 2: Column headers (REGION,SETTLEMENTDATE,TOTALDEMAND,RRP,PERIODTYPE)
    // Line 3+: Data rows
    
    for (let i = 2; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        const columns = line.split(',');
        
        // RRP is in the 4th column (index 3)
        const rrp = parseFloat(columns[3]);
        
        // Allow negative prices but sanity check extremes
        if (!isNaN(rrp) && rrp >= -1000 && rrp < 100000) {
            prices.push(rrp);
        }
    }
    
    if (prices.length === 0) {
        return null;
    }
    
    // Calculate statistics
    const average = prices.reduce((a, b) => a + b, 0) / prices.length;
    const max = Math.max(...prices);
    
    // Count price events
    const negativeCount = prices.filter(p => p < 0).length;
    const highCount = prices.filter(p => p >= 300 && p < 1000).length;
    const extremeCount = prices.filter(p => p >= 1000).length;
    
    const totalIntervals = prices.length;
    
    return {
        average,
        max,
        priceEvents: {
            negative: {
                count: negativeCount,
                percentage: ((negativeCount / totalIntervals) * 100).toFixed(2)
            },
            high: {
                count: highCount,
                percentage: ((highCount / totalIntervals) * 100).toFixed(2)
            },
            extreme: {
                count: extremeCount,
                percentage: ((extremeCount / totalIntervals) * 100).toFixed(2)
            }
        }
    };
}

/**
 * Fetch historical data for all regions
 */
async function fetchAllRegionsData(years) {
    const regions = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'];
    const allData = {};
    
    // Initialize data structure
    regions.forEach(region => {
        allData[region] = [];
    });
    
    const now = new Date();
    const monthsToFetch = Math.ceil(years * 12);
    
    console.log(`Fetching ${monthsToFetch} months of data for ${regions.length} regions`);
    
    // Fetch data for each month, going backwards from now
    for (let i = 1; i <= monthsToFetch; i++) {
        const targetDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const year = targetDate.getFullYear();
        const month = targetDate.getMonth() + 1;
        
        // Don't try to fetch future data
        if (targetDate > now) continue;
        
        // Fetch data for all regions for this month in parallel
        const monthPromises = regions.map(async (region) => {
            try {
                const stats = await fetchAEMOCSV(region, year, month);
                
                return {
                    region,
                    data: {
                        year: year,
                        month: month,
                        date: targetDate.toISOString(),
                        averagePrice: parseFloat(stats.average.toFixed(2)),
                        maxPrice: parseFloat(stats.max.toFixed(2)),
                        priceEvents: stats.priceEvents
                    }
                };
            } catch (error) {
                console.log(`Skipping ${region} ${year}-${month}: ${error.message}`);
                return { region, data: null };
            }
        });
        
        // Wait for all regions for this month
        const monthResults = await Promise.all(monthPromises);
        
        // Add successful results to allData
        monthResults.forEach(result => {
            if (result.data) {
                allData[result.region].push(result.data);
            }
        });
        
        // Small delay between months
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    // Sort each region's data by date
    regions.forEach(region => {
        allData[region].sort((a, b) => new Date(a.date) - new Date(b.date));
    });
    
    return allData;
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const years = parseInt(req.query.years) || 4;
        
        // Fetch only 6 months to stay within Vercel's 30-second timeout
        const monthsToFetch = 6;
        
        console.log(`Request for ${years} years, fetching ${monthsToFetch} months (Vercel timeout limit)`);
        console.log(`Starting data fetch from AEMO...`);
        
        const allData = await fetchAllRegionsData(monthsToFetch / 12);
        
        // Count total data points
        const totalPoints = Object.values(allData).reduce((sum, data) => sum + data.length, 0);
        
        console.log(`Successfully fetched ${totalPoints} total data points`);
        
        if (totalPoints === 0) {
            return res.status(404).json({
                error: 'No data available',
                message: 'Could not fetch any data from AEMO. The servers may be temporarily unavailable.'
            });
        }
        
        return res.status(200).json({
            data: allData,
            fetchedAt: new Date().toISOString(),
            source: 'AEMO (Australian Energy Market Operator)',
            dataPoints: totalPoints,
            monthsFetched: monthsToFetch,
            note: 'Limited to 6 months due to Vercel serverless timeout (30s). Each data point includes 5-minute settlement price events.'
        });

    } catch (error) {
        console.error('Error in historical-all:', error);
        return res.status(500).json({
            error: 'Failed to fetch data',
            message: error.message,
            source: 'AEMO CSV files'
        });
    }
};
