/**
 * Bitmap fonts for small text.
 *
 * Below 8 px, text drawn by the browser from `monospace`, `sans-serif` or `serif` is
 * mostly half-covered grey pixels, so on a two-colour panel it breaks into fragments
 * whatever the dither. And those three names are each OS's own choice of font, so the
 * same document gave a different BMP on Windows, macOS and Linux. Small text in those
 * families is drawn from hand-made glyph tables instead (pixelfont-data.js, from the
 * Adafruit GFX Library): every pixel ink or paper, identical on every machine, and the
 * same glyphs an Arduino sketch draws.
 *
 *   4–6 px  Tom Thumb 3×5   (6 px line, 4 px per character)
 *   7 px    Adafruit GFX 5×7 (8 px line, 6 px per character)
 *
 * A font the user names explicitly (an icon font, say) is never substituted.
 *
 * Pure — no DOM, no Konva — so `node --test` reaches it. pixeltext.js draws with it.
 */

import { FIRST_CHAR, GFX_5X7, TOM_THUMB } from './pixelfont-data.js';

/** Text smaller than this, in a generic family, is drawn from a bitmap font. */
export const PIXEL_TEXT_BELOW = 8;

/** The families the editor offers. Each OS fills them with a font of its own choosing. */
const GENERIC_FAMILIES = new Set(['monospace', 'sans-serif', 'serif']);

export const PIXEL_FONTS = { tomThumb: TOM_THUMB, gfx5x7: GFX_5X7 };

/** The bitmap font that stands in for `fontSize`px `family`, or null to draw it as type. */
export function pixelFontFor(fontSize, family = 'monospace') {
  const size = Number(fontSize);
  if (!(size < PIXEL_TEXT_BELOW)) return null;
  const first = String(family || 'monospace').split(',')[0].trim().replace(/^["']|["']$/g, '');
  if (!GENERIC_FAMILIES.has(first)) return null;
  return size >= 7 ? GFX_5X7 : TOM_THUMB;
}

/**
 * The few characters past ASCII that the app itself puts in small text: the dash an
 * unread value shows, an ellipsis, and the degree sign on a temperature. The degree sign
 * is drawn here; the others borrow the nearest ASCII glyph.
 */
const SUBSTITUTES = { '—': '-', '–': '-', '−': '-', '…': '.', ' ': ' ' };
const EXTRA_GLYPHS = new Map([
  [TOM_THUMB, { '°': [4, 0, 0, 3, 0b010, 0b101, 0b010] }],
  [GFX_5X7, { '°': [6, 0, 0, 4, 0b0110, 0b1001, 0b1001, 0b0110] }],
]);

/** The glyph for one character; anything else outside printable ASCII draws as '?'. */
function glyphOf(font, ch) {
  const extra = EXTRA_GLYPHS.get(font)?.[ch];
  if (extra) return extra;
  const code = (SUBSTITUTES[ch] ?? ch).codePointAt(0);
  return font.glyphs[code - FIRST_CHAR] || font.glyphs['?'.charCodeAt(0) - FIRST_CHAR];
}

/** Width of `text` in `font`, in px, including each character's trailing gap. */
export function pixelTextWidth(font, text, letterSpacing = 0) {
  let w = 0;
  for (const ch of String(text)) w += glyphOf(font, ch)[0] + letterSpacing;
  return w;
}

/**
 * Every horizontal run of ink in `text`, as fn(x, y, length), with (0, 0) the top left
 * of the line cell. Runs rather than pixels so a canvas draws a glyph row in one call.
 */
export function pixelTextRuns(font, text, fn, letterSpacing = 0) {
  let cx = 0;
  for (const ch of String(text)) {
    const [adv, xo, top, w, ...rows] = glyphOf(font, ch);
    rows.forEach((row, y) => {
      let x = 0;
      while (x < w) {
        if (!((row >> (w - 1 - x)) & 1)) { x++; continue; }
        const start = x;
        while (x < w && (row >> (w - 1 - x)) & 1) x++;
        fn(cx + xo + start, top + y, x - start);
      }
    });
    cx += adv + letterSpacing;
  }
}

/**
 * Layout numbers for text at `fontSize`px in `family`: the width of one character, the
 * line height and the height of a capital, from the bitmap font when one stands in and
 * as estimates for the browser's type otherwise. Widgets lay their labels out with these
 * so a gutter fits the text that is actually drawn in it.
 */
export function textMetrics(fontSize, family = 'monospace') {
  const f = pixelFontFor(fontSize, family);
  if (f) return { charW: f.advance, lineH: f.lineH, capH: f.ascent, pixel: true };
  return { charW: fontSize * 0.62, lineH: fontSize, capH: fontSize, pixel: false };
}
