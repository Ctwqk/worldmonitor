#!/usr/bin/env node

import http from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

const host = process.env.LOCAL_WEB_HOST || '127.0.0.1';
const webPort = Number(process.env.LOCAL_WEB_PORT || process.env.PORT || 3000);
const apiPort = Number(process.env.LOCAL_API_PORT || 46123);
const sidecarHost = process.env.LOCAL_API_HOST || '127.0.0.1';

const argSet = new Set(process.argv.slice(2));
const buildOnly = argSet.has('--build-only');
const serveOnly = argSet.has('--serve-only');
const shouldBuild = buildOnly || (!serveOnly && process.env.LOCAL_WEB_BUILD !== '0');

const appBaseUrl = process.env.VITE_PUBLIC_APP_BASE_URL || `http://${host}:${webPort}`;
const apiBaseUrl = process.env.VITE_TAURI_API_BASE_URL || `http://${sidecarHost}:${apiPort}`;
const localVariant = process.env.VITE_VARIANT || 'full';

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.wasm', 'application/wasm'],
]);

function normalizePathname(pathname) {
  return pathname.endsWith('/') ? `${pathname}index.html` : pathname;
}

function resolveAssetPath(pathname) {
  const normalized = pathname === '/' ? '/index.html' : normalizePathname(pathname);
  const decoded = decodeURIComponent(normalized);
  const safePath = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, '');
  return path.join(distDir, safePath);
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'unknown'}`));
    });
  });
}

async function ensureBuild() {
  if (shouldBuild) {
    const env = {
      ...process.env,
      VITE_ENABLE_VERCEL_ANALYTICS: process.env.VITE_ENABLE_VERCEL_ANALYTICS || '0',
      VITE_PUBLIC_APP_BASE_URL: appBaseUrl,
      VITE_PUBLIC_VARIANT_FULL_URL: process.env.VITE_PUBLIC_VARIANT_FULL_URL || (localVariant === 'full' ? appBaseUrl : ''),
      VITE_PUBLIC_VARIANT_TECH_URL: process.env.VITE_PUBLIC_VARIANT_TECH_URL || (localVariant === 'tech' ? appBaseUrl : ''),
      VITE_PUBLIC_VARIANT_FINANCE_URL: process.env.VITE_PUBLIC_VARIANT_FINANCE_URL || (localVariant === 'finance' ? appBaseUrl : ''),
      VITE_TAURI_API_BASE_URL: apiBaseUrl,
      VITE_TAURI_REMOTE_API_BASE_URL: process.env.VITE_TAURI_REMOTE_API_BASE_URL || appBaseUrl,
    };
    await runCommand('npm', ['run', 'build'], env);
    return;
  }

  if (!existsSync(distDir)) {
    throw new Error('dist/ not found. Run `npm run build:local` first or omit --serve-only.');
  }
}

async function waitForSidecar(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.request({
          host: sidecarHost,
          port: apiPort,
          path: '/api/service-status',
          method: 'GET',
          timeout: 1500,
        }, (res) => {
          res.resume();
          if ((res.statusCode || 500) < 500) {
            resolve();
            return;
          }
          reject(new Error(`sidecar status ${res.statusCode}`));
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.end();
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  throw new Error(`Timed out waiting for local API sidecar on ${sidecarHost}:${apiPort}`);
}

function startSidecar() {
  const env = {
    ...process.env,
    LOCAL_API_MODE: process.env.LOCAL_API_MODE || 'web-sidecar',
    LOCAL_API_PORT: String(apiPort),
    LOCAL_API_RESOURCE_DIR: process.env.LOCAL_API_RESOURCE_DIR || rootDir,
    LOCAL_API_REMOTE_BASE: process.env.LOCAL_API_REMOTE_BASE || appBaseUrl,
    LOCAL_API_CLOUD_FALLBACK: process.env.LOCAL_API_CLOUD_FALLBACK || 'false',
  };

  return spawn(process.execPath, ['src-tauri/sidecar/local-api-server.mjs'], {
    cwd: rootDir,
    env,
    stdio: 'inherit',
  });
}

function proxyApiRequest(req, res) {
  const forwardedHost = req.headers.host || `${host}:${webPort}`;
  const forwardedProto = process.env.LOCAL_WEB_PROTO || (appBaseUrl.startsWith('https://') ? 'https' : 'http');
  const upstream = http.request({
    host: sidecarHost,
    port: apiPort,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: `${host}:${webPort}`,
      'x-forwarded-host': forwardedHost,
      'x-forwarded-proto': forwardedProto,
    },
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstream.on('error', (error) => {
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Local API unavailable', reason: error.message }));
  });

  req.pipe(upstream);
}

async function serveAsset(req, res, pathname) {
  let assetPath = resolveAssetPath(pathname);
  if (!await pathExists(assetPath)) {
    assetPath = path.join(distDir, 'index.html');
  }

  const ext = path.extname(assetPath).toLowerCase();
  const contentType = MIME_TYPES.get(ext) || 'application/octet-stream';
  res.writeHead(200, { 'content-type': contentType });
  createReadStream(assetPath).pipe(res);
}

async function main() {
  await ensureBuild();

  if (buildOnly) {
    return;
  }

  const sidecar = startSidecar();
  let shuttingDown = false;
  let server = null;

  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!server) {
      if (!sidecar.killed) sidecar.kill('SIGTERM');
      process.exit(code);
      return;
    }
    server.close(() => {
      if (!sidecar.killed) sidecar.kill('SIGTERM');
      process.exit(code);
    });
  };

  sidecar.on('exit', (code) => {
    if (shuttingDown) return;
    console.error(`[local-web] sidecar exited with code ${code ?? 'unknown'}`);
    shutdown(code || 1);
  });

  await waitForSidecar();

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', appBaseUrl);

    if (url.pathname.startsWith('/api/')) {
      proxyApiRequest(req, res);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }

    try {
      await serveAsset(req, res, url.pathname);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(error instanceof Error ? error.message : 'Internal server error');
    }
  });

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(webPort, host, resolve);
  });

  console.log(`[local-web] serving ${distDir} on ${appBaseUrl}`);
  console.log(`[local-web] proxying /api/* to http://${sidecarHost}:${apiPort}`);
}

main().catch((error) => {
  console.error('[local-web] startup failed', error);
  process.exit(1);
});
