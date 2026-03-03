/**
 * nav.js — Shared site navigation for Australian Energy Dashboard.
 *
 * Usage: drop this anywhere inside <body> on each page:
 *   <div id="site-nav"></div>
 *   <script src="nav.js" data-active="live"></script>
 *
 * data-active values: live | historical | generators | batteries | analysis | scenario
 *
 * The script injects:
 *   - The full <header> block (title, subtitle, live indicator, nav links)
 *   - The cache status bar (fixed footer bar)
 *   - The refresh panel (bottom-right corner)
 *   - All required CSS for the above
 *
 * Pages define their own page-specific title/subtitle by setting:
 *   window.NAV_TITLE    (string)
 *   window.NAV_SUBTITLE (string)
 *   window.NAV_LIVE     (bool, default false — shows the pulsing live dot)
 *
 * before this script tag, e.g.:
 *   <script>
 *     window.NAV_TITLE    = 'Market Analysis';
 *     window.NAV_SUBTITLE = 'Price duration curves and intraday shape for any NEM region.';
 *     window.NAV_LIVE     = false;
 *   </script>
 *   <script src="nav.js" data-active="analysis"></script>
 */

(function () {
  'use strict';

  // ── Page registry ─────────────────────────────────────────────────────────
  const PAGES = [
    { key: 'live',        label: 'Live Prices',   href: 'australian-energy-market.html' },
    { key: 'historical',  label: 'Historical',    href: 'historical-data.html'          },
    { key: 'generators',  label: 'Generators',    href: 'facility-data.html'            },
    { key: 'batteries',   label: 'NSW Batteries', href: 'bess-nsw.html'                 },
    { key: 'analysis',    label: 'Analysis',      href: 'analysis.html'                 },
    { key: 'scenario',   label: 'Scenario Sim',  href: 'scenario.html'                 },
  ];

  // ── Shared CSS ────────────────────────────────────────────────────────────
  const CSS = `
/* ── nav.js shared styles ─────────────────────────────────────────────────── */
:root {
  --bg:        #ffffff;
  --bg-subtle: #f9fafb;
  --border:    #e5e7eb;
  --text-1:    #111827;
  --text-2:    #6b7280;
  --text-3:    #9ca3af;
  --accent:    #2563eb;
  --accent-bg: #eff6ff;
  --positive:  #059669;
  --negative:  #dc2626;
}
#site-nav header {
  padding: 44px 0 32px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 48px;
}
#site-nav .header-inner {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 32px;
  flex-wrap: wrap;
}
#site-nav h1 {
  font-family: 'IBM Plex Serif', Georgia, serif;
  font-size: 2.125rem;
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: -0.02em;
  color: var(--text-1);
  margin-bottom: 8px;
}
#site-nav .subtitle {
  font-size: 0.9375rem;
  color: var(--text-2);
  font-weight: 400;
  max-width: 520px;
  line-height: 1.5;
}
#site-nav .live-indicator {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  font-size: 0.8125rem;
  color: var(--text-3);
}
#site-nav .live-dot {
  width: 6px; height: 6px;
  background: var(--positive);
  border-radius: 50%;
  animation: nav-pulse 2s ease-in-out infinite;
}
@keyframes nav-pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
#site-nav .header-nav {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: flex-start;
  padding-top: 6px;
}
#site-nav .nav-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 7px 15px;
  font-size: 0.8125rem;
  font-weight: 500;
  text-decoration: none;
  border: 1px solid var(--border);
  color: var(--text-2);
  background: var(--bg);
  transition: border-color 0.15s, color 0.15s, background 0.15s;
  white-space: nowrap;
  font-family: 'IBM Plex Sans', sans-serif;
}
#site-nav .nav-link:hover {
  border-color: var(--text-1);
  color: var(--text-1);
}
#site-nav .nav-link.active {
  background: var(--text-1);
  border-color: var(--text-1);
  color: #ffffff;
}
#site-nav .nav-link.active:hover {
  background: var(--accent);
  border-color: var(--accent);
}
@media (max-width: 768px) {
  #site-nav h1 { font-size: 1.75rem; }
  #site-nav .header-inner { flex-direction: column; gap: 20px; }
}

/* ── Cache bar ─────────────────────────────────────────────────────────────── */
#globalCacheBar {
  position: fixed; bottom: 0; left: 0; right: 0;
  background: rgba(255,255,255,0.97);
  backdrop-filter: blur(8px);
  border-top: 1px solid var(--border);
  padding: 10px 28px;
  display: flex; align-items: center; gap: 12px;
  font-family: 'IBM Plex Sans', sans-serif;
  font-size: 0.75rem; color: var(--text-2);
  z-index: 999;
}
#globalCacheBar .gcb-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--text-3); flex-shrink: 0;
  transition: background 0.3s;
}
#globalCacheBar .gcb-dot.fresh { background: var(--positive); }
#globalCacheBar .gcb-dot.stale { background: #f59e0b; }
#globalCacheBar .gcb-dot.miss  { background: var(--negative); }
#globalCacheBar .gcb-text { flex: 1; }
#globalCacheBar .gcb-btn {
  padding: 5px 14px;
  background: var(--text-1); color: #fff;
  border: none; cursor: pointer;
  font-size: 0.75rem; font-family: inherit; font-weight: 500;
  flex-shrink: 0; transition: background 0.15s;
}
#globalCacheBar .gcb-btn:hover { background: var(--accent); }
#globalCacheBar .gcb-btn:disabled { background: var(--text-3); cursor: not-allowed; }
@keyframes gcb-spin { to { transform: rotate(360deg); } }
.gcb-spinner {
  display: inline-block; width: 10px; height: 10px;
  border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff;
  border-radius: 50%; animation: gcb-spin 0.7s linear infinite;
  margin-right: 5px; vertical-align: middle;
}
body { padding-bottom: 44px; }

/* ── Refresh panel ─────────────────────────────────────────────────────────── */
.refresh-panel {
  position: fixed; bottom: 52px; right: 28px;
  display: flex; flex-direction: column; align-items: flex-end;
  gap: 8px; z-index: 100;
}
.cache-status-badge {
  background: rgba(255,255,255,0.97);
  backdrop-filter: blur(8px);
  border: 1px solid var(--border);
  padding: 5px 12px;
  font-size: 0.75rem; color: var(--text-2);
  display: none;
  font-family: 'IBM Plex Sans', sans-serif;
}
.cache-status-badge.visible { display: block; }
.cache-status-badge.stale   { color: #b45309; border-color: #fcd34d; }
.cache-status-badge.fresh   { color: #065f46; border-color: #6ee7b7; }
.cache-status-badge.missing { color: #991b1b; border-color: #fca5a5; }
.refresh-btn {
  padding: 8px 18px;
  background: var(--text-1); color: #ffffff;
  border: none;
  font-family: 'IBM Plex Sans', sans-serif;
  font-weight: 500; font-size: 0.8125rem;
  cursor: pointer; transition: background 0.15s;
}
.refresh-btn:hover { background: var(--accent); }
.refresh-btn:disabled { background: var(--text-3); cursor: not-allowed; }
@keyframes spin-inline { to { transform: rotate(360deg); } }
.spinner-inline {
  display: inline-block; width: 11px; height: 11px;
  border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff;
  border-radius: 50%; animation: spin-inline 0.7s linear infinite;
  margin-right: 6px; vertical-align: middle;
}
`;

  // ── Helpers ───────────────────────────────────────────────────────────────
  function injectCSS(css) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildHeader(activeKey, title, subtitle, isLive) {
    const links = PAGES.map(p =>
      `<a href="${p.href}" class="nav-link${p.key === activeKey ? ' active' : ''}">${p.label}</a>`
    ).join('\n        ');

    const liveHTML = isLive
      ? `<div class="live-indicator"><div class="live-dot"></div>Live · Updates every 5 minutes · AEMO public data</div>`
      : '';

    return `
<header>
  <div class="header-inner">
    <div>
      <h1>${title}</h1>
      <p class="subtitle">${subtitle}</p>
      ${liveHTML}
    </div>
    <nav class="header-nav">
      ${links}
    </nav>
  </div>
</header>`;
  }

  function buildCacheBar() {
    return `
<div id="globalCacheBar">
  <span class="gcb-dot" id="gcbDot"></span>
  <span class="gcb-text" id="gcbText">Checking cache…</span>
  <button class="gcb-btn" id="gcbRefreshBtn" onclick="window.__navRefresh && window.__navRefresh()">Refresh</button>
</div>`;
  }

  function buildRefreshPanel() {
    return `
<div class="refresh-panel">
  <div id="cacheStatusBadge" class="cache-status-badge"></div>
  <button class="refresh-btn" id="refreshBtn"
    onclick="window.__navRefresh && window.__navRefresh()">Refresh Data</button>
</div>`;
  }

  // ── Global cache status logic ─────────────────────────────────────────────
  function initCacheBar() {
    const API_BASE = window.location.protocol === 'file:'
      ? 'http://localhost:3000'
      : window.location.origin;

    function ageHuman(m) {
      if (!m || m < 1) return 'just now';
      if (m < 60) return Math.round(m) + ' min ago';
      const h = Math.round(m / 60);
      return h < 24 ? h + ' hr ago' : Math.round(h / 24) + ' days ago';
    }

    async function loadCacheStatus() {
      try {
        const resp = await fetch(`${API_BASE}/api/cache-status`);
        if (!resp.ok) return;
        const status = await resp.json();
        const dot  = document.getElementById('gcbDot');
        const text = document.getElementById('gcbText');
        if (!dot || !text) return;

        if (!status.redisConfigured) {
          dot.className = 'gcb-dot miss';
          text.textContent = '⚠ Redis not configured — data caching disabled';
          return;
        }

        const entries  = status.entries || [];
        const present  = entries.filter(e => e.present);
        const ages     = present.map(e => e.ageMinutes).filter(n => n !== null);
        const maxAge   = ages.length ? Math.max(...ages) : null;
        const allOk    = entries.length > 0 && present.length === entries.length;
        const human    = maxAge !== null ? ageHuman(maxAge) : '—';

        // Update the legacy #cacheAge element if present
        const legacyAge = document.getElementById('cacheAge');
        if (legacyAge) legacyAge.textContent = human;

        if (!allOk) {
          dot.className = 'gcb-dot miss';
          text.textContent = '⚠ Some data not cached — click Refresh to populate';
        } else if (maxAge !== null && maxAge > 23 * 60) {
          dot.className = 'gcb-dot stale';
          text.textContent = `Cache stale — last updated ${human}`;
        } else {
          dot.className = 'gcb-dot fresh';
          text.textContent = `Data cached ${human}`;
        }
      } catch (e) {
        console.warn('[nav] cache-status:', e.message);
      }
    }

    // Expose refresh to pages via window.__navRefresh
    // Pages override this with their own refresh logic; if they don't, fallback to a full-refresh.
    if (!window.__navRefresh) {
      window.__navRefresh = async function () {
        const btn  = document.getElementById('gcbRefreshBtn');
        const btn2 = document.getElementById('refreshBtn');
        const badge = document.getElementById('cacheStatusBadge');
        if (btn)  { btn.disabled = true;  btn.innerHTML = '<span class="gcb-spinner"></span>Refreshing…'; }
        if (btn2) { btn2.disabled = true; btn2.innerHTML = '<span class="spinner-inline"></span>Refreshing…'; }
        if (badge){ badge.textContent = 'Refreshing all data…'; badge.className = 'cache-status-badge visible'; }

        try {
          await fetch(`${API_BASE}/api/refresh-all?force=true`);
          if (badge){ badge.textContent = '✓ Refreshed'; badge.className = 'cache-status-badge visible fresh'; }
          await loadCacheStatus();
          setTimeout(() => window.location.reload(), 800);
        } catch (e) {
          if (badge){ badge.textContent = '⚠ Refresh failed'; badge.className = 'cache-status-badge visible missing'; }
        } finally {
          if (btn)  { btn.disabled = false;  btn.textContent = 'Refresh'; }
          if (btn2) { btn2.disabled = false; btn2.textContent = 'Refresh Data'; }
        }
      };
    }

    loadCacheStatus();
    setInterval(loadCacheStatus, 5 * 60 * 1000);
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  function init() {
    // Read config from calling script tag's data attribute
    const scriptTag = document.currentScript;
    const activeKey = scriptTag ? (scriptTag.getAttribute('data-active') || '') : '';

    const title    = window.NAV_TITLE    || 'Australian Energy Dashboard';
    const subtitle = window.NAV_SUBTITLE || 'NEM market data and insights.';
    const isLive   = window.NAV_LIVE     !== undefined ? window.NAV_LIVE : false;

    // Inject CSS
    injectCSS(CSS);

    // Inject header into #site-nav placeholder
    const placeholder = document.getElementById('site-nav');
    if (placeholder) {
      placeholder.innerHTML = buildHeader(activeKey, title, subtitle, isLive);
    }

    // Inject cache bar and refresh panel into body if not already present
    if (!document.getElementById('globalCacheBar')) {
      document.body.insertAdjacentHTML('beforeend', buildCacheBar());
    }
    if (!document.querySelector('.refresh-panel')) {
      document.body.insertAdjacentHTML('beforeend', buildRefreshPanel());
    }

    // Init cache polling
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initCacheBar);
    } else {
      initCacheBar();
    }
  }

  // Run immediately (script is deferred until body, consistent with usage pattern)
  init();
})();
