const https = require('https');

/**
 * Fetch price data from OpenElectricity API v4
 * Correct endpoint: /v4/data/network/{network_code}
 * Using metrics=price (not power) for actual price data
 */
function fetchOpenElectricityData(startDate, endDate, apiKey) {
    return new Promise((resolve, reject) => {
        // Correct v4 endpoint structure
        const params = new URLSearchParams({
            metrics: 'price',  // Use 'price' metric for electricity prices
            interval: '1d',     // Daily aggregation
            dateStart: startDate,
            dateEnd: endDate
        });
        
        const path = `/v4/data/network/NEM?${params.toString()}`;
        
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

        console.log(`Fetching from OpenElectricity API v4...`);
        console.log(`Full URL: https://api.openelectricity.org.au${path}`);
        console.log(`Date range: ${startDate} to ${endDate}`);

        const req = https.request(options, (res) => {
            let data = '';

            console.log(`Response status: ${res.statusCode}`);

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
                    console.log(`Response success:`, jsonData.success);
                    
                    if (jsonData.data && jsonData.data.length > 0) {
                        console.log(`Data items:`, jsonData.data.length);
                        console.log(`First item metric:`, jsonData.data[0].metric);
                        console.log(`First item results count:`, jsonData.data[0].results?.length);
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

        req.setTimeout(30000, () => {
            req.destroy();
            reject(new Error('Request timeout after 30 seconds'));
        });

        req.end();
    });
}

/**
 * Process OpenElectricity API v4 response
 * Structure: { success: bool, data: [TimeSeries], version: string, created_at: string }
 * TimeSeries: { metric, unit, interval, results: [Result] }
 * Result: { id: region_code, history: [DataPoint] }
 * DataPoint: { interval: ISO timestamp, value: number }
 */
function processOpenElectricityResponse(apiResponse) {
    console.log('Processing OpenElectricity response...');
    
    if (!apiResponse || !apiResponse.success) {
        console.error('API response indicates failure');
        return {};
    }

    if (!apiResponse.data || !Array.isArray(apiResponse.data)) {
        console.error('Missing or invalid data array in response');
        return {};
    }

    const regions = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'];
    const allData = {};

    // Initialize data structures for each region
    regions.forEach(region => {
        allData[region] = {};
    });

    console.log(`Processing ${apiResponse.data.length} time series objects...`);

    // Process each TimeSeries object
    apiResponse.data.forEach((timeSeries, index) => {
        console.log(`TimeSeries ${index}:`, {
            metric: timeSeries.metric,
            unit: timeSeries.unit,
            interval: timeSeries.interval,
            resultsCount: timeSeries.results?.length
        });

        // Only process price data
        if (timeSeries.metric !== 'price') {
            console.log(`Skipping non-price metric: ${timeSeries.metric}`);
            return;
        }
        
        if (!timeSeries.results || !Array.isArray(timeSeries.results)) {
            console.log(`No results array in timeSeries`);
            return;
        }

        // Process each region's data
        timeSeries.results.forEach((result) => {
            const region = result.id; // e.g., "NSW1"
            
            if (!regions.includes(region)) {
                console.log(`Skipping unknown region: ${region}`);
                return;
            }

            if (!result.history || !Array.isArray(result.history)) {
                console.log(`No history array for region ${region}`);
                return;
            }

            console.log(`Processing ${result.history.length} data points for ${region}`);
            
            // Process each data point in the history
            result.history.forEach((dataPoint) => {
                const date = new Date(dataPoint.interval);
                const price = dataPoint.value;

                if (price === null || price === undefined) {
                    return;
                }

                // Group by month (YYYY-MM format)
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

                // Add price to array for this month
                allData[region][monthKey].prices.push(price);

                // Count price events based on thresholds
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

    // Calculate monthly statistics for each region
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

/**
 * Serverless function handler
 */
module.exports = async (req, res) => {
    // CORS headers
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
        const years = parseInt(req.query.years) || 4;
        
        console.log(`=== Starting OpenElectricity API Request ===`);
        console.log(`Requesting ${years} years of historical data`);
        
        // Calculate date range
        const endDate = new Date();
        endDate.setDate(endDate.getDate() - 2); // Go back 2 days to ensure data availability
        
        const startDate = new Date(endDate);
        startDate.setFullYear(endDate.getFullYear() - years);
        
        const startDateStr = startDate.toISOString().split('T')[0];
        const endDateStr = endDate.toISOString().split('T')[0];

        console.log(`Requesting data from ${startDateStr} to ${endDateStr}`);

        // Fetch data from OpenElectricity API v4
        const apiResponse = await fetchOpenElectricityData(startDateStr, endDateStr, API_KEY);
        
        // Process data into monthly aggregates
        const processedData = processOpenElectricityResponse(apiResponse);

        // Count total data points
        const totalPoints = Object.values(processedData).reduce((sum, data) => sum + data.length, 0);
        
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
            data: processedData,
            fetchedAt: new Date().toISOString(),
            source: 'OpenElectricity API (openelectricity.org.au)',
            dataPoints: totalPoints,
            yearsFetched: years,
            dateRange: {
                start: startDateStr,
                end: endDateStr
            },
            endpoint: '/v4/data/network/NEM',
            note: 'Daily interval price data from OpenElectricity API aggregated into monthly statistics with price event analysis'
        });

    } catch (error) {
        console.error('=== ERROR ===');
        console.error('Error in historical-all:', error);
        console.error('Stack:', error.stack);
        return res.status(500).json({
            error: 'Failed to fetch data from OpenElectricity API',
            message: error.message,
            endpoint: '/v4/data/network/NEM',
            hint: 'Check that your API key is valid and has access to the OpenElectricity v4 data endpoints. Register at platform.openelectricity.org.au'
        });
    }
};
