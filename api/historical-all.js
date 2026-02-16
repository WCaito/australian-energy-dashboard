const https = require('https');

/**
 * Fetch price data from OpenElectricity API using /v4/data/network endpoint
 * This endpoint returns time series data with network_region grouping
 */
function fetchOpenElectricityData(startDate, endDate, apiKey) {
    return new Promise((resolve, reject) => {
        // Use the /v4/data/network endpoint with price metric
        const path = `/v4/data/network/NEM?metrics=price&interval=1d&primary_grouping=network_region&date_start=${startDate}&date_end=${endDate}`;
        
        const options = {
            hostname: 'api.openelectricity.org.au',
            port: 443,
            path: path,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Accept': 'application/json'
            }
        };

        console.log(`Fetching from OpenElectricity: ${startDate} to ${endDate}`);
        console.log(`URL: https://api.openelectricity.org.au${path}`);

        const req = https.request(options, (res) => {
            let data = '';

            console.log(`Response status: ${res.statusCode}`);

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    if (res.statusCode !== 200) {
                        console.error(`Error response (${res.statusCode}): ${data.substring(0, 500)}`);
                        reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                        return;
                    }

                    const jsonData = JSON.parse(data);
                    console.log(`Successfully fetched data`);
                    console.log(`Response structure:`, JSON.stringify(jsonData).substring(0, 300));
                    resolve(jsonData);
                } catch (error) {
                    console.error(`Parse error:`, error);
                    reject(error);
                }
            });
        });

        req.on('error', (error) => {
            console.error(`Request error:`, error);
            reject(error);
        });

        req.setTimeout(25000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        req.end();
    });
}

/**
 * Process OpenElectricity daily data into monthly aggregates with price event analysis
 * Updated to handle the v4/data/network response structure
 */
