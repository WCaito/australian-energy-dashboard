const https = require('https');

function fetchOpenElectricityData(startDate, endDate, apiKey) {
    return new Promise((resolve, reject) => {
        const path = `/v4/market/NEM?metrics=price&interval=1d&primaryGrouping=network_region&dateStart=${startDate}&dateEnd=${endDate}`;
        
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

        console.log(`Fetching: https://api.openelectricity.org.au${path}`);
        console.log(`API Key (first 10 chars): ${apiKey.substring(0, 10)}...`);

        const req = https.request(options, (res) => {
            let data = '';
            
            console.log(`Response status: ${res.statusCode}`);
            
            res.on('data', (chunk) => { data += chunk; });
            
            res.on('end', () => {
                console.log(`Response received, length: ${data.length} bytes`);
                
                try {
                    if (res.statusCode === 404) {
                        console.error(`404 response body: ${data}`);
                        reject(new Error(`OpenElectricity API returned 404. The endpoint or date range may not be available. Try a shorter time range or check if your API key has full access.`));
                        return;
                    }
                    
                    if (res.statusCode === 401) {
                        reject(new Error(`Invalid API key. Please check your OPENELECTRICITY_API_KEY.`));
                        return;
                    }
                    
                    if (res.statusCode === 403) {
                        reject(new Error(`Access forbidden. Your API key may be waitlisted or doesn't have permission for this endpoint.`));
                        return;
                    }
                    
                    if (res.statusCode !== 200) {
                        reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                        return;
                    }
                    
                    const jsonData = JSON.parse(data);
                    console.log(`Successfully parsed JSON response`);
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

        req.end();
    });
}

function processRegionData(apiResponse, targetRegion) {
    if (!apiResponse.data || !Array.isArray(apiResponse.data)) {
        console.log(`No data array in response for ${targetRegion}`);
        return [];
    }

    const priceData = apiResponse.data.find(d => d.metric === 'price');
    if (!priceData || !priceData.results) {
        console.log(`No price data found for ${targetRegion}`);
        return [];
    }

    const regionData = priceData.results.find(r => r.id === targetRegion);
    if (!regionData || !regionData.history) {
        console.log(`No region data found for ${targetRegion}`);
        return [];
    }

    console.log(`Found ${regionData.history.length} data points for ${targetRegion}`);

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
        const yearsRequested = parseInt(req.query.years) || 4;
        const regions = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'];

        // Calculate date range - go back in time from today
        const endDate = new Date();
        const startDate = new Date();
        
        // Go back 1 year from today (use 1 year regardless of what user requests, to avoid errors)
        startDate.setFullYear(endDate.getFullYear() - 1);
        
        const startDateStr = startDate.toISOString().split('T')[0];
        const endDateStr = endDate.toISOString().split('T')[0];

        console.log(`User requested: ${yearsRequested} years`);
        console.log(`Actually fetching data from ${startDateStr} to ${endDateStr}`);
        console.log(`Today's date is: ${new Date().toISOString().split('T')[0]}`);

        const apiResponse = await fetchOpenElectricityData(startDateStr, endDateStr, API_KEY);

        const allData = {};
        for (const region of regions) {
            const monthlyData = processRegionData(apiResponse, region);
            allData[region] = monthlyData;
            console.log(`Processed ${monthlyData.length} months for ${region}`);
        }

        const totalDataPoints = Object.values(allData).reduce((sum, data) => sum + data.length, 0);
        console.log(`Total data points across all regions: ${totalDataPoints}`);

        return res.status(200).json({
            data: allData,
            fetchedAt: new Date().toISOString(),
            source: 'OpenElectricity API',
            dateRange: { start: startDateStr, end: endDateStr }
        });

    } catch (error) {
        console.error('Error in historical-all:', error);
        return res.status(500).json({
            error: 'Failed to fetch data',
            message: error.message
        });
    }
};
