/**
 * Importing a canvas.json — public/js/core/canvasimport.js.
 *
 * canvasimport.js imports only palette.js, which imports nothing, so it runs under
 * plain node the way samples.js does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCanvasDoc, compareDisplay, fitDoc } from '../public/js/core/canvasimport.js';
import { logicalDimsOf } from '../public/js/canvas/palette.js';

const label = (x, y, extra = {}) => ({ etype: 'label', x, y, text: 'hi', fontSize: 20, ...extra });
const docText = (o) => JSON.stringify({ version: 1, elements: [], ...o });

test('not JSON, not an object, wrong version, no elements: all block the import', () => {
  assert.equal(validateCanvasDoc('{nope').ok, false);
  assert.equal(validateCanvasDoc('[]').ok, false);
  assert.equal(validateCanvasDoc(docText({ version: 2 })).ok, false);
  assert.equal(validateCanvasDoc('{"version":1}').ok, false);
});

test('a missing version is accepted — serialize() always writes 1, older hand edits may not', () => {
  const r = validateCanvasDoc(JSON.stringify({ elements: [label(1, 2)] }));
  assert.equal(r.ok, true);
  assert.equal(r.doc.elements.length, 1);
});

test('an element with no position blocks the import', () => {
  const r = validateCanvasDoc(docText({ elements: [{ etype: 'label', x: 'a', y: 0 }] }));
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /Element 1/);
});

test('unknown etypes and non-embedded images are dropped with a warning', () => {
  const r = validateCanvasDoc(docText({ elements: [
    label(0, 0),
    { etype: 'hologram', x: 0, y: 0 },
    { etype: 'image', x: 0, y: 0, src: 'https://example.com/a.png', w: 10, h: 10 },
    { etype: 'image', x: 0, y: 0, src: 'data:image/png;base64,AAAA', w: 10, h: 10 },
  ] }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.doc.elements.map((e) => e.etype), ['label', 'image']);
  assert.equal(r.warnings.length, 2);
});

test('bad display fields are warned about and dropped; a half size is no size', () => {
  const r = validateCanvasDoc(docText({ display: {
    width: 296, height: -1, rotation: 45, type: 'rainbow', dither: 'ordered', orderedMap: 3, diffusion: 50,
  } }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.doc.display, { dither: 'ordered', diffusion: 50 });
  assert.equal(r.warnings.length, 4);
});

test('logicalDimsOf: rotation swaps, and the MagTag is landscape at 0', () => {
  assert.deepEqual(logicalDimsOf({ width: 128, height: 296, rotation: 0, panel: '' }), { w: 128, h: 296 });
  assert.deepEqual(logicalDimsOf({ width: 128, height: 296, rotation: 90, panel: '' }), { w: 296, h: 128 });
  assert.deepEqual(logicalDimsOf({ width: 128, height: 296, rotation: 0, panel: 'magtag' }), { w: 296, h: 128 });
  assert.deepEqual(logicalDimsOf({ width: 128, height: 296, rotation: 90, panel: 'magtag' }), { w: 128, h: 296 });
  // The MagTag's old panel id, as an older canvas.json carries it.
  assert.deepEqual(logicalDimsOf({ width: 128, height: 296, rotation: 0, panel: 'magtag-2025' }), { w: 296, h: 128 });
});

const MAGTAG = { width: 128, height: 296, rotation: 0, panel: 'magtag', type: 'mono',
  dither: 'FloydSteinberg', diffusion: 85, orderedMap: 8 };

test('compareDisplay: the same panel is no difference at all', () => {
  const c = compareDisplay({ ...MAGTAG }, MAGTAG);
  assert.equal(c.sizeDiffers, false);
  assert.equal(c.typeDiffers, false);
  assert.equal(c.ditherDiffers, false);
});

test('compareDisplay: orientation, type and dither mismatches', () => {
  const c = compareDisplay({ ...MAGTAG, rotation: 90, type: 'tricolor', diffusion: 50 }, MAGTAG);
  assert.equal(c.sizeDiffers, true);
  assert.deepEqual(c.srcDims, { w: 128, h: 296 });
  assert.deepEqual(c.dstDims, { w: 296, h: 128 });
  assert.equal(c.typeDiffers, true);
  assert.equal(c.ditherDiffers, true);
});

test('compareDisplay: a diffusion under an ordered dither is not a difference', () => {
  const c = compareDisplay({ dither: 'none', diffusion: 10 }, { ...MAGTAG, dither: 'none' });
  assert.equal(c.ditherDiffers, false);
  assert.equal(c.srcDims, null);
});

test('fitDoc: 296×128 into 128×296 scales uniformly and centers, without touching the input', () => {
  const doc = { version: 1, display: {}, elements: [
    label(0, 0, { width: 100 }),
    { etype: 'divider', x: 296, y: 128, width: 296, height: 2 },
    { etype: 'linechart', x: 10, y: 10, w: 200, h: 100, axisFontSize: 10 },
  ] };
  const before = JSON.stringify(doc);
  const out = fitDoc(doc, { w: 296, h: 128 }, { w: 128, h: 296 });
  assert.equal(JSON.stringify(doc), before);

  const s = 128 / 296;
  const oy = (296 - 128 * s) / 2;
  assert.deepEqual(out.elements[0], label(0, Math.round(oy), { width: Math.round(100 * s), fontSize: Math.round(20 * s) }));
  assert.equal(out.elements[1].x, 128);
  assert.equal(out.elements[1].y, Math.round(128 * s + oy));
  assert.equal(out.elements[1].width, 128);
  assert.equal(out.elements[1].height, 1);
  assert.equal(out.elements[2].w, Math.round(200 * s));
  assert.equal(out.elements[2].axisFontSize, Math.round(10 * s));
});

test('fitDoc: onto the same size is a no-op', () => {
  const doc = { version: 1, display: {}, elements: [label(5, 7, { width: 33 })] };
  assert.deepEqual(fitDoc(doc, { w: 296, h: 128 }, { w: 296, h: 128 }), doc);
});

test('a feed image loads with or without a picture; a remote picture is dropped, the frame kept', () => {
  const frame = { etype: 'feedimage', x: 0, y: 0, w: 100, h: 80, fit: 'contain', feedKey: 'doorbell', feedName: 'Doorbell' };
  const r = validateCanvasDoc(docText({ elements: [
    { ...frame },                                                      // bound, nothing read yet
    { ...frame, src: null, natW: null, natH: null },                   // as serialize() writes that
    { ...frame, src: 'data:image/jpeg;base64,/9j/AAAA', natW: 4, natH: 3 },
    { ...frame, src: 'https://example.com/latest.jpg', natW: 4, natH: 3 },
  ] }));
  assert.equal(r.ok, true);
  assert.equal(r.doc.elements.length, 4, 'every frame survives — the picture is a reading, not the design');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /Element 4 .*picture was dropped/);
  const dropped = r.doc.elements[3];
  assert.equal(dropped.src, null);
  assert.equal(dropped.natW, null);
  assert.equal(dropped.feedKey, 'doorbell');
  assert.equal(r.doc.elements[2].src, 'data:image/jpeg;base64,/9j/AAAA');
});

test('fitDoc scales a feed image frame like a static image', () => {
  const doc = { version: 1, display: {}, elements: [
    { etype: 'feedimage', x: 0, y: 0, w: 148, h: 64, fit: 'cover', feedKey: 'cam' },
  ] };
  const out = fitDoc(doc, { w: 296, h: 128 }, { w: 148, h: 64 });
  assert.equal(out.elements[0].w, 74);
  assert.equal(out.elements[0].h, 32);
  assert.equal(out.elements[0].fit, 'cover');
});

test('display.background: a colour is kept, junk is warned about and dropped', () => {
  const ok = validateCanvasDoc(docText({ display: { background: '#2F2429' } }));
  assert.deepEqual(ok.doc.display, { background: '#2F2429' });
  assert.equal(ok.warnings.length, 0);

  const bad = validateCanvasDoc(docText({ display: { background: 'black' } }));
  assert.deepEqual(bad.doc.display, {});
  assert.match(bad.warnings[0], /display\.background/);
});

test('an older document with no background imports without one — the load fills in PAPER', () => {
  const r = validateCanvasDoc(docText({ display: { width: 128, height: 296 } }));
  assert.equal('background' in r.doc.display, false);
  assert.equal(r.warnings.length, 0);
});

test('a text box background and padding ride through validation untouched', () => {
  const r = validateCanvasDoc(docText({ elements: [
    label(0, 0, { background: '#D72627', padding: 4 }),
    { etype: 'datetime', x: 0, y: 0, background: '#2F2429', padding: 2 },
  ] }));
  assert.equal(r.ok, true);
  assert.equal(r.doc.elements[0].background, '#D72627');
  assert.equal(r.doc.elements[0].padding, 4);
  assert.equal(r.doc.elements[1].padding, 2);
});

test('fitDoc: a text box padding scales with its type', () => {
  const doc = { version: 1, display: {}, elements: [
    label(0, 0, { padding: 8, background: '#2F2429' }),
    { etype: 'datetime', x: 0, y: 0, fontSize: 20, padding: 8 },
  ] };
  const out = fitDoc(doc, { w: 296, h: 128 }, { w: 148, h: 64 });
  assert.equal(out.elements[0].padding, 4);
  assert.equal(out.elements[0].fontSize, 10);
  assert.equal(out.elements[0].background, '#2F2429');
  assert.equal(out.elements[1].padding, 4);
});
