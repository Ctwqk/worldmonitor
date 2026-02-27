import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { getCachedJson } from './_upstash-cache.js';

export const config = { runtime: 'edge' };

const CACHE_KEY = 'worldmonitor:hourly-news:latest';

export default async function handler(req) {
  const cors = getCorsHeaders(req, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  try {
    const cached = await getCachedJson(CACHE_KEY);

    if (!cached) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Hourly cache is empty',
        cacheKey: CACHE_KEY,
      }), {
        status: 503,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...cors,
        },
      });
    }

    const body = typeof cached === 'string' ? JSON.parse(cached) : cached;

    return new Response(JSON.stringify({ success: true, ...body }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=120, s-maxage=120, stale-while-revalidate=60',
        ...cors,
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to load hourly cache',
      details: error?.message || String(error),
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...cors,
      },
    });
  }
}
