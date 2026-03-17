import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

export const config = {
  runtime: 'nodejs',
};

const EXO_WATCHDOG_URL = (process.env.EXO_WATCHDOG_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');

export default async function handler(request) {
  const corsHeaders = getCorsHeaders(request, 'GET, OPTIONS');

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (isDisallowedOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const response = await fetch(`${EXO_WATCHDOG_URL}/status`, {
      headers: { 'Cache-Control': 'no-cache' },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload) {
      const detail = payload?.detail || payload?.error || `Watchdog error ${response.status}`;
      return new Response(JSON.stringify({ error: detail }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Failed to query watchdog',
    }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}
