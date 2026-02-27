#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const CACHE_KEY = 'worldmonitor:hourly-news:latest';
const DEFAULT_STATE_PATH = resolve(process.cwd(), 'data/hourly-news-state.json');
const DEFAULT_CACHE_PATH = resolve(process.cwd(), 'data/hourly-news-cache.json');
const DEFAULT_CONFIG_FILES = [
  'src/config/feeds.ts',
  'src/config/variants/base.ts',
  'src/config/variants/tech.ts',
  'src/config/variants/finance.ts',
];

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const intervalMinutes = clampNumber(
  Number(args['interval-minutes'] ?? process.env.WM_INTERVAL_MINUTES ?? 60),
  5,
  24 * 60,
  60,
);

const config = {
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || process.env.WM_DISCORD_WEBHOOK_URL || '',
  statePath: resolve(process.cwd(), args['state-path'] || process.env.WM_STATE_PATH || DEFAULT_STATE_PATH),
  cachePath: resolve(process.cwd(), args['cache-path'] || process.env.WM_CACHE_PATH || DEFAULT_CACHE_PATH),
  maxFeeds: clampNumber(Number(process.env.WM_MAX_FEEDS || 180), 1, 1000, 180),
  concurrency: clampNumber(Number(process.env.WM_FETCH_CONCURRENCY || 8), 1, 32, 8),
  itemsPerFeed: clampNumber(Number(process.env.WM_ITEMS_PER_FEED || 5), 1, 20, 5),
  maxPostItems: clampNumber(Number(process.env.WM_MAX_POST_ITEMS || 15), 1, 50, 15),
  lookbackHours: clampNumber(Number(process.env.WM_LOOKBACK_HOURS || 24), 1, 24 * 14, 24),
  retainHours: clampNumber(Number(process.env.WM_RETAIN_HOURS || 24 * 7), 24, 24 * 60, 24 * 7),
  feedUrlsOverride: (process.env.WM_FEED_URLS || '').trim(),
  dryRun: Boolean(args['dry-run']),
};

if (!config.discordWebhookUrl && !config.dryRun) {
  console.error('[Hourly] Missing DISCORD_WEBHOOK_URL (or WM_DISCORD_WEBHOOK_URL)');
  process.exit(1);
}

if (args.loop) {
  await runOnce(config);
  setInterval(() => {
    runOnce(config).catch((err) => console.error('[Hourly] Loop run failed:', err?.message || err));
  }, intervalMinutes * 60 * 1000);
  console.log(`[Hourly] Loop started. Interval: ${intervalMinutes} minutes`);
} else {
  const ok = await runOnce(config);
  process.exit(ok ? 0 : 1);
}

