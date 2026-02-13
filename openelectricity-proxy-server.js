// OpenElectricity API Proxy Server for Vercel
// This server fetches historical price data from OpenElectricity API
// Designed to work as a Vercel serverless function

const https = require('https');

// Get API key from environment variable
const API_KEY = process.env.OPENELECTRICITY_API_KEY;

// In-memory cache (note: resets on each cold start in serverless)
const dataCache = new Map();
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetch price data from OpenElectricity API
 */
function fetchOpenElectricityData(startDate, endDate) {
    return new Promise((resolve, reject) => {
        if (!API_KEY) {
            reject(new Error('OPENELECTRICITY_API_KEY not set'));
            return;
        }

        const options = {
            hostname: 'api.openelectricity.org.au',
            port: 443,
            path: `/v4/market/NEM?metrics=price&interval=1d&primaryGrouping=network_region&dateStart=${startDate}&dateEnd=${endDate}`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Accept': 'application/json'
            }
        };

        console.log(`Fetching from OpenElectricity API: ${startDate} to ${endDate}`);

        const req = https.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    if (res.statusCode !== 200) {
                        if (res.statusCode === 401) {
                            reject(new Error('Invalid API key'));
                        } else {
                            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                        }
                        return;
                    }

                    const jsonData = JSON.parse(data);
                    resolve(jsonData);
                } catch (error) {
                    reject(error);
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        req.end();
    });
}

/**
 * Process OpenElectricity API response to extract regional price data
 */
function processOpenElectricityResponse(apiResponse, targetRegion) {
    if (!apiResponse.data || !Array.isArray(apiResponse.data)) {
        return [];
    }

    const monthlyData = [];

    // Find the price metric data
    const priceData = apiResponse.data.find(d => d.metric === 'price');
    if (!priceData || !priceData.results) {
        return [];
    }

    // Find the specific region
    const regionData = priceData.results.find(r => r.id === targetRegion);
    if (!regionData || !regionData.history) {
        return [];
    }

    // Group daily data into monthly averages
    const monthlyGroups = {};
    
    regionData.history.forEach(point => {
        const date = new Date(point.interval);
        const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        
        if (!monthlyGroups[monthKey]) {
            monthlyGroups[monthKey] = {
                prices: [],
                date: new Date(date.getFullYear(), date.getMonth(), 1)
            };
        }
        
        if (point.value !== null && point.value !== undefined) {
            monthlyGroups[monthKey].prices.push(point.value);
        }
    });

    // Calculate monthly averages
    Object.values(monthlyGroups).forEach(group => {
        if (group.prices.length > 0) {
            const average = group.prices.reduce((a, b) => a + b, 0) / group.prices.length;
            monthlyData.push({
                year: group.date.getFullYear(),
                month: group.date.getMonth() + 1,
                date: group.date.toISOString(),
                averagePrice: parseFloat(average.toFixed(2))
            });
        }
    });

    return monthlyData.sort((a, b) => new Date(a.date) - new Date(b.date));
}

/**
 * Main serverless function handler
 */
