const https = require('https');

/**
 * Fetch price data from OpenElectricity API
 */
function fetchOpenElectricityData(startDate, endDate, apiKey) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.openelectricity.org.au',
            port: 443,
            path: `/v4/market/NEM?metrics=price&interval=1d&primaryGrouping=network_region&dateStart=${startDate}&dateEnd=${endDate}`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Accept': 'application/json'
            }
        };

        console.log(`Fetching from OpenElectricity: ${startDate} to ${endDate}`);

        const req = https.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    if (res.statusCode !== 200) {
                        reject(new Error(`HTTP ${res.statusCode}`));
                        return;
                    }
                    resolve(JSON.parse(data));
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
 * Process OpenElectricity API response
 */
function processRegionData(apiResponse, targetRegion) {
    if (!apiResponse.data || !Array.isArray(apiResponse.data)) {
        return [];
    }

    const priceData = apiResponse.data.find(d => d.metric === 'price');
    if (!priceData || !priceData.results) {
        return [];
    }

    const regionData = priceData.results.find(r => r.id === targetRegion);
    if (!regionData || !regionData.history) {
        return [];
    }

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

    const monthlyData = [];
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

module.exports = async (req, res) => {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const API_KEY = process.env.OPENELECTRICITY_API_KEY;

    if (!API_KEY) {
        return res.status(500).json({
            error: 'API key not configured',
            message: 'OPENELECTRICITY_API_KEY environment variable not set'
        });
    }

    try {
        const years = parseInt(req.query.years) || 4;
        const regions = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'];

        // Calculate date range
        const endDate = new Date();
        const startDate = new Date();
        startDate.setFullYear(endDate.getFullYear() - years);
        
        const startDateStr = startDate.toISOString().split('T')[0];
        const endDateStr = endDate.toISOString().split('T')[0];

        // Fetch data
        const apiResponse = await fetchOpenElectricityData(startDateStr, endDateStr, API_KEY);

        const allData = {};

        // Process each region
        for (const region of regions) {
            const monthlyData = processRegionData(apiResponse, region);
            allData[region] = monthlyData;
            console.log(`✓ Processed ${monthlyData.length} months for ${region}`);
        }

        return res.status(200).json({
            data: allData,
            fetchedAt: new Date().toISOString(),
            source: 'OpenElectricity API'
        });

    } catch (error) {
        console.error('Error:', error);
        return res.status(500).json({
            error: 'Failed to fetch data',
            message: error.message
        });
    }
};
