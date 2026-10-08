/**
 * The editor's fonts and the bitmap ones among them — public/js/canvas/pixelfont.js —
 * and the pure parts of the web font loader, public/js/canvas/webfont.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PIXEL_TEXT_BELOW, PIXEL_FONTS, FONT_OPTIONS, familyId, pixelFontFor, pixelScale, captionFamily,
  fontLabel, cssFamily, fontAdvice, pixelTextWidth, pixelTextRuns, textMetrics, EMOJI_FONT, hasPictographs,
  drawableText,
} from '../public/js/canvas/pixelfont.js';
import {
  webFontName, cssFontFamilies, resolveFontSource, isFontFileUrl,
} from '../public/js/canvas/webfont.js';

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

test('a bitmap font draws only when it is chosen; the generic families are always the browser\'s', () => {
  assert.equal(PIXEL_TEXT_BELOW, 8);
  for (const size of [4, 6, 7, 12, 40]) {
    assert.equal(pixelFontFor(size, 'tom-thumb'), tomThumb, `tom-thumb ${size}px`);
    assert.equal(pixelFontFor(size, 'gfx-5x7'), gfx5x7, `gfx-5x7 ${size}px`);
    for (const fam of ['monospace', 'sans-serif', 'serif', 'Press Start 2P', '"Font Awesome 6 Free"']) {
      assert.equal(pixelFontFor(size, fam), null, `${fam} ${size}px`);
    }
  }
  assert.equal(pixelFontFor(6, '"tom-thumb", monospace'), tomThumb, 'CSS quoting and fallbacks are ignored');
  assert.equal(familyId('"Press Start 2P", monospace'), 'Press Start 2P');
});

test('the menu names each font with the size it is useful at', () => {
  assert.deepEqual(FONT_OPTIONS.map((o) => o.id), ['monospace', 'sans-serif', 'serif', 'tom-thumb', 'gfx-5x7']);
  for (const o of FONT_OPTIONS) assert.match(o.note, /\d px/, o.id);
  assert.equal(FONT_OPTIONS.find((o) => o.id === 'tom-thumb').note, '6 px steps');
  assert.equal(FONT_OPTIONS.find((o) => o.id === 'gfx-5x7').note, '8 px steps');
  assert.equal(fontLabel('gfx-5x7'), 'Adafruit 5×7');
  assert.equal(fontLabel('Press Start 2P'), 'Press Start 2P', 'a web font is named by its family');
  assert.equal(cssFamily('tom-thumb'), 'monospace', 'the inline editor has no bitmap font to use');
});

test('every browser font draws with the monochrome emoji font behind it', () => {
  assert.equal(EMOJI_FONT, 'Noto Emoji');
  assert.equal(cssFamily('serif'), 'serif, "Noto Emoji"');
  assert.equal(cssFamily('monospace'), 'monospace, "Noto Emoji"');
  assert.equal(cssFamily('Press Start 2P'), '"Press Start 2P", "Noto Emoji", monospace');
  assert.equal(cssFamily('"Font Awesome 6 Free"'), '"Font Awesome 6 Free", "Noto Emoji", monospace');
  assert.equal(hasPictographs('Good Boy'), false);
  assert.equal(hasPictographs('Good Boy ✅‼️⚠️👀'), true);
  assert.equal(hasPictographs('21 °C'), false, 'a degree sign is not an emoji');
  for (const ch of ['✓', '✔', '⚠', '★', '☂', '⚡', '☀']) assert.equal(hasPictographs(ch), true, ch);
});

test('emoji are drawn in text presentation, so the mono fallback is not passed over', () => {
  assert.equal(drawableText('⚠\uFE0F ‼\uFE0F ok'), '⚠\uFE0E ‼\uFE0E ok');
  assert.equal(drawableText('plain'), 'plain');
  assert.equal(drawableText(null), '');
  // In a bitmap font a selector or joiner draws nothing and takes no room.
  assert.equal(pixelTextWidth(tomThumb, '!\uFE0F!'), pixelTextWidth(tomThumb, '!!'));
  assert.deepEqual(ascii(tomThumb, '!\uFE0E'), ascii(tomThumb, '!'));
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

test('widgets caption themselves in a bitmap font under 8 px and monospace from 8 up', () => {
  for (const size of [4, 5, 6]) assert.equal(captionFamily(size), 'tom-thumb', `${size}px`);
  assert.equal(captionFamily(7), 'gfx-5x7');
  for (const size of [8, 9, 20]) assert.equal(captionFamily(size), 'monospace', `${size}px`);
});

test('the advice warns, in red, about a browser font under 8 px and names the bitmap font to use', () => {
  const small = fontAdvice('monospace', 6);
  assert.equal(small.level, 'warn');
  assert.match(small.text, /^Mono is drawn by the browser and breaks up below 8 px/);
  assert.match(small.text, /Tom Thumb 3×5 \(6 px steps\)/);
  assert.match(fontAdvice('serif', 7).text, /Adafruit 5×7 \(8 px steps\)/, 'at 7 px the 5×7 is the fit');
  assert.match(fontAdvice('Press Start 2P', 5).text, /^Press Start 2P is drawn by the browser/);
  assert.equal(fontAdvice('monospace', 8), null);
  assert.equal(fontAdvice('sans-serif', 20), null);
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
  assert.equal(textMetrics(6, 'monospace').pixel, false, 'a generic family is never swapped for a bitmap font');
});

// ---------- webfont.js ------------------------------------------------------

test('a font file is registered under its file name', () => {
  assert.equal(webFontName('https://example.com/fonts/PressStart2P-Regular.woff2'), 'PressStart2P-Regular');
  assert.equal(webFontName('https://example.com/f/Pixel%20Operator.ttf?v=3'), 'Pixel Operator');
  assert.equal(webFontName('https://example.com/f/Silkscreen_Bold.otf#x'), 'Silkscreen Bold');
  assert.equal(webFontName('https://example.com/'), 'Web font');
});

test('a stylesheet\'s @font-face families are read out, once each', () => {
  const css = `
    /* latin-ext */
    @font-face { font-family: 'Press Start 2P'; font-style: normal; src: url(a.woff2) format('woff2'); unicode-range: U+0100-02BA; }
    /* latin */
    @font-face { font-family: 'Press Start 2P'; font-style: normal; src: url(b.woff2) format('woff2'); }
    @font-face { font-family: "Silkscreen"; src: url(c.woff2); }
    .x { font-family: Arial; }`;
  assert.deepEqual(cssFontFamilies(css), ['Press Start 2P', 'Silkscreen']);
  assert.deepEqual(cssFontFamilies('body { font-family: serif }'), []);
});

test('what the user typed becomes a URL: a URL as given, a Google Fonts name as its css2 link', () => {
  assert.equal(resolveFontSource(' https://x.y/f.woff2 '), 'https://x.y/f.woff2');
  assert.equal(resolveFontSource('Press Start 2P'),
    'https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap');
  assert.equal(resolveFontSource(''), '');
  assert.equal(resolveFontSource('not a font; url()'), '');
  assert.equal(isFontFileUrl('https://x.y/f.woff2?x=1'), true);
  assert.equal(isFontFileUrl('https://x.y/f.TTF'), true);
  assert.equal(isFontFileUrl('https://fonts.googleapis.com/css2?family=Press+Start+2P'), false);
});