module.exports = async (req, res) => {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const { url, method } = req;

    try {
        // Health check endpoint
        if (url.includes('/api/health')) {
            return res.status(200).json({
                status: 'ok',
                timestamp: new Date().toISOString(),
                cacheSize: dataCache.size,
                apiKeyConfigured: !!API_KEY
            });
        }

        // Clear cache endpoint
        if (url.includes('/api/clear-cache') && method === 'POST') {
            dataCache.clear();
            return res.status(200).json({
                message: 'Cache cleared successfully',
                timestamp: new Date().toISOString()
            });
        }

        // Historical data for single region
        if (url.match(/\/api\/historical\/([A-Z0-9]+)/)) {
            const matches = url.match(/\/api\/historical\/([A-Z0-9]+)/);
            const region = matches[1].toUpperCase();
            const urlParams = new URL(url, `http://${req.headers.host}`).searchParams;
            const years = parseInt(urlParams.get('years')) || 4;

            // Validate region
            const validRegions = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'];
            if (!validRegions.includes(region)) {
                return res.status(400).json({
                    error: 'Invalid region',
                    validRegions: validRegions
                });
            }

            // Check API key
            if (!API_KEY) {
                return res.status(500).json({
                    error: 'OpenElectricity API key not configured',
                    message: 'OPENELECTRICITY_API_KEY environment variable not set'
                });
            }

            // Check cache
            const cacheKey = `${region}-${years}`;
            const cached = dataCache.get(cacheKey);
            if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
                console.log(`Returning cached data for ${cacheKey}`);
                return res.status(200).json({
                    data: cached.data,
                    cached: true,
                    cachedAt: new Date(cached.timestamp).toISOString()
                });
            }

            // Calculate date range
            const endDate = new Date();
            const startDate = new Date();
            startDate.setFullYear(endDate.getFullYear() - years);
            
            const startDateStr = startDate.toISOString().split('T')[0];
            const endDateStr = endDate.toISOString().split('T')[0];

            // Fetch data
            const apiResponse = await fetchOpenElectricityData(startDateStr, endDateStr);
            const monthlyData = processOpenElectricityResponse(apiResponse, region);

            if (monthlyData.length === 0) {
                return res.status(404).json({
                    error: 'No data available for this region and time period',
                    region: region,
                    startDate: startDateStr,
                    endDate: endDateStr
                });
            }

            // Cache the results
            dataCache.set(cacheKey, {
                data: monthlyData,
                timestamp: Date.now()
            });

            console.log(`✓ Fetched ${monthlyData.length} months of data for ${region}`);

            return res.status(200).json({
                data: monthlyData,
                cached: false,
                fetchedAt: new Date().toISOString(),
                dataPoints: monthlyData.length,
                source: 'OpenElectricity API'
            });
        }

        // Historical data for all regions
        if (url.includes('/api/historical-all')) {
            const urlParams = new URL(url, `http://${req.headers.host}`).searchParams;
            const years = parseInt(urlParams.get('years')) || 4;
            const regions = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'];

            // Check API key
            if (!API_KEY) {
                return res.status(500).json({
                    error: 'OpenElectricity API key not configured',
                    message: 'OPENELECTRICITY_API_KEY environment variable not set'
                });
            }

            // Calculate date range
            const endDate = new Date();
            const startDate = new Date();
            startDate.setFullYear(endDate.getFullYear() - years);
            
            const startDateStr = startDate.toISOString().split('T')[0];
            const endDateStr = endDate.toISOString().split('T')[0];

            // Fetch data from OpenElectricity (returns all regions at once)
            const apiResponse = await fetchOpenElectricityData(startDateStr, endDateStr);

            const allData = {};

            // Process data for each region
            for (const region of regions) {
                const cacheKey = `${region}-${years}`;
                const cached = dataCache.get(cacheKey);

                if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
                    allData[region] = cached.data;
                    console.log(`Using cached data for ${region}`);
                } else {
                    const monthlyData = processOpenElectricityResponse(apiResponse, region);

                    if (monthlyData.length > 0) {
                        dataCache.set(cacheKey, {
                            data: monthlyData,
                            timestamp: Date.now()
                        });
                        allData[region] = monthlyData;
                        console.log(`✓ Processed ${monthlyData.length} months for ${region}`);
                    } else {
                        console.log(`✗ No data available for ${region}`);
                        allData[region] = [];
                    }
                }
            }

            return res.status(200).json({
                data: allData,
                fetchedAt: new Date().toISOString(),
                source: 'OpenElectricity API'
            });
        }

        // Unknown endpoint
        return res.status(404).json({
            error: 'Endpoint not found',
            available: [
                '/api/health',
                '/api/historical/:region?years=4',
                '/api/historical-all?years=4',
                '/api/clear-cache'
            ]
        });

    } catch (error) {
        console.error('Error:', error);
        return res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
};
