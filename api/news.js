/**
 * news.js — Fetch real Australian energy news via GNews API.
 *
 * Caching strategy:
 *   Results are stored in Upstash Redis for 24 hours.
 *   Pass ?force=true to bypass the cache and fetch fresh data.
 *   The nightly cron (/api/refresh-all-cron) pre-populates this cache.
 *
 * Requires: GNEWS_API_KEY environment variable (free at https://gnews.io)
 * Free tier: 100 requests/day. With daily caching only 1 req/day is used.
 */

const { withCache, CACHE_KEYS } = require('./_cache');

async function fetchNews() {
  const GNEWS_API_KEY = process.env.GNEWS_API_KEY;

  if (!GNEWS_API_KEY) {
    return {
      success: true,
      articles: [{
        source: 'Setup Required',
        time: 'Now',
        title: 'Add GNEWS_API_KEY to see real energy news',
        excerpt: 'Get a free API key at gnews.io (100 requests/day) and add it to your Vercel environment variables as GNEWS_API_KEY.',
        url: 'https://gnews.io/',
        categories: ['Setup'],
        publishedAt: new Date().toISOString(),
      }],
      fetchedAt: new Date().toISOString(),
      source: 'Fallback — GNEWS_API_KEY not set',
      count: 1,
    };
  }

  const url = new URL('https://gnews.io/api/v4/search');
  url.searchParams.set('q', 'Australian energy electricity renewable solar wind');
  url.searchParams.set('lang', 'en');
  url.searchParams.set('country', 'au');
  url.searchParams.set('max', '8');
  url.searchParams.set('sortby', 'publishedAt');
  url.searchParams.set('apikey', GNEWS_API_KEY);

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 8000);

  const response = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    signal: controller.signal,
  });
  clearTimeout(tid);

  if (!response.ok) throw new Error(`GNews returned ${response.status}`);

  const data = await response.json();
  if (!data.articles || data.articles.length === 0) {
    throw new Error('No articles in GNews response');
  }

  const articles = data.articles.map(a => ({
    source: mapSource(a.source),
    time: timeAgo(new Date(a.publishedAt)),
    title: a.title,
    excerpt: a.description || a.title,
    url: a.url,
    categories: categorise(a.title + ' ' + (a.description || '')),
    publishedAt: a.publishedAt,
    image: a.image || null,
  }));

  return {
    success: true,
    articles,
    fetchedAt: new Date().toISOString(),
    source: 'GNews API',
    count: articles.length,
  };
}

module.exports = withCache(CACHE_KEYS.NEWS, fetchNews);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mapSource(source) {
  if (!source) return 'News';
  const u = (source.url || '').toLowerCase();
  const n = source.name || '';
  if (u.includes('afr.com')) return 'Australian Financial Review';
  if (u.includes('abc.net.au')) return 'ABC News';
  if (u.includes('smh.com.au')) return 'Sydney Morning Herald';
  if (u.includes('theage.com.au')) return 'The Age';
  if (u.includes('theguardian.com')) return 'The Guardian Australia';
  if (u.includes('reneweconomy.com')) return 'RenewEconomy';
  if (u.includes('aemo.com.au')) return 'AEMO';
  if (u.includes('energynewsbulletin')) return 'Energy News Bulletin';
  if (u.includes('pv-magazine')) return 'PV Magazine';
  return n || 'News';
}

function timeAgo(date) {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 60) return mins <= 1 ? 'Just now' : `${mins} minutes ago`;
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  if (days === 1) return '1 day ago';
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

function categorise(text) {
  const t = text.toLowerCase();
  const cats = [];
  if (/\b(solar|wind|renewable|hydro|battery|storage)\b/.test(t)) cats.push('Renewable');
  if (/\b(coal|gas|fossil|oil)\b/.test(t)) cats.push('Fossil Fuels');
  if (/\b(price|cost|bill|tariff|spot)\b/.test(t)) cats.push('Pricing');
  if (/\b(grid|transmission|network|interconnector)\b/.test(t)) cats.push('Infrastructure');
  if (/\b(policy|government|regulation|minister|legislation)\b/.test(t)) cats.push('Policy');
  if (/\b(market|trading|aemo|nem|dispatch)\b/.test(t)) cats.push('Market');
  if (cats.length === 0) cats.push('Energy');
  return cats.slice(0, 3);
}
