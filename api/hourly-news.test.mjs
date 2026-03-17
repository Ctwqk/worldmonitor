import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('falls back to the local hourly cache file when shared cache is unavailable', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'wm-hourly-'));
  const cachePath = path.join(tempDir, 'hourly-news-cache.json');
  const payload = {
    generatedAt: '2026-03-11T19:00:00.000Z',
    fetchedItemCount: 3,
    postedItemCount: 1,
    items: [{ id: 'abc', title: 'Fallback item', source: 'example.com', link: 'https://example.com' }],
  };

  process.env.WM_CACHE_PATH = cachePath;
  process.env.LOCAL_API_MODE = '';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;

  await writeFile(cachePath, JSON.stringify(payload), 'utf8');

  const { default: handler } = await import(`./hourly-news.js?test=${Date.now()}`);
  const response = await handler(new Request('http://127.0.0.1:3000/api/hourly-news'));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.cacheSource, `file:${cachePath}`);
  assert.equal(body.items[0].title, 'Fallback item');
});
