/**
 * The bitmap fonts — public/js/lib/pixelfont.js and lib/pixeltext.js.
 *
 * Tom Thumb 3×5 and the Adafruit GFX 5×7, offered in the font menu beside the bundled
 * Plex faces and used by widgets for their own captions under 8 px. Pure, so it runs
 * under plain node; the PixelText test at the end draws through Konva on a recording
 * context.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
import {
  PIXEL_TEXT_BELOW, PIXEL_FONTS, pixelFontFor, pixelScale, captionFamily, cssFamily, fontAdvice,
  pixelTextWidth, pixelTextRuns, textMetrics,
} from '../public/js/lib/pixelfont.js';
import { FONTS, FONT_MONO, FONT_SANS, FONT_SERIF, fontLabel, normalizeFontFamily } from '../public/js/lib/fonts.js';

const { tomThumb, gfx5x7 } = PIXEL_FONTS;

/** Render `text` to rows of '#'/'.' for eyeballing a glyph in an assertion. */
function ascii(font, text, scale = 1) {
  const w = pixelTextWidth(font, text, 0, scale);
  const rows = Array.from({ length: font.lineH * scale }, () => Array(w).fill('.'));
  pixelTextRuns(font, text, (x, y, len, thick) => {
    for (let dy = 0; dy < thick; dy++) for (let i = 0; i < len; i++) rows[y + dy][x + i] = '#';
  }, 0, scale);
  return rows.map((r) => r.join(''));
}

test('a bitmap font draws only when it is chosen; the Plex faces are always outline type', () => {
  assert.equal(PIXEL_TEXT_BELOW, 8);
  assert.equal(pixelFontFor('tom-thumb'), tomThumb);
  assert.equal(pixelFontFor('gfx-5x7'), gfx5x7);
  for (const fam of [FONT_MONO, FONT_SANS, FONT_SERIF, 'Font Awesome 6 Free']) assert.equal(pixelFontFor(fam), null, fam);
  // A saved bitmap family survives the load-time normaliser, stack and all.
  assert.equal(normalizeFontFamily('tom-thumb'), 'tom-thumb');
  assert.equal(normalizeFontFamily('"gfx-5x7", monospace'), 'gfx-5x7');
  assert.equal(normalizeFontFamily('monospace'), FONT_MONO);
});

test('the menu names each font with the size it is useful at', () => {
  assert.deepEqual(FONTS.map((o) => o.family), [FONT_MONO, FONT_SANS, FONT_SERIF, 'tom-thumb', 'gfx-5x7']);
  for (const o of FONTS) assert.match(o.note, /\d px/, o.family);
  assert.equal(FONTS.find((o) => o.family === 'tom-thumb').note, '6 px steps');
  assert.equal(FONTS.find((o) => o.family === 'gfx-5x7').note, '8 px steps');
  assert.equal(fontLabel('gfx-5x7'), 'Adafruit 5×7');
  assert.equal(cssFamily('tom-thumb'), FONT_MONO, 'the inline editor has no bitmap font to use');
  assert.equal(cssFamily(FONT_SANS), FONT_SANS);
});

test('a bitmap font scales in whole steps of its line, like setTextSize, never below 1', () => {
  for (const size of [4, 5, 6, 11]) assert.equal(pixelScale(tomThumb, size), 1, `tom-thumb ${size}`);
  assert.equal(pixelScale(tomThumb, 12), 2);
  assert.equal(pixelScale(tomThumb, 17), 2);
  assert.equal(pixelScale(tomThumb, 18), 3);
  for (const size of [7, 8, 15]) assert.equal(pixelScale(gfx5x7, size), 1, `gfx ${size}`);
  assert.equal(pixelScale(gfx5x7, 16), 2);
  assert.equal(pixelScale(gfx5x7, 24), 3);
});

test('widgets caption themselves in a bitmap font under 8 px and Plex Mono from 8 up', () => {
  for (const size of [4, 5, 6]) assert.equal(captionFamily(size), 'tom-thumb', `${size}px`);
  assert.equal(captionFamily(7), 'gfx-5x7');
  for (const size of [8, 9, 20]) assert.equal(captionFamily(size), FONT_MONO, `${size}px`);
});

test('the advice warns, in red, about an outline font under 8 px and names the bitmap font to use', () => {
  const small = fontAdvice(FONT_MONO, 6);
  assert.equal(small.level, 'warn');
  assert.match(small.text, /^Mono breaks up below 8 px/);
  assert.match(small.text, /Tom Thumb 3×5 \(6 px steps\)/);
  assert.match(fontAdvice(FONT_SERIF, 7).text, /Adafruit 5×7 \(8 px steps\)/, 'at 7 px the 5×7 is the fit');
  assert.equal(fontAdvice(FONT_MONO, 8), null);
  assert.equal(fontAdvice(FONT_SANS, 20), null);
});

test('the advice notes when a bitmap font rounds the size down to its step', () => {
  assert.equal(fontAdvice('tom-thumb', 6), null);
  assert.equal(fontAdvice('tom-thumb', 12), null);
  assert.equal(fontAdvice('gfx-5x7', 16), null);
  const off = fontAdvice('tom-thumb', 9);
  assert.equal(off.level, 'note');
  assert.equal(off.text, 'Tom Thumb 3×5 draws in whole 6 px steps: 9 px draws at 6 px (1×). Use 6, 12 or 18 px.');
  assert.equal(fontAdvice('gfx-5x7', 20).text, 'Adafruit 5×7 draws in whole 8 px steps: 20 px draws at 16 px (2×). Use 8, 16 or 24 px.');
  assert.equal(fontAdvice('gfx-5x7', 4).text, 'Adafruit 5×7 draws in whole 8 px steps: 4 px draws at 8 px (1×). Use 8, 16 or 24 px.');
});

