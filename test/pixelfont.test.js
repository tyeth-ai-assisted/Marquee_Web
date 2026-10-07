/**
 * Bitmap fonts for small text — public/js/canvas/pixelfont.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PIXEL_TEXT_BELOW, PIXEL_FONTS, pixelFontFor, pixelTextWidth, pixelTextRuns, textMetrics,
} from '../public/js/canvas/pixelfont.js';

const { tomThumb, gfx5x7 } = PIXEL_FONTS;

/** Render `text` to rows of '#'/'.' for eyeballing a glyph in an assertion. */
function ascii(font, text) {
  const w = pixelTextWidth(font, text);
  const rows = Array.from({ length: font.lineH }, () => Array(w).fill('.'));
  pixelTextRuns(font, text, (x, y, len) => { for (let i = 0; i < len; i++) rows[y][x + i] = '#'; });
  return rows.map((r) => r.join(''));
}

test('small text in a generic family gets a bitmap font; 8 px and up stays type', () => {
  assert.equal(PIXEL_TEXT_BELOW, 8);
  for (const size of [4, 5, 6]) assert.equal(pixelFontFor(size, 'monospace'), tomThumb, `${size}px`);
  assert.equal(pixelFontFor(7, 'monospace'), gfx5x7);
  assert.equal(pixelFontFor(8, 'monospace'), null);
  assert.equal(pixelFontFor(20, 'monospace'), null);
  for (const fam of ['sans-serif', 'serif', '"monospace"', 'monospace, serif']) {
    assert.equal(pixelFontFor(6, fam), tomThumb, fam);
  }
});

test('a named font is never substituted, so icon fonts keep their glyphs', () => {
  assert.equal(pixelFontFor(6, '"Font Awesome 6 Free"'), null);
  assert.equal(pixelFontFor(6, 'Consolas'), null);
});

test('widths are whole pixels: 4 per character in Tom Thumb, 6 in the 5×7', () => {
  assert.equal(pixelTextWidth(tomThumb, '85'), 8);
  assert.equal(pixelTextWidth(gfx5x7, '12:00'), 30);
  assert.equal(pixelTextWidth(gfx5x7, 'ab', 1), 14, 'letter spacing adds per character');
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

test('textMetrics reports the bitmap font where one draws, estimates otherwise', () => {
  assert.deepEqual(textMetrics(6), { charW: 4, lineH: 6, capH: 5, pixel: true });
  assert.deepEqual(textMetrics(7), { charW: 6, lineH: 8, capH: 7, pixel: true });
  const big = textMetrics(10);
  assert.equal(big.pixel, false);
  assert.equal(big.lineH, 10);
  assert.ok(Math.abs(big.charW - 6.2) < 1e-9);
});