async function runOnce(config) {
  const startedAt = Date.now();
  const feedUrls = loadFeedUrls(config.feedUrlsOverride, config.maxFeeds);
  console.log(`[Hourly] Loaded ${feedUrls.length} feed URLs`);

  const items = await fetchAllFeeds(feedUrls, {
    concurrency: config.concurrency,
    itemsPerFeed: config.itemsPerFeed,
  });

  const state = loadState(config.statePath);
  pruneState(state, config.retainHours);

  const now = Date.now();
  const lookbackMs = config.lookbackHours * 60 * 60 * 1000;
  const selected = items
    .filter((item) => now - item.pubDateMs <= lookbackMs)
    .filter((item) => !state.sent[item.id])
    .sort((a, b) => b.pubDateMs - a.pubDateMs)
    .slice(0, config.maxPostItems);

  const payload = {
    generatedAt: new Date(now).toISOString(),
    fetchedAt: new Date(startedAt).toISOString(),
    fetchedFeedCount: feedUrls.length,
    fetchedItemCount: items.length,
    postedItemCount: selected.length,
    items: selected.map((item) => ({
      id: item.id,
      source: item.source,
      title: item.title,
      link: item.link,
      pubDate: new Date(item.pubDateMs).toISOString(),
    })),
  };

  writeJson(config.cachePath, payload);

  if (selected.length === 0) {
    console.log('[Hourly] No new items to post');
    await writeRemoteCache(payload);
    return true;
  }

  const content = buildDiscordMessage(payload.items, payload.generatedAt);
  if (config.dryRun) {
    console.log('[Hourly] DRY RUN: message preview');
    console.log(content);
  } else {
    await postToDiscord(config.discordWebhookUrl, content);
    console.log(`[Hourly] Posted ${selected.length} items to Discord`);
  }

  for (const item of selected) {
    state.sent[item.id] = now;
  }
  state.lastRunAt = now;
  state.lastPostedCount = selected.length;
  writeJson(config.statePath, state);

  await writeRemoteCache(payload);
  return true;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--loop') {
      out.loop = true;
      continue;
    }
    if (token === '--dry-run') {
      out['dry-run'] = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      out.help = true;
      continue;
    }
    if (token.startsWith('--')) {
      const [key, value] = token.slice(2).split('=');
      if (value !== undefined) {
        out[key] = value;
      } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        out[key] = argv[i + 1];
        i += 1;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

function printHelp() {
  console.log(`worldmonitor-hourly\n\nUsage:\n  node scripts/worldmonitor-hourly.mjs [--loop] [--dry-run] [--interval-minutes=60]\n\nEnv:\n  DISCORD_WEBHOOK_URL / WM_DISCORD_WEBHOOK_URL  Discord webhook\n  WM_FEED_URLS                                 Comma-separated RSS URLs override\n  WM_MAX_FEEDS                                 Max feed URLs to fetch (default 180)\n  WM_FETCH_CONCURRENCY                         Concurrent fetches (default 8)\n  WM_ITEMS_PER_FEED                            Items parsed per feed (default 5)\n  WM_MAX_POST_ITEMS                            Max Discord items per run (default 15)\n  WM_STATE_PATH / WM_CACHE_PATH                Local state/cache paths\n  WM_LOOKBACK_HOURS                            Freshness window (default 24)\n  UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN  Optional cache write for /api/hourly-news\n`);
}

function clampNumber(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function loadFeedUrls(override, maxFeeds) {
  if (override) {
    return dedupeUrls(override.split(',').map((v) => v.trim()).filter(Boolean)).slice(0, maxFeeds);
  }

  const urls = [];
  const pattern = /(?:railwayRss|rss)\(\s*['"`]([^'"`]+)['"`]\s*\)/g;

  for (const relativePath of DEFAULT_CONFIG_FILES) {
    const fullPath = resolve(process.cwd(), relativePath);
    if (!existsSync(fullPath)) continue;
    const body = readFileSync(fullPath, 'utf8');
    let match;
    while ((match = pattern.exec(body)) !== null) {
      if (match[1]) urls.push(match[1]);
    }
  }

  return dedupeUrls(urls).slice(0, maxFeeds);
}

function dedupeUrls(urls) {
  const out = [];
  const seen = new Set();
  for (const raw of urls) {
    try {
      const normalized = new URL(raw).toString();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    } catch {
      // ignore invalid URL
    }
  }
  return out;
}

async function fetchAllFeeds(feedUrls, options) {
  const { concurrency, itemsPerFeed } = options;
  const queue = [...feedUrls];
  const items = [];

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const url = queue.shift();
      if (!url) break;
      try {
        const feedItems = await fetchFeed(url, itemsPerFeed);
        items.push(...feedItems);
      } catch {
        // per-feed failures are non-fatal
      }
    }
  });

  await Promise.all(workers);

  const deduped = [];
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
  }

  return deduped;
}

async function fetchFeed(url, limit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'WorldMonitor-Hourly/1.0',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!response.ok) return [];
    const text = await response.text();
    const source = safeHostname(url);
    return parseFeedItems(text, source, limit);
  } finally {
    clearTimeout(timeout);
  }
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

function parseFeedItems(xml, source, limit) {
  const rssBlocks = extractBlocks(xml, 'item');
  const atomBlocks = rssBlocks.length > 0 ? [] : extractBlocks(xml, 'entry');
  const blocks = rssBlocks.length > 0 ? rssBlocks : atomBlocks;
  const isAtom = rssBlocks.length === 0;

  const out = [];
  for (const block of blocks.slice(0, limit)) {
    const title = decodeHtml(stripTags(firstMatch(block, isAtom ? ['title'] : ['title']) || '')).trim();
    if (!title) continue;

    let link = '';
    if (isAtom) {
      link = firstMatch(block, ['link href="([^"]+)"', "link href='([^']+)'"]) || '';
      if (!link) {
        link = decodeHtml(stripTags(firstMatch(block, ['link']) || '')).trim();
      }
    } else {
      link = decodeHtml(stripTags(firstMatch(block, ['link', 'guid']) || '')).trim();
    }

    const guid = decodeHtml(stripTags(firstMatch(block, ['guid', 'id']) || '')).trim();
    const dateRaw = decodeHtml(stripTags(firstMatch(block, ['pubDate', 'published', 'updated']) || '')).trim();
    const pubDateMs = parseDateMs(dateRaw);
    const identity = (link || guid || title).trim().toLowerCase();
    if (!identity) continue;

    out.push({
      id: stableHash(`${source}|${identity}`),
      source,
      title,
      link,
      pubDateMs,
    });
  }

  return out;
}

function extractBlocks(xml, tag) {
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  const out = [];
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    out.push(match[1]);
  }
  return out;
}

function firstMatch(block, tagsOrPatterns) {
  for (const entry of tagsOrPatterns) {
    if (entry.includes('(')) {
      const re = new RegExp(entry, 'i');
      const m = block.match(re);
      if (m?.[1]) return m[1];
      continue;
    }

    const re = new RegExp(`<${entry}[^>]*>([\\s\\S]*?)</${entry}>`, 'i');
    const m = block.match(re);
    if (m?.[1]) return m[1];
  }
  return '';
}

function stripTags(input) {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtml(input) {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/gi, '/');
}

function parseDateMs(raw) {
  const ms = Date.parse(raw);
  if (Number.isFinite(ms)) return ms;
  return Date.now();
}

function stableHash(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(36);
}

function loadState(statePath) {
  if (!existsSync(statePath)) {
    return { lastRunAt: 0, lastPostedCount: 0, sent: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    return {
      lastRunAt: Number(parsed?.lastRunAt || 0),
      lastPostedCount: Number(parsed?.lastPostedCount || 0),
      sent: typeof parsed?.sent === 'object' && parsed.sent ? parsed.sent : {},
    };
  } catch {
    return { lastRunAt: 0, lastPostedCount: 0, sent: {} };
  }
}

function pruneState(state, retainHours) {
  const cutoff = Date.now() - retainHours * 60 * 60 * 1000;
  for (const [key, ts] of Object.entries(state.sent)) {
    if (!Number.isFinite(Number(ts)) || Number(ts) < cutoff) {
      delete state.sent[key];
    }
  }
}

function writeJson(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8');
}

function buildDiscordMessage(items, generatedAtIso) {
  const lines = [];
  lines.push(`WorldMonitor Hourly Update (${generatedAtIso})`);
  lines.push('');

  for (const item of items) {
    const title = truncate(item.title.replace(/\s+/g, ' ').trim(), 180);
    const source = item.source;
    const line = `- [${source}] ${title}${item.link ? `\n  ${item.link}` : ''}`;
    lines.push(line);
  }

  let content = lines.join('\n');
  if (content.length > 1900) {
    content = `${content.slice(0, 1850)}\n...`;
  }
  return content;
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

async function postToDiscord(webhookUrl, content) {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Discord webhook failed (${response.status}): ${body.slice(0, 300)}`);
  }
}

async function writeRemoteCache(payload) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return;
  }

  try {
    const endpoint = `${url.replace(/\/$/, '')}/set/${encodeURIComponent(CACHE_KEY)}`;
    await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([JSON.stringify(payload), 'EX', 60 * 60 * 24 * 3]),
    });
  } catch (err) {
    console.warn('[Hourly] Upstash cache write failed:', err?.message || String(err));
  }
}
