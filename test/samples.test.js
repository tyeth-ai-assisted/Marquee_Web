/**
 * What counts as a reading, and what counts as an edit — public/js/core/samples.js.
 *
 * The first test in this repo that covers app logic rather than the render pipeline, and
 * it exists because this is the one part of the live-take change whose failure mode is
 * silent. Strip too little and Showtime reports "3 changes queued" about three
 * thermometers nobody touched; strip too much and a real edit is swallowed, never counted
 * and never mirrored to {group}.canvas-state.
 *
 * samples.js imports nothing at all, so it runs under plain node the way bitmap.js does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_KEYS, stripSamples, withoutSamples, sameDesign } from '../public/js/core/samples.js';

const doc = (...elements) => ({ version: 1, display: { type: 'mono', w: 296, h: 128 }, elements });

test('a linked label: the reading moves, the design does not', () => {
  const before = doc({ etype: 'label', feedKey: 'clean-temperature', feedName: 'Temp',
    feedPrefix: '', feedSuffix: 'C', text: '72C', feedValue: '72', fontSize: 16, x: 4, y: 8 });
  const after = doc({ etype: 'label', feedKey: 'clean-temperature', feedName: 'Temp',
    feedPrefix: '', feedSuffix: 'C', text: '73C', feedValue: '73', fontSize: 16, x: 4, y: 8 });
  assert.equal(sameDesign(before, after), true);

  // `text` goes with `feedValue` because applyFeedValue() derives it from the reading.
  const bare = stripSamples(before.elements[0]);
  assert.equal('text' in bare, false);
  assert.equal('feedValue' in bare, false);
  // Everything the user chose survives, including how they asked for the value to be wrapped.
  assert.equal(bare.fontSize, 16);
  assert.equal(bare.x, 4);
  assert.equal(bare.feedSuffix, 'C');
  assert.equal(bare.feedKey, 'clean-temperature');
});

test('an UNLINKED label: `text` is the most authored thing on the canvas', () => {
  // The regression this file is really here for. Strip `text` unconditionally and
  // renaming a label stops counting as a change at all.
  assert.equal(sameDesign(doc({ etype: 'label', text: 'Kitchen' }),
                          doc({ etype: 'label', text: 'Garage' })), false);
  assert.equal(stripSamples({ etype: 'label', text: 'Kitchen' }).text, 'Kitchen');
});

test('each widget gives up its reading and keeps its settings', () => {
  const cases = [
    ['indicator', { op: 'gt', cmp: '5', onColor: '#000' }, { value: '1' }, { value: '9' }],
    ['battery', { conds: [{ op: 'lt', cmp: '20', color: '#f00' }], showPct: true }, { feedValue: '88' }, { feedValue: '41' }],
    ['gauge', { min: 0, max: 100, lowWarn: '', highWarn: '80', title: 'Temp' }, { gaugeValue: 20 }, { gaugeValue: 64 }],
    ['linechart', { feeds: [{ key: 'a', name: 'A', color: '#000' }], hours: 24 },
      { series: { a: [{ t: '1', v: 1 }] } }, { series: { a: [{ t: '2', v: 2 }] } }],
  ];
  for (const [etype, design, sampleA, sampleB] of cases) {
    assert.equal(sameDesign(doc({ etype, ...design, ...sampleA }), doc({ etype, ...design, ...sampleB })),
      true, `${etype}: a new reading is not an edit`);
    const bare = stripSamples({ etype, ...design, ...sampleA });
    for (const k of SAMPLE_KEYS[etype]) assert.equal(k in bare, false, `${etype}: ${k} should be stripped`);
    for (const k of Object.keys(design)) assert.deepEqual(bare[k], design[k], `${etype}: ${k} should survive`);
  }
});

test('a real edit to a widget still reads as an edit', () => {
  const base = { etype: 'gauge', min: 0, max: 100, highWarn: '80', gaugeValue: 20 };
  assert.equal(sameDesign(doc(base), doc({ ...base, highWarn: '90' })), false);   // a threshold
  assert.equal(sameDesign(doc(base), doc({ ...base, max: 120 })), false);         // a range
  const chart = { etype: 'linechart', feeds: [{ key: 'a' }], series: {} };
  assert.equal(sameDesign(doc(chart), doc({ ...chart, feeds: [{ key: 'b' }] })), false);   // a binding
});

test("a chart with nothing bound keeps its authored `data`", () => {
  // `data` is the sample series doc.js writes only when no feed is connected. It is
  // authored, so it must survive — stripping it would make a hand-drawn chart uncountable.
  const el = { etype: 'linechart', feeds: [], data: [1, 2, 3], series: {} };
  assert.deepEqual(stripSamples(el).data, [1, 2, 3]);
});

test('moving, adding and removing elements all still count', () => {
  const g = { etype: 'gauge', gaugeValue: 20, min: 0, max: 100 };
  assert.equal(sameDesign(doc({ ...g, x: 0 }), doc({ ...g, x: 40 })), false);
  assert.equal(sameDesign(doc(g), doc(g, { etype: 'divider', width: 10 })), false);
  assert.equal(sameDesign(doc(g), doc()), false);
});

test('a display-settings change is not a reading', () => {
  const g = { etype: 'gauge', gaugeValue: 20 };
  const rotated = { ...doc(g), display: { type: 'mono', w: 128, h: 296 } };
  assert.equal(sameDesign(doc(g), rotated), false);
});

test('an etype this table has never heard of is left alone', () => {
  const el = { etype: 'sparkline', value: 3, series: { a: [] } };
  assert.deepEqual(stripSamples(el), el);
});

test('nothing is mutated on the way through', () => {
  // serialize()'s output goes straight on to localStorage and to IO, so a stripper that
  // edited in place would delete the samples the take is supposed to carry.
  const d = doc({ etype: 'gauge', gaugeValue: 20, min: 0 });
  Object.freeze(d);
  Object.freeze(d.elements);
  Object.freeze(d.elements[0]);
  const out = withoutSamples(d);
  assert.equal(d.elements[0].gaugeValue, 20);
  assert.equal('gaugeValue' in out.elements[0], false);
});

test('a missing document is never "the same"', () => {
  // Every caller is asking "may I skip this work"; skipping because there was nothing to
  // compare is how a first publish gets lost.
  assert.equal(sameDesign(null, doc()), false);
  assert.equal(sameDesign(doc(), null), false);
  assert.equal(sameDesign(null, null), false);
});

test('a feed image: the picture is the reading, the frame is the design', () => {
  const frame = { etype: 'feedimage', x: 10, y: 10, w: 120, h: 90, fit: 'contain',
    feedKey: 'doorbell', feedName: 'Doorbell' };
  const a = doc({ ...frame, src: 'data:image/jpeg;base64,/9j/AAAA', natW: 640, natH: 480 });
  const b = doc({ ...frame, src: 'data:image/png;base64,iVBORw0KGgo', natW: 800, natH: 600 });
  assert.equal(sameDesign(a, b), true, 'a new frame on the feed is not an edit');

  const bare = stripSamples(a.elements[0]);
  for (const k of SAMPLE_KEYS.feedimage) assert.equal(k in bare, false, `${k} should be stripped`);
  for (const k of ['w', 'h', 'fit', 'feedKey', 'feedName', 'x', 'y']) assert.deepEqual(bare[k], frame[k]);

  // Resizing the frame, changing the fit, or binding another feed: all edits.
  assert.equal(sameDesign(a, doc({ ...a.elements[0], w: 200 })), false);
  assert.equal(sameDesign(a, doc({ ...a.elements[0], fit: 'cover' })), false);
  assert.equal(sameDesign(a, doc({ ...a.elements[0], feedKey: 'birdfeeder' })), false);
});

test('an UNLINKED feed image keeps its picture — nobody but the user put it there', () => {
  // The same rule as the label's `text`: a key is only a reading while a feedKey says a
  // feed wrote it. Unlinked, swapping the picture is an edit.
  const el = { etype: 'feedimage', w: 120, h: 90, feedKey: '', src: 'data:image/png;base64,AAAA', natW: 1, natH: 1 };
  assert.deepEqual(stripSamples(el), el);
  assert.equal(sameDesign(doc(el), doc({ ...el, src: 'data:image/png;base64,BBBB' })), false);
});
