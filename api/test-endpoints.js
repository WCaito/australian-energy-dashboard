const https = require('https');

function testEndpoint(path, apiKey) {
    return new Promise((resolve) => {
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

        console.log(`Testing endpoint: https://api.openelectricity.org.au${path}`);

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                resolve({
                    path: path,
                    status: res.statusCode,
                    headers: res.headers,
                    body: data.substring(0, 500)
                });
            });
        });

        req.on('error', (error) => {
            resolve({
                path: path,
                error: error.message
            });
        });

        req.setTimeout(10000, () => {
            req.destroy();
            resolve({
                path: path,
                error: 'Timeout'
            });
        });

        req.end();
    });
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
        return res.status(500).json({ error: 'API key not configured' });
    }

    try {
        const endDate = new Date();
        const startDate = new Date();
        startDate.setMonth(endDate.getMonth() - 1); // Just 1 month
        
        const start = startDate.toISOString().split('T')[0];
        const end = endDate.toISOString().split('T')[0];

        console.log(`Testing various endpoint formats for dates: ${start} to ${end}`);

        // Test different endpoint formats
        const tests = [
            // Original format
            `/v4/market/NEM?metrics=price&interval=1d&primaryGrouping=network_region&dateStart=${start}&dateEnd=${end}`,
            
            // Try without grouping
            `/v4/market/NEM?metrics=price&interval=1d&dateStart=${start}&dateEnd=${end}`,
            
            // Try different interval
            `/v4/market/NEM?metrics=price&interval=5m&primaryGrouping=network_region&dateStart=${start}&dateEnd=${end}`,
            
            // Try different market format
            `/v4/markets/NEM?metrics=price&interval=1d&primaryGrouping=network_region&dateStart=${start}&dateEnd=${end}`,
            
            // Try generation endpoint instead
            `/v4/generation/NEM?interval=1d&dateStart=${start}&dateEnd=${end}`,
            
            // Try simpler path
            `/v4/market/NEM`,
        ];

        const results = [];
        for (const testPath of tests) {
            const result = await testEndpoint(testPath, API_KEY);
            results.push(result);
            
            // If we found a working endpoint, stop testing
            if (result.status === 200) {
                console.log(`✓ FOUND WORKING ENDPOINT: ${testPath}`);
                break;
            }
        }

        return res.status(200).json({
            message: 'Endpoint test results',
            dateRange: { start, end },
            results: results,
            apiKeyPresent: !!API_KEY,
            apiKeyPrefix: API_KEY.substring(0, 10)
        });

    } catch (error) {
        console.error('Error:', error);
        return res.status(500).json({
            error: 'Test failed',
            message: error.message
        });
    }
};
