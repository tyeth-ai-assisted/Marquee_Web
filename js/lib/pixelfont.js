/**
 * The bitmap fonts: two glyph tables from the Adafruit GFX Library (pixelfont-data.js),
 * offered in the font menu beside the bundled IBM Plex faces (fonts.js).
 *
 * Text a canvas draws from an outline font is made of anti-aliased grey pixels. Below
 * 8 px it is mostly grey, so on a two-colour panel it breaks into fragments. A bitmap
 * font has every pixel ink or paper, draws identically on every host, and has the same
 * glyphs an Arduino sketch draws.
 *
 *   tom-thumb   Tom Thumb 3×5        6 px line, 4 px per character
 *   gfx-5x7     Adafruit GFX 5×7     8 px line, 6 px per character
 *
 * A bitmap font is used only when it is CHOSEN: the font menu says which font draws
 * every text, and nothing is swapped behind the user's back. A widget's own captions
 * (a gauge's value, a battery's percentage) have no menu, so the widget picks one for
 * itself below 8 px (captionFamily). A bitmap font's "size" is read the way an Arduino
 * sketch reads setTextSize: the glyphs are drawn at the largest whole multiple of their
 * native line that fits the size asked for, so 12 px Tom Thumb is the 3×5 glyphs at 2×,
 * crisp, and 7 px Tom Thumb is 1×. fontAdvice() says so beside the size field, and warns
 * when an outline font is asked for a size it cannot draw cleanly.
 *
 * Pure: no DOM, no Konva. pixeltext.js draws with it, in the editor and on a server.
 */

import { FIRST_CHAR, GFX_5X7, TOM_THUMB } from './pixelfont-data.js';
import { FONTS, FONT_MONO, TOM_THUMB_FAMILY, GFX_5X7_FAMILY, fontLabel } from './fonts.js';

/** Below this, text drawn from an outline font is mostly grey and fragments on the panel. */
export const PIXEL_TEXT_BELOW = 8;

export const PIXEL_FONTS = { tomThumb: TOM_THUMB, gfx5x7: GFX_5X7 };

/** The bitmap fonts by the family a text carries. */
const BITMAP_BY_FAMILY = new Map([[TOM_THUMB_FAMILY, TOM_THUMB], [GFX_5X7_FAMILY, GFX_5X7]]);

/** Is `family` one of the bitmap fonts? */
export const isBitmapFamily = (family) => BITMAP_BY_FAMILY.has(family);

/** The bitmap font `family` names, or null when it is an outline font. */
export function pixelFontFor(family) {
  return BITMAP_BY_FAMILY.get(family) || null;
}

/**
 * How many panel pixels each glyph pixel covers at `fontSize`: the largest whole
 * multiple of the font's line that fits, never less than 1. Tom Thumb (6 px line) at
 * 4–11 px is 1×, at 12–17 px 2×; the 5×7 (8 px line) at 7–15 px is 1×, at 16 px 2×.
 */
export function pixelScale(font, fontSize) {
  return Math.max(1, Math.floor(Number(fontSize) / font.lineH) || 1);
}

/**
 * The font a widget draws its own captions in at `size`: a gauge's value, a battery's
 * percentage. These have no font menu; the widget picks its type as it picks its sizes,
 * and under 8 px that is a bitmap font, since outline type cannot draw that small on a
 * panel. At 8 px and up it is Plex Mono, as it always was.
 */
export function captionFamily(size) {
  if (size >= PIXEL_TEXT_BELOW) return FONT_MONO;
  return size >= GFX_5X7.lineH - 1 ? GFX_5X7_FAMILY : TOM_THUMB_FAMILY;
}

/**
 * The CSS family a text's inline editor (a textarea) shows it in. A bitmap font is
 * drawn from its glyph table, which the textarea has no way to use, so it gets the
 * bundled mono, which has the same fixed pitch.
 */
