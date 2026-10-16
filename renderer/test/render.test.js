/**
 * The server renderer — renderer/render.js, on the real Konva and skia-canvas.
 *
 * The snapshot pins one scene's exact bytes, so a change to lib/, the fonts, Konva or
 * skia-canvas that moves a pixel shows up here. Whether those pixels match the editor's is a
 * browser question this suite can't answer; compare "See it dithered" with a render by eye
 * when any of those change. Update the snapshot with `npm run test:update`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FontLibrary, Canvas } from 'skia-canvas';

import { render, atTime, plan, MAX_SIDE } from '../render.js';
import { handler } from '../lambda.js';
import { FONT_FILES } from '../../public/js/lib/fonts.js';

const INK = '#2F2429', RED = '#D72627';
const display = { width: 128, height: 296, rotation: 0, panel: 'magtag', type: 'tricolor', dither: 'none', background: '#F2F4EF' };
// 2×2 red PNG, made by skia-canvas
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAsSAAALEgHS3X78AAAAAXNSR0IArs4c6QAAAARzQklUCAgICHwIZIgAAAAUSURBVAiZY7yupv6fgYGBgYkBCgAhGAInj0C5pwAAAABJRU5ErkJggg==';

const scene = (elements, extra = {}) => ({ version: 1, display: { background: '#F2F4EF' }, elements, ...extra });

const EVERYTHING = scene([
  { etype: 'label', x: 4, y: 4, text: '21.5C', fontSize: 16, fontFamily: 'IBM Plex Mono', fill: INK, feedKey: 'temp', feedValue: '21.47', feedDecimals: 1, feedSuffix: 'C' },
  { etype: 'datetime', x: 4, y: 26, timeFmt: '%H:%M', timeTz: 'UTC', fill: INK, fontSize: 12, fontFamily: 'IBM Plex Sans' },
  { etype: 'divider', x: 4, y: 44, width: 120, height: 2, fill: RED },
  { etype: 'linechart', x: 100, y: 50, w: 180, h: 60, ink: INK, title: 'Temp', data: [64, 63, 60, 64, 67, 71, 72, 75, 80, 80, 82, 78], axisFontFamily: 'IBM Plex Serif' },
  { etype: 'gauge', x: 4, y: 50, w: 80, ink: INK, gaugeValue: '42', gaugeLabel: 'mph', showIcon: true, icon: 'wind' },
  { etype: 'indicator', x: 260, y: 4, w: 16, ink: INK, onColor: RED, offColor: '#F2F4EF', op: 'gt', cmp: '1', value: '2' },
  { etype: 'battery', x: 230, y: 30, w: 40, ink: INK, showPct: true, feedValue: '80' },
  { etype: 'image', x: 240, y: 90, w: 20, h: 20, natW: 2, natH: 2, src: PIXEL },
]);
const NOON = Date.UTC(2026, 9, 12, 12, 0);

const header = (base64) => {
  const bmp = Buffer.from(base64, 'base64');
  return { magic: bmp.subarray(0, 2).toString(), width: bmp.readInt32LE(18), height: bmp.readInt32LE(22), bpp: bmp.readUInt16LE(28) };
};

test('every element type renders to a BMP the size of the panel', async () => {
  const out = await render({ doc: EVERYTHING, display, now: NOON });
  // a MagTag at rotation 0 is landscape
  assert.deepEqual([out.width, out.height], [296, 128]);
  assert.deepEqual(header(out.base64), { magic: 'BM', width: 296, height: 128, bpp: 4 });
  assert.equal(out.bytes, Buffer.from(out.base64, 'base64').length);
  assert.match(out.sha, /^[0-9a-f]{64}$/);
});

test('the same document renders to the same bytes', async (t) => {
  const a = await render({ doc: EVERYTHING, display, now: NOON });
  const b = await render({ doc: EVERYTHING, display, now: NOON });
  assert.equal(a.sha, b.sha);
  t.assert.snapshot(a.sha);
});

test('date & time: the element\'s zone, else the account\'s, else UTC', () => {
  const doc = scene([
    { etype: 'datetime', timeFmt: '%H:%M', timeTz: 'Asia/Tokyo' },
    { etype: 'datetime', timeFmt: '%H:%M', timeTz: '' },
    { etype: 'label', text: 'untouched' },
  ]);
  const at = (timeZone) => atTime(doc, { now: NOON, timeZone }).elements.map((el) => el.timeValue ?? el.text);
  assert.deepEqual(at('America/New_York'), ['21:00', '08:00', 'untouched']);
  assert.deepEqual(at('Not/AZone'), ['21:00', '12:00', 'untouched']);
});

test('the bundled faces are registered, and a picture changes with the font', async () => {
  const label = (fontFamily) => scene([{ etype: 'label', x: 4, y: 4, text: 'Hello 123', fontSize: 24, fontFamily, fill: INK }]);
  const mono = await render({ doc: label('IBM Plex Mono'), display });
  const serif = await render({ doc: label('IBM Plex Serif'), display });
  for (const { family } of FONT_FILES) assert.ok(FontLibrary.has(family), family);
  assert.notEqual(mono.sha, serif.sha);
});

test('an image is decoded from its data URL; an undecodable one is left out', async () => {
  const image = (src) => scene([{ etype: 'image', x: 0, y: 0, w: 40, h: 40, natW: 2, natH: 2, src }]);
  const blank = await render({ doc: scene([]), display });
  const drawn = await render({ doc: image(PIXEL), display });
  const broken = await render({ doc: image('data:image/png;base64,bm90IGFuIGltYWdl'), display });
  assert.notEqual(drawn.sha, blank.sha);
  assert.equal(broken.sha, blank.sha);
});

test('a feed image draws the picture read from its feed, and its placeholder without one (#36)', async () => {
  const frame = scene([{ etype: 'feedimage', x: 0, y: 0, w: 40, h: 40, fit: 'stretch', feedKey: 'cam', src: 'feed:cam' }]);
  const b64 = PIXEL.slice(PIXEL.indexOf(',') + 1);
  assert.deepEqual(plan({ doc: frame }).reads, [{ id: 'cam', feed: 'cam', kind: 'last' }]);
  const blank = await render({ doc: scene([]), display });
  const empty = await render({ doc: frame, display });
  const notAPicture = await render({ doc: frame, readings: { last: { cam: '21.5' } }, display });
  const drawn = await render({ doc: frame, readings: { last: { cam: b64 } }, display });
  assert.notEqual(empty.sha, blank.sha, 'an empty frame is drawn, not left out');
  assert.equal(notAPicture.sha, empty.sha);
  assert.notEqual(drawn.sha, empty.sha);
  // The reference is never fetched, whatever it says.
  const hostile = scene([{ etype: 'feedimage', x: 0, y: 0, w: 40, h: 40, feedKey: '', src: 'http://169.254.169.254/' }]);
  assert.equal((await render({ doc: hostile, display })).sha, empty.sha);
});

test('only pictures are dithered: text renders the same under every display dither', async () => {
  const text = scene([{ etype: 'label', x: 4, y: 4, text: 'Crisp text', fontSize: 20, fontFamily: 'IBM Plex Sans', fill: INK }]);
  const shas = new Set();
  for (const dither of ['FloydSteinberg', 'ordered', 'none']) {
    shas.add((await render({ doc: text, display: { ...display, dither, diffusion: 85, orderedMap: 8 } })).sha);
  }
  assert.equal(shas.size, 1);
});

test('a picture is dithered on its own, by its own setting or the display default', async () => {
  const c = new Canvas(32, 32);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 32, 0);
  grad.addColorStop(0, '#000000');
  grad.addColorStop(1, '#ffffff');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  const src = await c.toDataURL('png');
  const pic = (extra) => scene([{ etype: 'image', x: 0, y: 0, w: 64, h: 64, natW: 32, natH: 32, src, ...extra }]);
  const fs = { ...display, dither: 'FloydSteinberg', diffusion: 85 };
  const byDefault = await render({ doc: pic({}), display: fs });
  const ownNone = await render({ doc: pic({ dither: 'none' }), display: fs });
  const panelNone = await render({ doc: pic({}), display: { ...display, dither: 'none' } });
  assert.notEqual(byDefault.sha, ownNone.sha, "the picture's own setting wins over the display's");
  assert.equal(ownNone.sha, panelNone.sha);
});

test('the bitmap fonts draw on the server, from the same glyph tables as the editor', async () => {
  const label = (fontFamily) => scene([{ etype: 'label', x: 4, y: 4, text: '21.5', fontSize: 6, fontFamily, fill: INK }]);
  const blank = await render({ doc: scene([]), display });
  const thumb = await render({ doc: label('tom-thumb'), display });
  const gfx = await render({ doc: label('gfx-5x7'), display });
  const plex = await render({ doc: label('IBM Plex Mono'), display });
  assert.notEqual(thumb.sha, blank.sha);
  assert.notEqual(thumb.sha, gfx.sha);
  assert.notEqual(thumb.sha, plex.sha);
  assert.equal((await render({ doc: label('tom-thumb'), display })).sha, thumb.sha);
});

test('the display decides the palette: mono comes out 1 bit per pixel', async () => {
  const out = await render({ doc: EVERYTHING, display: { ...display, type: 'mono' }, now: NOON });
  assert.equal(header(out.base64).bpp, 1);
});

test('a bad request is an error, and the Lambda handler returns it rather than throwing', async () => {
  await assert.rejects(render({ doc: { elements: [] }, display }), /version 1/);
  await assert.rejects(render({ doc: scene([]), display: { width: 10 } }), /display/);
  assert.match((await handler({ doc: null })).error, /version 1/);
  assert.equal((await handler(JSON.stringify({ doc: scene([]), display }))).width, 296);
});

test('readings are written in before rendering; a missing one keeps the saved value', async () => {
  const doc = scene([
    { etype: 'label', x: 4, y: 4, fontSize: 24, fill: INK, feedKey: 'temp', feedValue: '20' },
    { etype: 'linechart', x: 4, y: 40, w: 200, h: 80, ink: INK, feeds: [{ key: 'temp' }], hours: 6, series: {} },
  ]);
  const saved = await render({ doc, display });
  assert.equal((await render({ doc, readings: {}, display })).sha, saved.sha);
  assert.equal((await render({ doc, readings: { last: { temp: null } }, display })).sha, saved.sha);

  const fresh = await render({ doc, readings: { last: { temp: '99' } }, display });
  assert.notEqual(fresh.sha, saved.sha);
  // The same reading baked into the document by hand draws the same picture.
  const baked = await render({ doc: { ...doc, elements: [{ ...doc.elements[0], feedValue: '99' }, doc.elements[1]] }, display });
  assert.equal(fresh.sha, baked.sha);

  const chart = { columns: ['date', 'value'], data: [['2026-10-12T10:00:00Z', '1'], ['2026-10-12T11:00:00Z', '5']] };
  const charted = await render({ doc, readings: { chart: { 'temp@6h': chart } }, display });
  assert.notEqual(charted.sha, saved.sha);
});

test('plan: what a document reads, through the handler too', async () => {
  const doc = scene([
    { etype: 'gauge', feedKey: 'wind' },
    { etype: 'linechart', feeds: [{ key: 'alice/hum' }], rawOnly: true },
    { etype: 'datetime' },
  ]);
  const expected = {
    reads: [
      { id: 'wind', feed: 'wind', kind: 'last' },
      { id: 'alice/hum@24h/raw', feed: 'alice/hum', kind: 'chart', hours: 24, raw: true, limit: 640 },
    ],
    datetime: true,
  };
  assert.deepEqual(plan({ doc }), expected);
  assert.deepEqual(await handler({ op: 'plan', doc }), expected);
  assert.match((await handler({ op: 'plan', doc: {} })).error, /version 1/);
  assert.match((await handler({ op: 'nope', doc })).error, /unknown op/);
});

test('hostile input: only data: images, and only panels the editor could make', async () => {
  const image = (src) => scene([{ etype: 'image', x: 0, y: 0, w: 40, h: 40, natW: 2, natH: 2, src }]);
  const blank = await render({ doc: scene([]), display });
  for (const src of ['http://169.254.169.254/latest/meta-data', 'file:///etc/passwd', '/etc/passwd']) {
    assert.equal((await render({ doc: image(src), display })).sha, blank.sha, src);
  }
  await assert.rejects(render({ doc: scene([]), display: { ...display, width: MAX_SIDE + 1 } }), /pixels a side/);
  await assert.rejects(render({ doc: scene([]), display: { ...display, height: 4.5 } }), /pixels a side/);
  await assert.rejects(render({ doc: scene([]), display: { ...display, type: 'rainbow' } }), /unknown display type/);
});

test('a chart\'s time axis reads in the account\'s zone, never the server\'s', async () => {
  const doc = scene([{ etype: 'linechart', x: 4, y: 4, w: 280, h: 110, ink: INK, feeds: [{ key: 't' }], hours: 6,
    series: { t: [{ t: '2026-10-12T10:00:00Z', v: 1 }, { t: '2026-10-12T14:00:00Z', v: 5 }] } }]);
  const tz = process.env.TZ;
  try {
    process.env.TZ = 'America/Chicago';
    const a = await render({ doc, display, timeZone: 'Europe/Berlin' });
    process.env.TZ = 'Asia/Tokyo';
    const b = await render({ doc, display, timeZone: 'Europe/Berlin' });
    const c = await render({ doc, display, timeZone: 'America/New_York' });
    assert.equal(a.sha, b.sha);
    assert.notEqual(b.sha, c.sha);
    // An unknown zone is UTC, not an error.
    assert.equal((await render({ doc, display, timeZone: 'Mars/Olympus' })).sha, (await render({ doc, display, timeZone: 'UTC' })).sha);
  } finally {
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
});
