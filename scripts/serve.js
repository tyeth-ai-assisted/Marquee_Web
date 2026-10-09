#!/usr/bin/env node
/**
 * Local development server: the static app plus the photo importer Worker.
 *
 * The app is plain static files (public/), but browsers refuse to load ES modules
 * over file://, so it has to come from some HTTP server. Serving public/ needs no
 * dependencies, so `npm start` keeps working without installing anything.
 *
 * The album builder also calls the Cloudflare Worker in worker/ at the same-origin
 * route /api/albums/*. When `npm ci` has installed miniflare (a dev dependency), this
 * server runs that Worker in the real workerd runtime and forwards /api/albums/*
 * to it, so pasted album and image URLs -- including the public Google Photos,
 * iCloud Photos and Flickr test albums -- discover and download locally exactly as
 * they do in production, with no CORS, APP_ORIGIN or separate `wrangler dev` setup.
 * Without miniflare the route answers 503 and local uploads still work.
 *
 *   node scripts/serve.js            # http://localhost:3000
 *   PORT=8080 node scripts/serve.js
 *   ALBUM_IMPORTER=0 node scripts/serve.js   # static files only
 *
 * Optional Worker settings are read from the environment: IMPORT_SECRET (a random
 * per-process secret is generated otherwise; import links only need to outlive this
 * process), FLICKR_API_KEY and ALLOWED_HOSTS. Restart to pick up Worker code changes.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.join(REPO, 'public');
const PORT = Number(process.env.PORT) || 3000;
const IMPORTER_PREFIX = '/api/albums/';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

/** Start the importer Worker in Miniflare, or explain why URL imports are off. */
async function startImporter() {
  if (process.env.ALBUM_IMPORTER === '0') return { mf: null, reason: 'ALBUM_IMPORTER=0' };
  let Miniflare;
  try {
    ({ Miniflare } = await import('miniflare'));
  } catch {
    return { mf: null, reason: 'miniflare is not installed; run `npm ci` and restart' };
  }
  const bindings = {
    // Tokens signed with this secret expire after 15 minutes and are only ever
    // verified by this process, so a fresh random secret per run is enough.
    IMPORT_SECRET: process.env.IMPORT_SECRET || crypto.randomBytes(32).toString('hex'),
  };
  // APP_ORIGIN stays unset: requests arrive same-origin through this server, so the
  // Worker's origin gate and CORS headers never come into play locally.
  for (const name of ['FLICKR_API_KEY', 'ALLOWED_HOSTS'])
    if (process.env[name]) bindings[name] = process.env[name];
  const mf = new Miniflare({
    // Relative paths under rootPath: workerd rejects absolute module roots on Windows.
    rootPath: REPO,
    modules: true,
    scriptPath: 'worker/index.js',
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    compatibilityDate: '2026-07-30',
    bindings,
  });
  await mf.ready;
  return { mf, reason: '' };
}

/** Forward one /api/albums/* request to the Worker and relay its response. */
async function forward(mf, req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    // Hop-by-hop and length headers are recomputed by fetch for the new request.
    if (['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive'].includes(name)) continue;
    if (typeof value === 'string') headers[name] = value;
  }
  const upstream = await mf.dispatchFetch(`http://${req.headers.host || `localhost:${PORT}`}${req.url}`, {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
  });
  const out = {};
  upstream.headers.forEach((value, name) => { out[name] = value; });
  res.writeHead(upstream.status, out);
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

const importer = await startImporter();

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith(IMPORTER_PREFIX)) {
    if (!importer.mf) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: `URL imports are off in this local server (${importer.reason}). Local uploads still work.` }));
      return;
    }
    try {
      await forward(importer.mf, req, res);
    } catch (e) {
      console.error('importer:', e.message || e);
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'The local importer Worker failed. See the npm start terminal.' }));
    }
    return;
  }
  let urlPath = decodeURIComponent(url.pathname);
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`marquee editor on http://localhost:${PORT}  (static files from ${path.relative(process.cwd(), ROOT) || '.'})`);
  console.log(importer.mf
    ? `photo importer Worker on http://localhost:${PORT}${IMPORTER_PREFIX}*  (worker/ in Miniflare; URL imports work locally)`
    : `photo importer Worker off: ${importer.reason}. URL imports answer 503; local uploads still work.`);
});