test('widths are whole pixels: 4 per character in Tom Thumb, 6 in the 5×7, times the scale', () => {
  assert.equal(pixelTextWidth(tomThumb, '85'), 8);
  assert.equal(pixelTextWidth(gfx5x7, '12:00'), 30);
  assert.equal(pixelTextWidth(gfx5x7, 'ab', 1), 14, 'letter spacing adds per character');
  assert.equal(pixelTextWidth(tomThumb, '85', 0, 2), 16);
  assert.equal(pixelTextWidth(tomThumb, '85', 1, 2), 18, 'letter spacing is in px, not scaled');
});

test('Tom Thumb draws the digits it is known for', () => {
  assert.deepEqual(ascii(tomThumb, '85'), [
    '###.###.',
    '#.#.#...',
    '###.##..',
    '#.#...#.',
    '###.##..',
    '........',
  ]);
});

test('at 2× every glyph pixel is a 2×2 block', () => {
  const one = ascii(tomThumb, '8'), two = ascii(tomThumb, '8', 2);
  assert.equal(two.length, one.length * 2);
  one.forEach((row, y) => {
    const wide = row.split('').map((c) => c + c).join('');
    assert.equal(two[2 * y], wide, `row ${y}`);
    assert.equal(two[2 * y + 1], wide, `row ${y} doubled`);
  });
});

test('the 5×7 sits its capitals on row 6 and keeps row 7 for descenders', () => {
  const rows = ascii(gfx5x7, 'Hg');
  assert.equal(rows[0], '#...#.......');
  assert.equal(rows[6], '#...#.....#.');
  assert.equal(rows[7], '.......###..');
});

test('a dash, an ellipsis and a degree sign draw; anything else unknown is "?"', () => {
  assert.deepEqual(ascii(tomThumb, '—'), ascii(tomThumb, '-'));
  assert.notDeepEqual(ascii(tomThumb, '°'), ascii(tomThumb, '?'));
  assert.equal(pixelTextWidth(tomThumb, '21°'), pixelTextWidth(tomThumb, '21') + 4);
  assert.deepEqual(ascii(gfx5x7, '€'), ascii(gfx5x7, '?'));
});

test('textMetrics is exact for a bitmap font at its scale, an estimate for browser type', () => {
  assert.deepEqual(textMetrics(6, 'tom-thumb'), { charW: 4, lineH: 6, capH: 5, pixel: true });
  assert.deepEqual(textMetrics(12, 'tom-thumb'), { charW: 8, lineH: 12, capH: 10, pixel: true });
  assert.deepEqual(textMetrics(7, 'gfx-5x7'), { charW: 6, lineH: 8, capH: 7, pixel: true });
  assert.deepEqual(textMetrics(6, captionFamily(6)), { charW: 4, lineH: 6, capH: 5, pixel: true });
  const big = textMetrics(10);
  assert.equal(big.pixel, false);
  assert.equal(big.lineH, 10);
  assert.ok(Math.abs(big.charW - 6.2) < 1e-9);
  assert.equal(textMetrics(6, FONT_MONO).pixel, false, 'an outline font is never swapped for a bitmap font');
});


// ---------- pixeltext.js ----------------------------------------------------

const fakeContext = () => {
  const calls = [];
  return new Proxy({ calls }, {
    get: (ctx, prop) => (prop in ctx ? ctx[prop]
      : prop === 'measureText' ? (text) => ({ width: String(text).length * 6 })
      : prop === 'fillRect' ? (...a) => calls.push(a)
      : prop === 'getImageData' ? () => ({ data: new Uint8ClampedArray(4) })
      : () => {}),
    set: (ctx, prop, value) => { ctx[prop] = value; return true; },
  });
};
globalThis.document ??= { createElement: () => ({ style: {}, getContext: fakeContext }) };
runInThisContext(readFileSync(new URL('../public/js/vendor/konva.js', import.meta.url), 'utf8'));
const { Konva } = globalThis;
const { newText, pixelTextClass } = await import('../public/js/lib/pixeltext.js');

test('PixelText measures from the glyph table and is plain Konva.Text in an outline font', () => {
  assert.equal(pixelTextClass(Konva), pixelTextClass(Konva), 'one class per Konva');
  const t = newText(Konva, { text: '85', fontSize: 12, fontFamily: 'tom-thumb' });
  assert.ok(t instanceof Konva.Text);
  assert.equal(t.getClassName(), 'Text');
  assert.equal(t.width(), 16, '4 px per character at 2×');
  assert.equal(t.height(), 12);
  const plain = newText(Konva, { text: '85', fontSize: 12, fontFamily: FONT_MONO });
  assert.equal(plain.width(), 12, "the host's own measureText");
});

test('PixelText draws each glyph row as whole-pixel rectangles', () => {
  const t = newText(Konva, { text: '8', fontSize: 6, fontFamily: 'tom-thumb', fill: '#000' });
  const ctx = fakeContext();
  t._sceneFunc({ setAttr() {}, fillRect: ctx.fillRect });
  const px = new Set();
  for (const [x, y, w, h] of ctx.calls) for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) px.add(`${x + i},${y + j}`);
  const rows = ascii(tomThumb, '8');
  const want = new Set();
  rows.forEach((r, y) => [...r].forEach((c, x) => { if (c === '#') want.add(`${x},${y}`); }));
  assert.deepEqual([...px].sort(), [...want].sort());
});
