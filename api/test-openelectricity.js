// Using the official OpenElectricity client library
const { OpenElectricityClient } = require('openelectricity');

module.exports = async (req, res) => {
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
        console.log('Initializing OpenElectricity client...');
        
        // Initialize the official client
        const client = new OpenElectricityClient({
            apiKey: API_KEY,
            baseUrl: 'https://api.openelectricity.org.au/v4'
        });

        const years = parseInt(req.query.years) || 1;
        const regions = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'];

        // Calculate date range - use recent dates
        const endDate = new Date();
        const startDate = new Date();
        startDate.setMonth(endDate.getMonth() - (years * 12));
        
        const startDateStr = startDate.toISOString().split('T')[0];
        const endDateStr = endDate.toISOString().split('T')[0];

        console.log(`Fetching market data from ${startDateStr} to ${endDateStr}`);

        // Try using the official client's getMarket method
        const { response, datatable } = await client.getMarket(
            "NEM", 
            ["price"], 
            {
                interval: "1d",
                dateStart: startDateStr,
                dateEnd: endDateStr,
                primaryGrouping: "network_region"
            }
        );

        console.log('Successfully fetched data from OpenElectricity');
        console.log('Response:', JSON.stringify(response).substring(0, 200));

        // Convert the datatable to our expected format
        const allData = {};
        
        // Initialize data structure
        regions.forEach(region => {
            allData[region] = [];
        });

        // Process the datatable rows
        if (datatable && datatable.rows) {
            datatable.rows.forEach(row => {
                const region = row.network_region;
                const date = new Date(row.interval);
                const price = row.price;

                if (region && price !== null && price !== undefined) {
                    // Group by month
                    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
                    
                    // Find or create month entry
                    let monthEntry = allData[region].find(entry => 
                        entry.year === date.getFullYear() && 
                        entry.month === date.getMonth() + 1
                    );

                    if (!monthEntry) {
                        monthEntry = {
                            year: date.getFullYear(),
                            month: date.getMonth() + 1,
                            date: new Date(date.getFullYear(), date.getMonth(), 1).toISOString(),
                            prices: []
                        };
                        allData[region].push(monthEntry);
                    }

                    monthEntry.prices.push(price);
                }
            });
        }

        // Calculate monthly averages
        regions.forEach(region => {
            allData[region] = allData[region].map(entry => ({
                year: entry.year,
                month: entry.month,
                date: entry.date,
                averagePrice: parseFloat((entry.prices.reduce((a, b) => a + b, 0) / entry.prices.length).toFixed(2))
            })).sort((a, b) => new Date(a.date) - new Date(b.date));
        });

        const totalPoints = Object.values(allData).reduce((sum, data) => sum + data.length, 0);

        return res.status(200).json({
            data: allData,
            fetchedAt: new Date().toISOString(),
            source: 'OpenElectricity API (official client)',
            dataPoints: totalPoints,
            yearsRequested: years
        });

    } catch (error) {
        console.error('Error with OpenElectricity client:', error);
        
        return res.status(500).json({
            error: 'Failed to fetch data from OpenElectricity',
            message: error.message,
            stack: error.stack?.substring(0, 500)
        });
    }
};
