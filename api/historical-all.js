const http = require('http');

/**
 * Fetch AEMO CSV data for a specific region and month
 */
function fetchAEMOCSV(region, year, month) {
    return new Promise((resolve, reject) => {
        const yearMonth = `${year}${month.toString().padStart(2, '0')}`;
        const url = `http://www.aemo.com.au/aemo/data/nem/priceanddemand/PRICE_AND_DEMAND_${yearMonth}_${region}.csv`;
        
        console.log(`Fetching: ${url}`);

        http.get(url, (res) => {
            let data = '';

            if (res.statusCode !== 200) {
                console.log(`HTTP ${res.statusCode} for ${region} ${yearMonth}`);
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const average = parseCSVAndCalculateAverage(data);
                    if (average === null) {
                        reject(new Error('No valid price data'));
                        return;
                    }
                    console.log(`✓ ${region} ${yearMonth}: $${average.toFixed(2)}/MWh`);
                    resolve(average);
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
 * Parse AEMO CSV and calculate average RRP (Regional Reference Price)
 */
function parseCSVAndCalculateAverage(csvText) {
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
        
        if (!isNaN(rrp) && rrp >= 0 && rrp < 100000) { // Sanity check
            prices.push(rrp);
        }
    }
    
    if (prices.length === 0) {
        return null;
    }
    
    // Calculate average
    const average = prices.reduce((a, b) => a + b, 0) / prices.length;
    return average;
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
    const monthsToFetch = Math.min(years * 12, 24); // Limit to 2 years max to avoid too many requests
    
    console.log(`Fetching ${monthsToFetch} months of data for ${regions.length} regions`);
    
    // Fetch data for each month, going backwards from now
    for (let i = 1; i <= monthsToFetch; i++) {
        const targetDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const year = targetDate.getFullYear();
        const month = targetDate.getMonth() + 1;
        
        // Don't try to fetch future data
        if (targetDate > now) continue;
        
        // Fetch data for all regions for this month
        for (const region of regions) {
            try {
                const average = await fetchAEMOCSV(region, year, month);
                
                allData[region].push({
                    year: year,
                    month: month,
                    date: targetDate.toISOString(),
                    averagePrice: parseFloat(average.toFixed(2))
                });
                
                // Small delay to avoid overwhelming AEMO servers
                await new Promise(resolve => setTimeout(resolve, 100));
                
            } catch (error) {
                // Log but continue - some months might not have data
                console.log(`Skipping ${region} ${year}-${month}: ${error.message}`);
            }
        }
    }
    
    // Sort each region's data by date
    regions.forEach(region => {
        allData[region].sort((a, b) => new Date(a.date) - new Date(b.date));
    });
    
    return allData;
}

module.exports = async (req, res) => {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const years = parseInt(req.query.years) || 4;
        
        // Limit to 2 years to keep function execution time reasonable
        const yearsToFetch = Math.min(years, 2);
        
        console.log(`Request for ${years} years, fetching ${yearsToFetch} years`);
        console.log(`Starting data fetch from AEMO...`);
        
        const allData = await fetchAllRegionsData(yearsToFetch);
        
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
            yearsRequested: years,
            yearsFetched: yearsToFetch
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
