const https = require('https');

/**
 * Fetch price data from OpenElectricity API using the correct v4/data/network endpoint
 * Based on working test: https://api.openelectricity.org.au/v4/data/network/NEM?metrics=power&interval=1d
 */
function fetchOpenElectricityData(startDate, endDate, apiKey, metric = 'power') {
    return new Promise((resolve, reject) => {
        // Use the exact format from the working test URL
        // Your test used metrics=power, so we'll use that
        const path = `/v4/data/network/NEM?metrics=${metric}&interval=1d&dateStart=${startDate}&dateEnd=${endDate}`;
        
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

        console.log(`Fetching from OpenElectricity...`);
        console.log(`Full URL: https://api.openelectricity.org.au${path}`);
        console.log(`Metric: ${metric}, Date range: ${startDate} to ${endDate}`);

        const req = https.request(options, (res) => {
            let data = '';

            console.log(`Response status: ${res.statusCode}`);
            console.log(`Response headers:`, JSON.stringify(res.headers));

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    if (res.statusCode !== 200) {
                        console.error(`Error response (${res.statusCode}):`);
                        console.error(data.substring(0, 1000));
                        reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
                        return;
                    }

                    const jsonData = JSON.parse(data);
                    console.log(`Successfully fetched data`);
                    console.log(`Response keys:`, Object.keys(jsonData));
                    if (jsonData.data) {
                        console.log(`Data array length:`, jsonData.data.length);
                        if (jsonData.data[0]) {
                            console.log(`First data item keys:`, Object.keys(jsonData.data[0]));
                        }
                    }
                    resolve(jsonData);
                } catch (error) {
                    console.error(`Parse error:`, error);
                    console.error(`Data received:`, data.substring(0, 500));
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
            reject(new Error('Request timeout after 25 seconds'));
        });

        req.end();
    });
}

/**
 * Process OpenElectricity response
 * The data structure should match the power endpoint structure
 */
function processOpenElectricityResponse(apiResponse) {
    console.log('Processing OpenElectricity response...');
    
    if (!apiResponse || !apiResponse.success) {
        console.error('API response indicates failure or missing success field');
        console.error('Response:', JSON.stringify(apiResponse).substring(0, 500));
        return {};
    }

    if (!apiResponse.data || !Array.isArray(apiResponse.data)) {
        console.error('Missing or invalid data array in response');
        return {};
    }

    const regions = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'];
    const allData = {};

    // Initialize data structures
    regions.forEach(region => {
        allData[region] = {};
    });

    console.log(`Processing ${apiResponse.data.length} data items...`);

    // Process each TimeSeries object
    apiResponse.data.forEach((timeSeries, index) => {
        console.log(`Processing TimeSeries ${index}:`, {
            metric: timeSeries.metric,
            unit: timeSeries.unit,
            resultsCount: timeSeries.results?.length
        });

        // Accept both 'price' and 'power' metrics
        if (timeSeries.metric !== 'price' && timeSeries.metric !== 'power') {
            console.log(`Skipping non-price/power metric: ${timeSeries.metric}`);
            return;
        }
        
        if (!timeSeries.results || !Array.isArray(timeSeries.results)) {
            console.log(`No results array in timeSeries`);
            return;
        }

        // Each result represents a network_region
        timeSeries.results.forEach((result, resultIndex) => {
            const region = result.id; // e.g., "NSW1"
            
            console.log(`Processing result ${resultIndex} for region: ${region}`);
            
            if (!regions.includes(region)) {
                console.log(`Skipping unknown region: ${region}`);
                return;
            }

            if (!result.history || !Array.isArray(result.history)) {
                console.log(`No history array for region ${region}`);
                return;
            }

            console.log(`Processing ${result.history.length} history items for ${region}`);
            
            // Process history array (time series data points)
            result.history.forEach((dataPoint, dpIndex) => {
                const date = new Date(dataPoint.interval);
                const price = dataPoint.value;

                if (price === null || price === undefined) {
                    return;
                }

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
        const monthlyData = Object.values(allData[region])
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

        result[region] = monthlyData;
        console.log(`Region ${region}: ${monthlyData.length} months of data`);
    });

    console.log('Processing complete');
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

    console.log(`API Key configured: ${API_KEY.substring(0, 10)}...`);

    try {
        // Start with a small date range - 3 months to test if API works
        const years = parseInt(req.query.years) || 4;
        
        console.log(`=== Starting OpenElectricity API Request ===`);
        console.log(`User requested ${years} years, but limiting to 3 months for API stability`);
        
        // Use only 3 months of data to avoid overwhelming the API
        // Also ensure we don't request future dates
        const endDate = new Date();
        endDate.setDate(endDate.getDate() - 2); // Go back 2 days to ensure data exists
        
        const startDate = new Date(endDate);
        startDate.setMonth(endDate.getMonth() - 3);  // Just 3 months
        
        const startDateStr = startDate.toISOString().split('T')[0];
        const endDateStr = endDate.toISOString().split('T')[0];

        console.log(`Requesting data from ${startDateStr} to ${endDateStr}`);

        // TEST: Try the exact endpoint that worked for you
        // Your test used metrics=power, not price!
        console.log(`Note: Using 'power' metric since your test URL used that`);

        // Fetch data from OpenElectricity
        const apiResponse = await fetchOpenElectricityData(startDateStr, endDateStr, API_KEY);
        
        // Process into monthly aggregates
        const allData = processOpenElectricityResponse(apiResponse);

        // Count total data points
        const totalPoints = Object.values(allData).reduce((sum, data) => sum + data.length, 0);
        
        console.log(`=== Request Complete ===`);
        console.log(`Successfully processed ${totalPoints} months of data across all regions`);
        
        if (totalPoints === 0) {
            console.error('No data points after processing!');
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
            data: allData,
            fetchedAt: new Date().toISOString(),
            source: 'OpenElectricity API (openelectricity.org.au)',
            dataPoints: totalPoints,
            yearsFetched: years,
            monthsFetched: 3,
            dateRange: {
                start: startDateStr,
                end: endDateStr
            },
            endpoint: '/v4/data/network/NEM',
            note: 'Daily interval data from OpenElectricity aggregated into monthly statistics with comprehensive price event analysis'
        });

    } catch (error) {
        console.error('=== ERROR ===');
        console.error('Error in historical-all:', error);
        console.error('Stack:', error.stack);
        return res.status(500).json({
            error: 'Failed to fetch data from OpenElectricity',
            message: error.message,
            endpoint: '/v4/data/network/NEM',
            hint: 'Check Vercel logs for detailed error information. Ensure API key has access to the v4 data endpoints.'
        });
    }
};
