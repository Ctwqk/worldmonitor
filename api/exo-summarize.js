/**
 * Exo summarization via exo-watchdog queue.
 * The browser still talks to this route; this route talks only to watchdog.
 */

import { randomUUID } from 'crypto';
import { getCachedJson, setCachedJson, hashString } from './_upstash-cache.js';
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

export const config = {
  runtime: 'nodejs',
};

const EXO_WATCHDOG_URL = (process.env.EXO_WATCHDOG_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const CACHE_TTL_SECONDS = 86400;
const WAIT_TIMEOUT_SECONDS = 25;
const WAIT_REQUEST_TIMEOUT_MS = 35000;
const CACHE_VERSION = 'v4';

function getCacheKey(headlines, mode, geoContext = '', variant = 'full', lang = 'en') {
  const sorted = headlines.slice(0, 8).sort().join('|');
  const geoHash = geoContext ? ':g' + hashString(geoContext).slice(0, 6) : '';
  const hash = hashString(`${mode}:${sorted}`);
  const normalizedVariant = typeof variant === 'string' && variant ? variant.toLowerCase() : 'full';
  const normalizedLang = typeof lang === 'string' && lang ? lang.toLowerCase() : 'en';

  if (mode === 'translate') {
    const targetLang = normalizedVariant || normalizedLang;
    return `summary:${CACHE_VERSION}:${mode}:${targetLang}:${hash}${geoHash}`;
  }

  return `summary:${CACHE_VERSION}:${mode}:${normalizedVariant}:${normalizedLang}:${hash}${geoHash}`;
}

function stripThink(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
}

async function fetchJsonWithTimeout(url, init = {}, timeoutMs = WAIT_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { ok: response.ok, status: response.status, data, text };
  } finally {
    clearTimeout(timeout);
  }
}

async function createWatchdogJob(payload) {
  const response = await fetchJsonWithTimeout(`${EXO_WATCHDOG_URL}/v1/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok || !response.data?.job?.id) {
    const detail = response.data?.detail || response.text || `Watchdog error ${response.status}`;
    throw new Error(detail);
  }

  return response.data.job.id;
}

async function waitForWatchdogJob(jobId) {
  while (true) {
    const response = await fetchJsonWithTimeout(
      `${EXO_WATCHDOG_URL}/v1/jobs/${jobId}/wait?timeout_seconds=${WAIT_TIMEOUT_SECONDS}`,
    );

    if (!response.ok) {
      const detail = response.data?.detail || response.text || `Watchdog wait error ${response.status}`;
      throw new Error(detail);
    }

    const job = response.data?.job;
    if (!job) {
      throw new Error('Watchdog wait returned no job payload');
    }

    if (job.status === 'queued' || job.status === 'running') {
      continue;
    }

    return job;
  }
}

function getClientRequestId(request) {
  return request.headers.get('x-client-request-id') || `worldmonitor-api:${randomUUID()}`;
}

export default async function handler(request) {
  const corsHeaders = getCorsHeaders(request, 'POST, OPTIONS');
  const clientRequestId = getClientRequestId(request);
  let watchdogJobId = null;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Client-Request-Id': clientRequestId },
    });
  }

  if (isDisallowedOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Client-Request-Id': clientRequestId },
    });
  }

  const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
  if (contentLength > 51200) {
    return new Response(JSON.stringify({ error: 'Payload too large' }), {
      status: 413,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Client-Request-Id': clientRequestId },
    });
  }

  try {
    const { headlines, mode = 'brief', geoContext = '', variant = 'full', lang = 'en' } = await request.json();

    if (!headlines || !Array.isArray(headlines) || headlines.length === 0) {
      return new Response(JSON.stringify({ error: 'Headlines array required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Client-Request-Id': clientRequestId },
      });
    }

    const cacheKey = getCacheKey(headlines, mode, geoContext, variant, lang);
    const cached = await getCachedJson(cacheKey);
    if (cached && typeof cached === 'object' && cached.summary) {
      return new Response(JSON.stringify({
        summary: cached.summary,
        model: cached.model || 'unknown',
        provider: 'cache',
        cached: true,
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'X-Client-Request-Id': clientRequestId,
        },
      });
    }

    watchdogJobId = await createWatchdogJob({
      kind: 'chat_completion',
      source: 'worldmonitor-api',
      profile: mode === 'translate' ? 'ui_translate' : 'ui_summary',
      client_request_id: clientRequestId,
      input: { headlines, mode, geoContext, variant, lang },
    });
    const job = await waitForWatchdogJob(watchdogJobId);

    if (job.status !== 'completed') {
      const message = job.error?.message || 'Watchdog job failed';
      return new Response(JSON.stringify({ error: message, fallback: true }), {
        status: 502,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'X-Client-Request-Id': clientRequestId,
          ...(watchdogJobId ? { 'X-Watchdog-Job-Id': watchdogJobId } : {}),
        },
      });
    }

    const responsePayload = job.result?.response;
    const model = job.result?.model || responsePayload?.model || 'unknown';
    const summary = stripThink(responsePayload?.choices?.[0]?.message?.content);

    if (!summary) {
      return new Response(JSON.stringify({ error: 'Empty response', fallback: true }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'X-Client-Request-Id': clientRequestId,
          ...(watchdogJobId ? { 'X-Watchdog-Job-Id': watchdogJobId } : {}),
        },
      });
    }

    await setCachedJson(cacheKey, {
      summary,
      model,
      timestamp: Date.now(),
    }, CACHE_TTL_SECONDS);

    return new Response(JSON.stringify({
      summary,
      model,
      provider: 'exo',
      cached: false,
      tokens: responsePayload?.usage?.total_tokens || 0,
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=1800, s-maxage=1800, stale-while-revalidate=300',
        'X-Client-Request-Id': clientRequestId,
        ...(watchdogJobId ? { 'X-Watchdog-Job-Id': watchdogJobId } : {}),
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: error.message || 'Watchdog request failed',
      errorType: error.name || 'Error',
      fallback: true,
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'X-Client-Request-Id': clientRequestId,
        ...(watchdogJobId ? { 'X-Watchdog-Job-Id': watchdogJobId } : {}),
      },
    });
  }
}
