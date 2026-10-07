/**
 * An image feed, for real — the account's `drop-image` feed on io.adafruit.com, read the
 * way feeds.js reads it and parsed the way the feed image element parses it.
 *
 * Needs the network AND credentials, so it is doubly opt-in and stays out of `npm test`:
 *
 *   IO_LIVE=1 IO_USERNAME=… IO_KEY=… npm test
 *
 * or put IO_USERNAME / IO_KEY in a .env at the repo root (gitignored) and run with IO_LIVE=1;
 * the loader below reads it. IO_IMAGE_FEED overrides the feed key (default drop-image).
 *
 * The feed is expected to have history OFF, like every image feed must — history caps a
 * datum at 1 KB and no picture fits — and to hold at least one picture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseFeedImage } from '../public/js/core/feedimage.js';
import { IO_MAX_NO_HISTORY } from '../public/js/core/api.js';
import { syntheticBmp } from './helpers/bmp.js';

// A six-line .env reader, so the test needs nothing installed.
function loadDotEnv() {
  for (const dir of [process.cwd(), path.resolve(process.cwd(), '..', '..', '..')]) {
    const file = path.join(dir, '.env');
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return;
  }
}
loadDotEnv();

const user = process.env.IO_USERNAME, key = process.env.IO_KEY;
const feed = process.env.IO_IMAGE_FEED || 'drop-image';
const skip = !process.env.IO_LIVE ? 'set IO_LIVE=1 to run'
  : !(user && key) ? 'IO_USERNAME and IO_KEY are needed (env or .env)' : false;

const url = (suffix) => `https://io.adafruit.com/api/v2/${encodeURIComponent(user)}/feeds/${encodeURIComponent(feed)}${suffix}`;
const get = (suffix) => fetch(url(suffix), { headers: { 'X-AIO-Key': key } });

test('the image feed has history off — the only configuration a picture fits', { skip }, async () => {
  const res = await get('');
  assert.equal(res.status, 200);
  const rec = await res.json();
  assert.equal(rec.history, false, 'an image feed must have history OFF (1 KB cap otherwise)');
});

test('/data?limit=1 — the read feeds.js prefers — returns the current picture on a history-off feed', { skip }, async () => {
  const res = await get('/data?limit=1');
  assert.equal(res.status, 200);
  const rows = await res.json();
  assert.ok(Array.isArray(rows) && rows.length === 1, JSON.stringify(rows).slice(0, 200));
  const r = parseFeedImage(rows[0].value);
  assert.equal(r.ok, true, `reason: ${r.reason}`);
  assert.ok(['image/png', 'image/jpeg', 'image/gif', 'image/bmp'].includes(r.mime), r.mime);
  assert.ok(r.bytes > 0 && rows[0].value.length <= IO_MAX_NO_HISTORY);
});

test('/data/last agrees with /data?limit=1 on value and timestamp (ids are per-request on history-off feeds)', { skip }, async () => {
  const [a, b] = await Promise.all([get('/data?limit=1'), get('/data/last')]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const [row] = await a.json();
  const last = await b.json();
  assert.equal(last.value, row.value);
  assert.equal(last.created_at, row.created_at);
});

test('the browser can read it: CORS is open on the data endpoints', { skip }, async () => {
  const res = await fetch(url('/data?limit=1'), { headers: { 'X-AIO-Key': key, Origin: 'http://localhost:3000' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

// ---- the ceiling, enforced by IO itself ----------------------------------------------
//
// Publishes a picture that is over the limit and asserts IO refuses it AND that the feed's
// current picture survived the attempt. This is a WRITE to the feed; it is still safe to run
// because a rejected datum changes nothing, which the second assertion checks.

test('IO rejects a 410 KB bitmap on the history-off feed with a 422, and the feed keeps its picture', { skip }, async () => {
  const before = (await (await get('/data?limit=1')).json())[0];

  const big = syntheticBmp(400, 342).toString('base64');
  assert.ok(big.length > IO_MAX_NO_HISTORY);
  const res = await fetch(url('/data'), {
    method: 'POST',
    headers: { 'X-AIO-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: big }),
  });
  // Checked on 2026-10-06 with the real 410 KB file: 422, "value cannot be larger than
  // 524288 bytes (512 KB) when feed history is off. 546336 bytes received".
  assert.equal(res.status, 422);
  const body = await res.json().catch(() => ({}));
  assert.match(String(body.error || ''), /524288|512 KB/, JSON.stringify(body));

  const after = (await (await get('/data?limit=1')).json())[0];
  assert.equal(after.value, before.value, 'the rejected datum must not have replaced the picture');
  assert.equal(after.created_at, before.created_at);
});
