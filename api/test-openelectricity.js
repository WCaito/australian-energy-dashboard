const https = require('https');

function testOpenElectricityEndpoint(path, apiKey) {
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

        console.log(`Testing: https://api.openelectricity.org.au${path}`);

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                resolve({
                    path,
                    status: res.statusCode,
                    bodyPreview: data.substring(0, 500)
                });
            });
        });

        req.on('error', (error) => {
            resolve({ path, error: error.message });
        });

        req.setTimeout(10000, () => {
            req.destroy();
            resolve({ path, error: 'Timeout' });
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
        // Test different endpoint paths based on official client
        const tests = [
            // Market endpoint (from official examples)
            `/v4/market/NEM?metrics=price&interval=1h&dateStart=2024-12-01&dateEnd=2024-12-02&primaryGrouping=network_region`,
            
            // Try without v4 prefix
            `/market/NEM?metrics=price&interval=1h&dateStart=2024-12-01&dateEnd=2024-12-02&primaryGrouping=network_region`,
            
            // Network data endpoint (from official examples)
            `/v4/network/NEM?metrics=energy&interval=1d&dateStart=2024-12-01&dateEnd=2024-12-02&primaryGrouping=network_region`,
            
            // Try simpler parameters
            `/v4/market/NEM?metrics=price&interval=1d&dateStart=2024-12-01&dateEnd=2024-12-02`,
            
            // Try just the base endpoint
            `/v4/market/NEM`,
        ];

        const results = [];
        for (const testPath of tests) {
            const result = await testOpenElectricityEndpoint(testPath, API_KEY);
            results.push(result);
            
            if (result.status === 200) {
                console.log(`✓ WORKING ENDPOINT: ${testPath}`);
                break;
            }
        }

        return res.status(200).json({
            message: 'OpenElectricity endpoint test results',
            results,
            apiKeyPrefix: API_KEY.substring(0, 10)
        });

    } catch (error) {
        return res.status(500).json({
            error: 'Test failed',
            message: error.message
        });
    }
};
