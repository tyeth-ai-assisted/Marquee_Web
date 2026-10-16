/**
 * Feed bindings on a saved document — public/js/lib/bindings.js.
 *
 * The editor's refresh and a server's live take both go through this module, so these
 * tests pin the contract a server host (Adafruit IO, via renderer/) builds against: which
 * reads a scene asks for, how they are keyed, and how readings land in the document.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHART_RAW_MAX, feedReads, bakeReadings, chartPoints, chartReadId, downsample, mergeSeries,
} from '../public/js/lib/bindings.js';
import { sameDesign } from '../public/js/lib/samples.js';

const doc = (...elements) => ({ version: 1, display: { type: 'mono', width: 128, height: 296 }, elements });

const SCENE = doc(
  { etype: 'label', feedKey: 'temp', feedValue: '20', feedSuffix: 'C', text: '20C' },
  { etype: 'label', text: 'Plain' },
  { etype: 'gauge', feedKey: 'wind', gaugeValue: '3' },
  { etype: 'indicator', feedKey: 'door', value: '0' },
  { etype: 'battery', feedKey: 'temp', feedValue: '20' },
  { etype: 'linechart', w: 4, feeds: [{ key: 'temp' }, { key: 'alice/hum' }], hours: 6, series: {} },
  { etype: 'linechart', w: 100, feeds: [{ key: 'temp' }], rawOnly: true },
  { etype: 'datetime', timeFmt: '%H:%M' },
  { etype: 'divider' },
);

test('feedReads: one read per feed and window, keyed for the readings map', () => {
  const { reads, datetime } = feedReads(SCENE);
  assert.equal(datetime, true);
  assert.deepEqual(reads, [
    { id: 'temp', feed: 'temp', kind: 'last' },
    { id: 'wind', feed: 'wind', kind: 'last' },
    { id: 'door', feed: 'door', kind: 'last' },
    { id: 'temp@6h', feed: 'temp', kind: 'chart', hours: 6, raw: false },
    { id: 'alice/hum@6h', feed: 'alice/hum', kind: 'chart', hours: 6, raw: false },
    { id: 'temp@24h/raw', feed: 'temp', kind: 'chart', hours: 24, raw: true, limit: CHART_RAW_MAX },
  ]);
});

test('feedReads: an unbound scene reads nothing', () => {
  assert.deepEqual(feedReads(doc({ etype: 'label', text: 'hi' }, { etype: 'linechart', feeds: [], data: [1, 2] })),
    { reads: [], datetime: false });
  assert.deepEqual(feedReads(null), { reads: [], datetime: false });
});

test('bakeReadings: each etype gets its reading in its own attr', () => {
  const out = bakeReadings(SCENE, { last: { temp: 21.5, wind: '7', door: '1' } });
  assert.equal(out.elements[0].feedValue, '21.5');
  assert.equal(out.elements[2].gaugeValue, '7');
  assert.equal(out.elements[3].value, '1');
  assert.equal(out.elements[4].feedValue, '21.5');
  // Unbound elements pass through untouched, as the same object.
  assert.equal(out.elements[1], SCENE.elements[1]);
  // The input is not mutated.
  assert.equal(SCENE.elements[0].feedValue, '20');
});

test('bakeReadings: a missing or null reading keeps the saved value', () => {
  const out = bakeReadings(SCENE, { last: { temp: null } });
  assert.equal(out.elements[0].feedValue, '20');
  assert.equal(out.elements[2].gaugeValue, '3');
});

test('bakeReadings: a reading changes the picture, not the design', () => {
  const out = bakeReadings(SCENE, { last: { temp: '99' } });
  assert.equal(sameDesign(SCENE, out), true);
});

test('bakeReadings: chart windows land per window, thinned to the chart width', () => {
  const body = {
    columns: ['date', 'value'],
    data: [['2026-10-01T00:03:00Z', '4'], ['2026-10-01T00:00:00Z', '1'], ['2026-10-01T00:01:00Z', '2'],
      ['2026-10-01T00:02:00Z', 'x'], ['2026-10-01T00:04:00Z', '5'], ['2026-10-01T00:05:00Z', '6']],
  };
  const out = bakeReadings(SCENE, { chart: { 'temp@6h': body, 'temp@24h/raw': [{ t: 'a', v: 9 }] } });
  const pts = out.elements[5].series.temp;
  // Sorted, the non-number dropped, thinned to w = 4 keeping both ends.
  assert.equal(pts.length, 4);
  assert.deepEqual(pts[0], { t: '2026-10-01T00:00:00Z', v: 1 });
  assert.deepEqual(pts[3], { t: '2026-10-01T00:05:00Z', v: 6 });
  // The other series on that chart had no reading, and the second chart got its own window.
  assert.equal('alice/hum' in out.elements[5].series, false);
  assert.deepEqual(out.elements[6].series, { temp: [{ t: 'a', v: 9 }] });
});

test('chartPoints: the value column is found by name', () => {
  const agg = { columns: ['date', 'min', 'max', 'avg'], data: [['2026-10-01T00:00:00Z', 1, 9, 5]] };
  assert.deepEqual(chartPoints(agg), [{ t: '2026-10-01T00:00:00Z', v: 5 }]);
  assert.equal(chartPoints({ columns: ['date', 'other'], data: [] }), null);
  assert.equal(chartPoints(null), null);
});

test('mergeSeries: a failed read keeps old points, an unbound feed is dropped', () => {
  const prev = { a: [{ t: 1, v: 1 }], gone: [{ t: 1, v: 2 }] };
  const out = mergeSeries(prev, [{ key: 'a' }, { key: 'b' }], { b: [{ t: 2, v: 3 }] }, 10);
  assert.deepEqual(out, { a: [{ t: 1, v: 1 }], b: [{ t: 2, v: 3 }] });
});

test('downsample and chartReadId', () => {
  assert.deepEqual(downsample([1, 2, 3, 4, 5], 3), [1, 3, 5]);
  assert.deepEqual(downsample([1, 2], 5), [1, 2]);
  assert.equal(chartReadId('k', { hours: 168, raw: true }), 'k@168h/raw');
});

// ---- feed image (#36) ----

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQImWNgYGD4z8DAwMDAAAAAPAAB';
const pictures = doc(
  { etype: 'feedimage', w: 40, h: 30, feedKey: 'cam', feedName: 'Cam', src: 'feed:cam' },
  { etype: 'label', feedKey: 'cam', feedValue: 'x', text: 'x' },
  { etype: 'feedimage', w: 40, h: 30, feedKey: '', src: 'feed:' },
);

test('feedReads: a feed image is one last-value read, shared with anything else on its feed', () => {
  assert.deepEqual(feedReads(pictures).reads, [{ id: 'cam', feed: 'cam', kind: 'last' }]);
});

test("bakeReadings: a picture becomes the feed image's src, as a data URL", () => {
  const out = bakeReadings(pictures, { last: { cam: PNG } });
  assert.equal(out.elements[0].src, `data:image/png;base64,${PNG}`);
  assert.equal(pictures.elements[0].src, 'feed:cam', 'the input is not mutated');
  assert.equal(out.elements[2].src, 'feed:', 'an unbound frame is left alone');
});

test('bakeReadings: a value that is not a picture, or no reading, keeps the feed reference', () => {
  for (const readings of [{ last: { cam: '21.5' } }, { last: { cam: null } }, {}]) {
    assert.equal(bakeReadings(pictures, readings).elements[0].src, 'feed:cam');
  }
});
