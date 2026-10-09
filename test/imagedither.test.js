/**
 * Per-picture dithering — public/js/canvas/imagedither.js.
 *
 * Only the pure half is reachable from node: which settings a picture uses, and the
 * pixels-in/pixels-out dither. The Konva swap is exercised in the browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_DITHERS, imageDitherOf, ditherPixels } from '../public/js/canvas/imagedither.js';
import { renderIndexedBmp } from '../public/js/canvas/bitmap.js';
import { PALETTES, PAPER, hexToRGB } from '../public/js/canvas/palette.js';
import { validateCanvasDoc } from '../public/js/core/canvasimport.js';

const panel = { dither: 'FloydSteinberg', diffusion: 85, orderedMap: 8 };

/** A w×h horizontal ramp from black to white, opaque. */
function ramp(w, h) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = Math.round((x / (w - 1)) * 255), i = (y * w + x) * 4;
    px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255;
  }
  return px;
}
const key = (px, i) => `${px[i]},${px[i + 1]},${px[i + 2]}`;

test('a picture with no dither of its own follows the panel', () => {
  assert.deepEqual(imageDitherOf({}, panel), panel);
  assert.deepEqual(imageDitherOf({ dither: 'inherit' }, panel), panel);
  assert.deepEqual(imageDitherOf({ dither: 'sparkle' }, panel), panel, 'an unknown value is ignored');
});

test('a picture\'s own dither wins, with its own diffusion when it has one', () => {
  assert.deepEqual(imageDitherOf({ dither: 'none' }, panel), { ...panel, dither: 'none' });
  assert.deepEqual(imageDitherOf({ dither: 'FloydSteinberg', diffusion: 40 }, panel), { ...panel, diffusion: 40 });
  assert.deepEqual(imageDitherOf({ dither: 'ordered' }, panel), { ...panel, dither: 'ordered' });
  assert.ok(IMAGE_DITHERS.includes('inherit'));
});

test('every opaque pixel out of ditherPixels is an exact palette colour', () => {
  for (const [type, pal] of Object.entries(PALETTES)) {
    const allowed = new Set(pal.map((h) => hexToRGB(h).join(',')));
    for (const dither of ['FloydSteinberg', 'ordered', 'none']) {
      const out = ditherPixels(ramp(32, 8), 32, 8, pal, PAPER, { ...panel, dither });
      for (let i = 0; i < out.length; i += 4) assert.ok(allowed.has(key(out, i)), `${type}/${dither} pixel ${i / 4}`);
    }
  }
});

test('a dithered ramp uses both inks; the same ramp undithered does not mix them', () => {
  const fs = ditherPixels(ramp(64, 4), 64, 4, PALETTES.mono, PAPER, panel);
  const none = ditherPixels(ramp(64, 4), 64, 4, PALETTES.mono, PAPER, { ...panel, dither: 'none' });
  // Mid-ramp, where the grey is ~50%: diffusion alternates, nearest colour does not.
  const mid = (px) => new Set(Array.from({ length: 8 }, (_, k) => key(px, (28 + k) * 4)));
  assert.equal(mid(fs).size, 2);
  assert.equal(mid(none).size, 1);
});

test('transparency survives as a mask, and is judged over the page it lands on', () => {
  const px = new Uint8ClampedArray([
    0, 0, 0, 0,        // fully transparent
    0, 0, 0, 100,      // mostly transparent black
    0, 0, 0, 200,      // mostly opaque black
    255, 255, 255, 255,
  ]);
  const out = ditherPixels(px, 4, 1, PALETTES.mono, PAPER, { ...panel, dither: 'none' });
  assert.equal(out[3], 0);
  assert.equal(out[7], 0, 'alpha under 128 stays see-through');
  assert.equal(out[11], 255);
  assert.equal(key(out, 8), hexToRGB(PALETTES.mono[0]).join(','));
  assert.equal(out[15], 255);
});

test('the final whole-panel pass leaves an already-dithered picture exactly as it was', () => {
  // This is what lets render.js snap the whole capture to the palette without touching
  // the pictures: every palette colour is a fixed point of the nearest-colour pass.
  for (const [type, pal] of Object.entries(PALETTES)) {
    const pic = ditherPixels(ramp(48, 6), 48, 6, pal, PAPER, panel);
    const { indices, colormap } = renderIndexedBmp(pic, 48, 6, pal, { method: 'none' });
    for (let p = 0; p < indices.length; p++) {
      assert.equal(colormap[indices[p]].join(','), key(pic, p * 4), `${type} pixel ${p}`);
    }
  }
});

test('import keeps a known picture dither and drops an unknown one with a warning', () => {
  const src = 'data:image/png;base64,AAAA';
  const r = validateCanvasDoc(JSON.stringify({ version: 1, elements: [
    { etype: 'image', x: 0, y: 0, src, dither: 'ordered' },
    { etype: 'feedimage', x: 0, y: 0, w: 10, h: 10, dither: 'FloydSteinberg', diffusion: 40 },
    { etype: 'image', x: 0, y: 0, src, dither: 'sparkle', diffusion: 3 },
    { etype: 'carousel', x: 0, y: 0, w: 10, h: 10, items: [{ src }], dither: 'none' },
    { etype: 'carousel', x: 0, y: 0, w: 10, h: 10, items: [{ src }], dither: 'sparkle' },
  ] }));
  assert.equal(r.ok, true);
  assert.equal(r.doc.elements[0].dither, 'ordered');
  assert.equal(r.doc.elements[1].diffusion, 40);
  assert.equal('dither' in r.doc.elements[2], false);
  assert.equal('diffusion' in r.doc.elements[2], false);
  assert.equal(r.doc.elements[3].dither, 'none');
  assert.equal('dither' in r.doc.elements[4], false);
  assert.equal(r.warnings.length, 2);
  assert.match(r.warnings[0], /Element 3 .*dither/);
});
