// OpenElectricity API Proxy Server
// This server fetches historical price data from OpenElectricity API
// Run with: node openelectricity-proxy-server.js
// 
// NOTE: You need an API key from https://platform.openelectricity.org.au
// Set it as an environment variable: OPENELECTRICITY_API_KEY=your_key_here

const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// Get API key from environment variable
const API_KEY = process.env.OPENELECTRICITY_API_KEY;

// Enable CORS for all routes
app.use(cors());
app.use(express.json());

// Serve static files (your HTML pages)
app.use(express.static(__dirname));

// Cache to store fetched data
const dataCache = new Map();
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetch price data from OpenElectricity API
 */
function fetchOpenElectricityData(startDate, endDate) {
    return new Promise((resolve, reject) => {
        if (!API_KEY) {
            reject(new Error('OPENELECTRICITY_API_KEY not set. Please register at https://platform.openelectricity.org.au'));
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
                            reject(new Error('Invalid API key. Check your OPENELECTRICITY_API_KEY'));
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
 * API endpoint to get historical data for a region
 * GET /api/historical/:region?years=4
 */
app.get('/api/historical/:region', async (req, res) => {
    const region = req.params.region.toUpperCase();
    const years = parseInt(req.query.years) || 4;
    
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
            message: 'Please set OPENELECTRICITY_API_KEY environment variable. Register at https://platform.openelectricity.org.au'
        });
    }
    
    // Check cache
    const cacheKey = `${region}-${years}`;
    const cached = dataCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
        console.log(`Returning cached data for ${cacheKey}`);
        return res.json({ 
            data: cached.data, 
            cached: true,
            cachedAt: new Date(cached.timestamp).toISOString()
        });
    }
    
    try {
        // Calculate date range
        const endDate = new Date();
        const startDate = new Date();
        startDate.setFullYear(endDate.getFullYear() - years);
        
        const startDateStr = startDate.toISOString().split('T')[0];
        const endDateStr = endDate.toISOString().split('T')[0];
        
        // Fetch data from OpenElectricity
        const apiResponse = await fetchOpenElectricityData(startDateStr, endDateStr);
        
        // Process the response to get monthly averages
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
        
        res.json({ 
            data: monthlyData,
            cached: false,
            fetchedAt: new Date().toISOString(),
            dataPoints: monthlyData.length,
            source: 'OpenElectricity API'
        });
        
    } catch (error) {
        console.error('Error fetching OpenElectricity data:', error);
        res.status(500).json({ 
            error: 'Failed to fetch data from OpenElectricity',
            message: error.message,
            hint: 'Make sure OPENELECTRICITY_API_KEY is set correctly'
        });
    }
});

/**
 * API endpoint to get data for all regions at once
 * GET /api/historical-all?years=4
 */
app.get('/api/historical-all', async (req, res) => {
    const years = parseInt(req.query.years) || 4;
    const regions = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'];
    
    // Check API key
    if (!API_KEY) {
        return res.status(500).json({
            error: 'OpenElectricity API key not configured',
            message: 'Please set OPENELECTRICITY_API_KEY environment variable. Register at https://platform.openelectricity.org.au'
        });
    }
    
    try {
        // Calculate date range
        const endDate = new Date();
        const startDate = new Date();
        startDate.setFullYear(endDate.getFullYear() - years);
        
        const startDateStr = startDate.toISOString().split('T')[0];
        const endDateStr = endDate.toISOString().split('T')[0];
        
        // Fetch data from OpenElectricity (it returns all regions at once)
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
                }
            }
        }
        
        res.json({
            data: allData,
            fetchedAt: new Date().toISOString(),
            source: 'OpenElectricity API'
        });
        
    } catch (error) {
        console.error('Error fetching OpenElectricity data:', error);
        res.status(500).json({ 
            error: 'Failed to fetch data from OpenElectricity',
            message: error.message,
            hint: 'Make sure OPENELECTRICITY_API_KEY is set correctly. Register at https://platform.openelectricity.org.au'
        });
    }
});

/**
 * Health check endpoint
 */
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok',
        timestamp: new Date().toISOString(),
        cacheSize: dataCache.size,
        apiKeyConfigured: !!API_KEY
    });
});

/**
 * Clear cache endpoint
 */
app.post('/api/clear-cache', (req, res) => {
    dataCache.clear();
    res.json({ 
        message: 'Cache cleared successfully',
        timestamp: new Date().toISOString()
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`\n🚀 OpenElectricity Data Proxy Server running on http://localhost:${PORT}`);
    console.log(`\nAPI Key Status: ${API_KEY ? '✓ Configured' : '✗ NOT CONFIGURED'}`);
    
    if (!API_KEY) {
        console.log(`\n⚠️  WARNING: OPENELECTRICITY_API_KEY environment variable is not set!`);
        console.log(`   Register for an API key at: https://platform.openelectricity.org.au`);
        console.log(`   Then set it: export OPENELECTRICITY_API_KEY=your_key_here\n`);
    }
    
    console.log(`\nAvailable endpoints:`);
    console.log(`  GET  /api/health - Health check`);
    console.log(`  GET  /api/historical/:region?years=4 - Get data for one region`);
    console.log(`  GET  /api/historical-all?years=4 - Get data for all regions`);
    console.log(`  POST /api/clear-cache - Clear the data cache`);
    console.log(`\nExample: http://localhost:${PORT}/api/historical/NSW1?years=2`);
    console.log(`\nValid regions: NSW1, VIC1, QLD1, SA1, TAS1`);
    console.log(`\nData source: OpenElectricity API (openelectricity.org.au)\n`);
});
