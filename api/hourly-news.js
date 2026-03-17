import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { getCachedJson } from './_upstash-cache.js';

export const config = { runtime: 'nodejs' };

const CACHE_KEY = 'worldmonitor:hourly-news:latest';
const LOCAL_CACHE_CANDIDATES = [
  process.env.WM_CACHE_PATH,
  path.resolve(process.cwd(), 'news/hourly-news-cache.json'),
  path.resolve(process.cwd(), 'data/hourly-news-cache.json'),
  path.resolve(process.cwd(), '../worldmonitor-hourly/data/hourly-news-cache.json'),
].filter(Boolean);

async function loadLocalCache() {
  for (const filePath of LOCAL_CACHE_CANDIDATES) {
    try {
      const raw = await readFile(filePath, 'utf8');
      return {
        body: JSON.parse(raw),
        source: `file:${filePath}`,
      };
    } catch {
      // Keep trying the next candidate.
    }
  }
  return null;
}

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

    if (cached) {
      const body = typeof cached === 'string' ? JSON.parse(cached) : cached;
      return new Response(JSON.stringify({
        success: true,
        cacheKey: CACHE_KEY,
        cacheSource: 'shared-cache',
        ...body,
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=120, s-maxage=120, stale-while-revalidate=60',
          ...cors,
        },
      });
    }

    const local = await loadLocalCache();
    if (!local) {
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

    return new Response(JSON.stringify({
      success: true,
      cacheKey: CACHE_KEY,
      cacheSource: local.source,
      ...local.body,
    }), {
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