function processOpenElectricityResponse(apiResponse) {
    console.log('Processing OpenElectricity response...');
    
    if (!apiResponse || !apiResponse.success || !apiResponse.data) {
        console.error('Invalid API response structure');
        return {};
    }

    const regions = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'];
    const allData = {};

    // Initialize data structures
    regions.forEach(region => {
        allData[region] = {};
    });

    // The data array contains TimeSeries objects with results
    apiResponse.data.forEach(timeSeries => {
        if (timeSeries.metric !== 'price') return;
        
        // Each result represents a network_region
        timeSeries.results.forEach(result => {
            const region = result.id; // e.g., "NSW1"
            
            if (!regions.includes(region)) return;
            
            // Process history array (time series data points)
            result.history.forEach(dataPoint => {
                const date = new Date(dataPoint.interval);
                const price = dataPoint.value;

                if (price === null || price === undefined) return;

                // Group by month
                const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

                if (!allData[region][monthKey]) {
                    allData[region][monthKey] = {
                        year: date.getFullYear(),
                        month: date.getMonth() + 1,
                        date: new Date(date.getFullYear(), date.getMonth(), 1).toISOString(),
                        prices: [],
                        negativeCount: 0,
                        highCount: 0,
                        extremeCount: 0,
                        highPrices: [],
                        extremePrices: []
                    };
                }

                // Add price to array
                allData[region][monthKey].prices.push(price);

                // Count price events
                if (price < 0) {
                    allData[region][monthKey].negativeCount++;
                } else if (price >= 300 && price < 1000) {
                    allData[region][monthKey].highCount++;
                    allData[region][monthKey].highPrices.push(price);
                } else if (price >= 1000) {
                    allData[region][monthKey].extremeCount++;
                    allData[region][monthKey].extremePrices.push(price);
                }
            });
        });
    });

    // Calculate monthly statistics
    const result = {};
    regions.forEach(region => {
        result[region] = Object.values(allData[region])
            .filter(monthData => monthData.prices.length > 0)
            .map(monthData => {
                const avgPrice = monthData.prices.reduce((a, b) => a + b, 0) / monthData.prices.length;
                const maxPrice = Math.max(...monthData.prices);
                const totalIntervals = monthData.prices.length;

                const avgHighPrice = monthData.highPrices.length > 0
                    ? monthData.highPrices.reduce((a, b) => a + b, 0) / monthData.highPrices.length
                    : 0;

                const avgExtremePrice = monthData.extremePrices.length > 0
                    ? monthData.extremePrices.reduce((a, b) => a + b, 0) / monthData.extremePrices.length
                    : 0;

                return {
                    year: monthData.year,
                    month: monthData.month,
                    date: monthData.date,
                    averagePrice: parseFloat(avgPrice.toFixed(2)),
                    maxPrice: parseFloat(maxPrice.toFixed(2)),
                    priceEvents: {
                        negative: {
                            count: monthData.negativeCount,
                            percentage: ((monthData.negativeCount / totalIntervals) * 100).toFixed(2)
                        },
                        high: {
                            count: monthData.highCount,
                            percentage: ((monthData.highCount / totalIntervals) * 100).toFixed(2),
                            avgPrice: parseFloat(avgHighPrice.toFixed(2))
                        },
                        extreme: {
                            count: monthData.extremeCount,
                            percentage: ((monthData.extremeCount / totalIntervals) * 100).toFixed(2),
                            avgPrice: parseFloat(avgExtremePrice.toFixed(2))
                        }
                    }
                };
            })
            .sort((a, b) => new Date(a.date) - new Date(b.date));
    });

    console.log('Processing complete');
    console.log('Sample result:', JSON.stringify(result['NSW1']?.slice(0, 2)));
    return result;
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const API_KEY = process.env.OPENELECTRICITY_API_KEY;

    if (!API_KEY) {
        console.error('OPENELECTRICITY_API_KEY not set');
        return res.status(500).json({
            error: 'API key not configured',
            message: 'OPENELECTRICITY_API_KEY environment variable not set'
        });
    }

    try {
        const years = parseInt(req.query.years) || 4;
        
        console.log(`Request for ${years} years of data`);
        console.log(`Starting data fetch from OpenElectricity /v4/data/network endpoint...`);
        
        // Calculate date range - 4 years back from today
        const endDate = new Date();
        const startDate = new Date();
        startDate.setFullYear(endDate.getFullYear() - years);
        
        const startDateStr = startDate.toISOString().split('T')[0];
        const endDateStr = endDate.toISOString().split('T')[0];

        console.log(`Date range: ${startDateStr} to ${endDateStr}`);

        // Fetch data from OpenElectricity
        const apiResponse = await fetchOpenElectricityData(startDateStr, endDateStr, API_KEY);
        
        // Process into monthly aggregates
        const allData = processOpenElectricityResponse(apiResponse);

        // Count total data points
        const totalPoints = Object.values(allData).reduce((sum, data) => sum + data.length, 0);
        
        console.log(`Successfully processed ${totalPoints} months of data`);
        
        if (totalPoints === 0) {
            return res.status(404).json({
                error: 'No data available',
                message: 'OpenElectricity returned no data for the requested period'
            });
        }
        
        return res.status(200).json({
            data: allData,
            fetchedAt: new Date().toISOString(),
            source: 'OpenElectricity API (openelectricity.org.au)',
            dataPoints: totalPoints,
            yearsFetched: years,
            dateRange: {
                start: startDateStr,
                end: endDateStr
            },
            endpoint: '/v4/data/network/NEM',
            note: 'Daily interval data from OpenElectricity aggregated into monthly statistics with price event analysis'
        });

    } catch (error) {
        console.error('Error in historical-all:', error);
        return res.status(500).json({
            error: 'Failed to fetch data from OpenElectricity',
            message: error.message,
            hint: 'Check that your API key has access to the /v4/data/network endpoints. Endpoint used: /v4/data/network/NEM'
        });
    }
};
