<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Historical Data - Australian Energy Market</title>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Serif:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    /* (… your existing styles unchanged …) */
  </style>
</head>
<body>
  <div class="container">
    <header>
      <a href="australian-energy-market.html" class="back-link">← Back to Dashboard</a>
      <h1>Historical Price Data</h1>
      <p class="subtitle">Monthly average and maximum spot prices from AEMO settlement data</p>
    </header>

    <div class="info-box">
      <div class="info-title">About This Data</div>
      <div class="info-text">
        This page displays real historical electricity price data from OpenElectricity API, which aggregates data from AEMO (Australian Energy Market Operator). Data shown are daily interval spot prices across the NEM, aggregated to monthly statistics with event analysis (negative, high $300–$1,000/MWh, extreme ≥$1,000/MWh).
      </div>
    </div>

    <div class="data-notice" id="dataSourceNotice">
      <div class="data-notice-text" id="dataSourceText">Loading data...</div>
    </div>

    <div class="controls">
      <div class="control-group">
        <label for="chartType">Chart Type</label>
        <select id="chartType" onchange="updateCharts()">
          <option value="line">Line Chart</option>
          <option value="bar">Bar Chart</option>
        </select>
      </div>
    </div>

    <div id="chartsContainer">
      <div class="loading">
        <div class="spinner"></div>
        Loading historical data from OpenElectricity API...
      </div>
    </div>
  </div>

  <script>
    const regions = [
      { code: 'NSW1', name: 'New South Wales', aemoCode: 'NSW1', color: '#2563eb' },
      { code: 'VIC1', name: 'Victoria', aemoCode: 'VIC1', color: '#7c3aed' },
      { code: 'QLD1', name: 'Queensland', aemoCode: 'QLD1', color: '#dc2626' },
      { code: 'SA1',  name: 'South Australia', aemoCode: 'SA1',  color: '#059669' },
      { code: 'TAS1', name: 'Tasmania', aemoCode: 'TAS1', color: '#ea580c' }
    ];

    let charts = {};
    let cachedRealData = null;

    // If you open the file locally, assume dev server on localhost:3000
    const API_URL = (window.location.protocol === 'file:')
      ? 'http://localhost:3000'
      : window.location.origin;

    async function loadHistoricalData() {
      try {
        const response = await fetch(`${API_URL}/api/historical-all?years=4`, {
          // No client-side Authorization header needed: your serverless function holds the API key
          method: 'GET'
        });

        if (!response.ok) {
          let errorText = `HTTP ${response.status}`;
          try {
            const e = await response.json();
            errorText += `: ${e.message || e.error || 'Unknown error'}`;
          } catch (_) {}
          throw new Error(errorText);
        }

        const result = await response.json();
        if (!result.data) throw new Error('No data returned from server');

        const data = {};
        regions.forEach((region) => {
          const regionData = result.data[region.aemoCode];
          if (Array.isArray(regionData) && regionData.length > 0) {
            data[region.code] = regionData.map(item => ({
              date: new Date(item.date),
              averagePrice: item.averagePrice,
              maxPrice: item.maxPrice,
              priceEvents: item.priceEvents
            }));
          } else {
            data[region.code] = [];
          }
        });

        const hasData = Object.values(data).some(arr => arr.length > 0);
        if (!hasData) throw new Error('No valid data received for any region');

        updateDataSourceNotice('✓ Real data from OpenElectricity API (v4). Grouped by region and aggregated monthly.');
        return data;
      } catch (err) {
        console.error('Error loading data:', err);
        throw err;
      }
    }

    function calculateStats(data) {
      const avgPrices = data.map(d => d.averagePrice);
      const maxPrices = data.map(d => d.maxPrice);
      return {
        average: (avgPrices.reduce((a, b) => a + b, 0) / avgPrices.length).toFixed(2),
        peak: Math.max(...maxPrices).toFixed(2),
        lowest: Math.min(...avgPrices).toFixed(2)
      };
    }

    function aggregatePriceEvents(data) {
      const totals = {
        negative: { count: 0, percentage: 0 },
        high: { count: 0, percentage: 0 },
        extreme: { count: 0, percentage: 0 }
      };
      let totalCount = 0;
      data.forEach(item => {
        if (item.priceEvents) {
          totals.negative.count += Number(item.priceEvents.negative.count || 0);
          totals.high.count     += Number(item.priceEvents.high.count || 0);
          totals.extreme.count  += Number(item.priceEvents.extreme.count || 0);
          totalCount += Number(item.priceEvents.negative.count || 0)
                      + Number(item.priceEvents.high.count || 0)
                      + Number(item.priceEvents.extreme.count || 0);
        }
      });

      // Approximate denominator if you'd like; we keep your original rough approach.
      const totalIntervals = data.length * 30 * 24 * 12; // months * days * hours * 5-min intervals
      totals.negative.percentage = ((totals.negative.count / totalIntervals) * 100).toFixed(2);
      totals.high.percentage     = ((totals.high.count / totalIntervals) * 100).toFixed(2);
      totals.extreme.percentage  = ((totals.extreme.count / totalIntervals) * 100).toFixed(2);
      return totals;
    }

    /* ---- chart builders (unchanged from your version) ---- */
    // createChart, createNegativePriceChart, createHighPriceChart, createExtremePriceChart
    // (Keep your existing implementations; they work with the processed structure.)

    function createChart(region, data, chartType) {
      // ... (your existing implementation unchanged)
      // ✂️ For brevity in this message; keep your original chart code here
    }
    function createNegativePriceChart(region, data) { /* ... unchanged ... */ }
    function createHighPriceChart(region, data)     { /* ... unchanged ... */ }
    function createExtremePriceChart(region, data)  { /* ... unchanged ... */ }

    async function renderCharts() {
      const chartType = document.getElementById('chartType').value;
      const container = document.getElementById('chartsContainer');
      container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading historical data from OpenElectricity API...</div>';

      try {
        if (!cachedRealData) cachedRealData = await loadHistoricalData();
        const allData = cachedRealData;

        container.innerHTML = regions.map(region => {
          const regionData = allData[region.code];
          if (!regionData || regionData.length === 0) {
            return `
              <div class="chart-container">
                <div class="chart-header">
                  <h2 class="chart-title">${region.name} (${region.code})</h2>
                </div>
                <div style="padding: 40px; text-align: center; color: #999;">No data available for this region</div>
              </div>
            `;
          }

          const stats = calculateStats(regionData);
          const events = aggregatePriceEvents(regionData);

          return `
            <div class="chart-container">
              <div class="chart-header">
                <h2 class="chart-title">${region.name} (${region.code})</h2>
                <div class="chart-stats">
                  <div class="stat">
                    <span class="stat-label">Avg Price</span>
                    <span class="stat-value">$${stats.average} /MWh</span>
                  </div>
                  <div class="stat">
                    <span class="stat-label">Peak Price</span>
                    <span class="stat-value">$${stats.peak} /MWh</span>
                  </div>
                  <div class="stat">
                    <span class="stat-label">Lowest Avg</span>
                    <span class="stat-value">$${stats.lowest} /MWh</span>
                  </div>
                </div>
              </div>
              <div class="canvas-wrapper">
                <canvas id="chart-${region.code}"></canvas>
              </div>
              ${createPriceEventsTable(events)}
              <div class="event-charts-grid">
                <div class="event-chart-container">
                  <div class="event-chart-title">Negative Price Events Per Month</div>
                  <div class="event-chart-wrapper"><canvas id="chart-negative-${region.code}"></canvas></div>
                </div>
                <div class="event-chart-container">
                  <div class="event-chart-title">High Price Events ($300-$1,000/MWh)</div>
                  <div class="event-chart-wrapper"><canvas id="chart-high-${region.code}"></canvas></div>
                </div>
                <div class="event-chart-container">
                  <div class="event-chart-title">Extreme Price Events (≥$1,000/MWh)</div>
                  <div class="event-chart-wrapper"><canvas id="chart-extreme-${region.code}"></canvas></div>
                </div>
              </div>
            </div>
          `;
        }).join('');

        // Render after DOM insert
        setTimeout(() => {
          regions.forEach(region => {
            const regionData = allData[region.code];
            if (regionData && regionData.length > 0) {
              createChart(region, regionData, chartType);
              createNegativePriceChart(region, regionData);
              createHighPriceChart(region, regionData);
              createExtremePriceChart(region, regionData);
            }
          });
        }, 100);

      } catch (err) {
        console.error('Error rendering charts:', err);
        container.innerHTML = `
          <div class="chart-container">
            <div style="padding: 40px; text-align: center;">
              <h3 style="color: #dc2626; margin-bottom: 16px;">⚠️ Unable to Load Data</h3>
              <p style="color: #666; margin-bottom: 12px;">${err.message}</p>
              <div style="background: #fef3c7; border-left: 3px solid #f59e0b; padding: 16px; margin: 20px 0; text-align: left;">
                <p style="color: #92400e; font-size: 0.875rem;">
                  Ensure your serverless function is running and has a valid OpenElectricity API key.
                </p>
              </div>
            </div>
          </div>
        `;
        updateDataSourceNotice('✗ Failed to load data.');
      }
    }

    function createPriceEventsTable(events) {
      return `
        <div class="table-title">Price Events Analysis</div>
        <table class="price-events-table">
          <thead>
            <tr><th>Event Type</th><th>Count</th><th>% of Period</th></tr>
          </thead>
          <tbody>
            <tr><td>Negative Prices (&lt; $0/MWh)</td>
                <td><span class="event-count">${Number(events.negative.count).toLocaleString()}</span></td>
                <td><span class="event-percentage">${events.negative.percentage}%</span></td></tr>
            <tr><td>High Prices ($300 - $1,000/MWh)</td>
                <td><span class="event-count">${Number(events.high.count).toLocaleString()}</span></td>
                <td><span class="event-percentage">${events.high.percentage}%</span></td></tr>
            <tr><td>Extreme Prices (≥ $1,000/MWh)</td>
                <td><span class="event-count">${Number(events.extreme.count).toLocaleString()}</span></td>
                <td><span class="event-percentage">${events.extreme.percentage}%</span></td></tr>
          </tbody>
        </table>
      `;
    }

    function updateDataSourceNotice(message) {
      const notice = document.getElementById('dataSourceNotice');
      const text = document.getElementById('dataSourceText');
      text.textContent = message;
      notice.style.display = 'block';
    }

    function updateCharts() {
      cachedRealData = null;  // force re-load (you can optimize by preserving)
      renderCharts();
    }

    renderCharts();
  </script>
</body>
</html>