export function cssFamily(family) {
  return isBitmapFamily(family) ? FONT_MONO : family;
}

/**
 * What to say beside the size field about `family` at `fontSize`, or null when nothing
 * needs saying. `warn` is for an outline font below 8 px, which the panel cannot draw
 * cleanly: the advice names the bitmap font nearest the size. `note` is for a bitmap
 * font at a size between its steps, which draws at the step below.
 */
export function fontAdvice(family, fontSize) {
  const label = fontLabel(family);
  const size = Math.round(Number(fontSize));
  if (!Number.isFinite(size)) return null;
  const font = pixelFontFor(family);
  if (!font) {
    if (size >= PIXEL_TEXT_BELOW) return null;
    const pick = FONTS.find((o) => o.family === captionFamily(size));
    return {
      level: 'warn',
      text: `${label} breaks up below ${PIXEL_TEXT_BELOW} px on the panel. Use ${pick.label} (${pick.note}) instead.`,
    };
  }
  if (size % font.lineH === 0) return null;
  const scale = pixelScale(font, size);
  const steps = [1, 2, 3].map((n) => `${n * font.lineH}`);
  return {
    level: 'note',
    text: `${label} draws in whole ${font.lineH} px steps: ${size} px draws at ${scale * font.lineH} px (${scale}×). Use ${steps[0]}, ${steps[1]} or ${steps[2]} px.`,
  };
}

/**
 * The few characters past ASCII that the app itself puts in small text: the dash an
 * unread value shows, an ellipsis, and the degree sign on a temperature. The degree sign
 * is drawn here; the others borrow the nearest ASCII glyph.
 */
const SUBSTITUTES = { '—': '-', '–': '-', '−': '-', '…': '.', ' ': ' ' };
/** Characters that draw nothing and take no space: presentation selectors and the joiner. */
const ZERO_WIDTH = /[︎️‍]/;
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

/** Width of `text` in `font` at `scale`, in px, including each character's trailing gap. */
export function pixelTextWidth(font, text, letterSpacing = 0, scale = 1) {
  let w = 0;
  for (const ch of String(text)) {
    if (ZERO_WIDTH.test(ch)) continue;
    w += glyphOf(font, ch)[0] * scale + letterSpacing;
  }
  return w;
}

/**
 * Every horizontal run of ink in `text`, as fn(x, y, length, thickness) in px at
 * `scale`, with (0, 0) the top left of the line cell. Runs rather than pixels so a
 * canvas draws a glyph row in one call; `thickness` is the scale, the height of a row.
 */
export function pixelTextRuns(font, text, fn, letterSpacing = 0, scale = 1) {
  let cx = 0;
  for (const ch of String(text)) {
    if (ZERO_WIDTH.test(ch)) continue;
    const [adv, xo, top, w, ...rows] = glyphOf(font, ch);
    rows.forEach((row, y) => {
      let x = 0;
      while (x < w) {
        if (!((row >> (w - 1 - x)) & 1)) { x++; continue; }
        const start = x;
        while (x < w && (row >> (w - 1 - x)) & 1) x++;
        fn(cx + (xo + start) * scale, (top + y) * scale, (x - start) * scale, scale);
      }
    });
    cx += adv * scale + letterSpacing;
  }
}

/**
 * Layout numbers for text at `fontSize`px in `family`: the width of one character, the
 * line height and the height of a capital, exact for a bitmap font and estimates for
 * outline type. Widgets lay their labels out with these so a gutter fits the text that
 * is actually drawn in it.
 */
export function textMetrics(fontSize, family = FONT_MONO) {
  const f = pixelFontFor(family);
  if (f) {
    const s = pixelScale(f, fontSize);
    return { charW: f.advance * s, lineH: f.lineH * s, capH: f.ascent * s, pixel: true };
  }
  return { charW: fontSize * 0.62, lineH: fontSize, capH: fontSize, pixel: false };
}
