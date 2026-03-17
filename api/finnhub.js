import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
export const config = { runtime: 'edge' };

const SYMBOL_PATTERN = /^[A-Za-z0-9.^]+$/;
const MAX_SYMBOLS = 20;
const MAX_SYMBOL_LENGTH = 10;

const IBKR_API = process.env.IBKR_QUOTES_URL || 'http://127.0.0.1:7700/api/ibkr';

function validateSymbols(symbolsParam) {
  if (!symbolsParam) return null;

  const symbols = symbolsParam
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(s => s.length <= MAX_SYMBOL_LENGTH && SYMBOL_PATTERN.test(s))
    .slice(0, MAX_SYMBOLS);

  return symbols.length > 0 ? symbols : null;
}

async function fetchQuote(symbol, apiKey) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`;
  const response = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  });

  if (!response.ok) {
    return { symbol, error: `HTTP ${response.status}` };
  }

  const data = await response.json();

  // Finnhub returns { c, d, dp, h, l, o, pc, t } where:
  // c = current price, d = change, dp = percent change
  // h = high, l = low, o = open, pc = previous close, t = timestamp
  if (data.c === 0 && data.h === 0 && data.l === 0) {
    return { symbol, error: 'No data available' };
  }

  return {
    symbol,
    price: data.c,
    change: data.d,
    changePercent: data.dp,
    high: data.h,
    low: data.l,
    open: data.o,
    previousClose: data.pc,
    timestamp: data.t,
  };
}

/**
 * Try IBKR for quotes — returns null if IBKR is unreachable
 */
async function fetchFromIBKR(symbols) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${IBKR_API}/quotes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(symbols),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return null;

    const data = await response.json();
    if (data.error) return null;

    // IBKR returns array of { symbol, last, bid, ask, high, low, open, close, volume, ... }
    // Map to finnhub-compatible format
    const quotes = [];
    for (const q of (Array.isArray(data) ? data : [])) {
      if (!q.symbol || !q.last) continue;
      const price = q.last;
      const prevClose = q.close || q.last;
      const change = price - prevClose;
      const changePercent = prevClose ? (change / prevClose) * 100 : 0;
      quotes.push({
        symbol: q.symbol,
        price,
        change: Math.round(change * 100) / 100,
        changePercent: Math.round(changePercent * 100) / 100,
        high: q.high || price,
        low: q.low || price,
        open: q.open || price,
        previousClose: prevClose,
        timestamp: Math.floor(Date.now() / 1000),
      });
    }
    return quotes.length > 0 ? quotes : null;
  } catch {
    return null;
  }
}

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    if (isDisallowedOrigin(req)) {
      return new Response(null, { status: 403, headers: corsHeaders });
    }
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  const url = new URL(req.url);
  const symbols = validateSymbols(url.searchParams.get('symbols'));

  if (!symbols) {
    return new Response(JSON.stringify({ error: 'Invalid or missing symbols parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  // Try IBKR first (free, no API key needed, just needs TWS running)
  const ibkrQuotes = await fetchFromIBKR(symbols);
  if (ibkrQuotes) {
    return new Response(JSON.stringify({ quotes: ibkrQuotes, provider: 'ibkr' }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=30, s-maxage=30, stale-while-revalidate=15',
        ...corsHeaders,
      },
    });
  }

  // Fallback to Finnhub
  const apiKey = process.env.FINNHUB_API_KEY;

  if (!apiKey) {
    return new Response(JSON.stringify({ quotes: [], skipped: true, reason: 'IBKR unavailable and FINNHUB_API_KEY not configured' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=30', ...corsHeaders },
    });
  }

  try {
    // Fetch all quotes in parallel (Finnhub allows 60 req/min on free tier)
    const quotes = await Promise.all(
      symbols.map(symbol => fetchQuote(symbol, apiKey))
    );

    return new Response(JSON.stringify({ quotes, provider: 'finnhub' }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=30, s-maxage=30, stale-while-revalidate=15',
        ...corsHeaders,
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Failed to fetch data' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
