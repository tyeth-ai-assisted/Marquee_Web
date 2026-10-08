/**
 * The editor's fonts, and the bitmap ones among them.
 *
 * Text drawn by the browser from `monospace`, `sans-serif`, `serif` or a web font is
 * made of anti-aliased grey pixels. Below 8 px it is mostly grey, so on a two-colour
 * panel it breaks into fragments whatever the dither — and the three generic names are
 * each OS's own choice of font, so the same document gives a different BMP on Windows,
 * macOS and Linux. Two bitmap fonts from the Adafruit GFX Library are offered beside
 * them (pixelfont-data.js): every pixel ink or paper, identical on every machine, and
 * the same glyphs an Arduino sketch draws.
 *
 *   tom-thumb   Tom Thumb 3×5        6 px line, 4 px per character
 *   gfx-5x7     Adafruit GFX 5×7     8 px line, 6 px per character
 *
 * A bitmap font is used only when it is CHOSEN — the font menu says which font draws
 * every text, and nothing is swapped behind the user's back. Its "size" is read the way
 * an Arduino sketch reads setTextSize: the glyphs are drawn at the largest whole
 * multiple of their native line that fits the size asked for, so 12 px Tom Thumb is the
 * 3×5 glyphs at 2×, crisp, and 7 px Tom Thumb is 1×. fontAdvice() says so beside the
 * field, and warns when a browser font is asked for a size it cannot draw cleanly.
 *
 * Pure — no DOM, no Konva — so `node --test` reaches it. pixeltext.js draws with it.
 */

import { FIRST_CHAR, GFX_5X7, TOM_THUMB } from './pixelfont-data.js';

/** Below this, text the browser draws is mostly grey and fragments on the panel. */
export const PIXEL_TEXT_BELOW = 8;

export const PIXEL_FONTS = { tomThumb: TOM_THUMB, gfx5x7: GFX_5X7 };

/** The bitmap fonts by the family id a text carries. */
const BITMAP_BY_ID = new Map([['tom-thumb', TOM_THUMB], ['gfx-5x7', GFX_5X7]]);

/**
 * The fonts the editor offers, in menu order. `note` is the size each is useful at,
 * shown in brackets after the name so the menu says what it means to pick one.
 * A browser font is any family not in this list with a bitmap: the three generic
 * names, or a web font loaded from a URL (webfont.js).
 */
export const FONT_OPTIONS = [
  { id: 'monospace', label: 'Mono', note: `${PIXEL_TEXT_BELOW} px and up` },
  { id: 'sans-serif', label: 'Sans', note: `${PIXEL_TEXT_BELOW} px and up` },
  { id: 'serif', label: 'Serif', note: `${PIXEL_TEXT_BELOW} px and up` },
  { id: 'tom-thumb', label: 'Tom Thumb 3×5', note: `${TOM_THUMB.lineH} px steps`, bitmap: TOM_THUMB },
  { id: 'gfx-5x7', label: 'Adafruit 5×7', note: `${GFX_5X7.lineH} px steps`, bitmap: GFX_5X7 },
];

/** The family a text stores, stripped of CSS quoting and fallbacks: the name it was chosen by. */
export function familyId(family) {
  return String(family || 'monospace').split(',')[0].trim().replace(/^["']|["']$/g, '');
}

/** The bitmap font `family` names, or null when the browser draws it. */
export function pixelFontFor(fontSize, family = 'monospace') {
  return BITMAP_BY_ID.get(familyId(family)) || null;
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
 * The font a widget draws its own captions in at `size` — a gauge's value, a battery's
 * percentage, the text in an empty picture frame. These have no font menu: the widget
 * picks its type as it picks its sizes, and under 8 px that is a bitmap font, since
 * browser type cannot draw that small on a panel. At 8 px and up it is monospace, as it
 * always was.
 */
export function captionFamily(size) {
  if (size >= PIXEL_TEXT_BELOW) return 'monospace';
  return size >= GFX_5X7.lineH - 1 ? 'gfx-5x7' : 'tom-thumb';
}

/** The menu name of a family: the option's label, or the family itself for a web font. */
export function fontLabel(family) {
  const id = familyId(family);
  return FONT_OPTIONS.find((o) => o.id === id)?.label || id;
}

/** The CSS family to draw `family` with on screen (the inline editor's textarea). */
export function cssFamily(family) {
  const id = familyId(family);
  if (BITMAP_BY_ID.has(id)) return 'monospace';
  return /^(monospace|sans-serif|serif)$/.test(id) ? id : `"${id.replace(/"/g, '')}", monospace`;
}

/**
 * What to say beside the size field about `family` at `fontSize`, or null when nothing
 * needs saying. `warn` is for a browser font below 8 px, which the panel cannot draw
 * cleanly: the advice names the bitmap font nearest the size. `note` is for a bitmap
 * font at a size between its steps, which draws at the step below.
 */
export function fontAdvice(family, fontSize) {
  const size = Math.round(Number(fontSize));
  if (!Number.isFinite(size)) return null;
  const font = pixelFontFor(size, family);
  if (!font) {
    if (size >= PIXEL_TEXT_BELOW) return null;
    const pick = FONT_OPTIONS.find((o) => o.id === captionFamily(size));
    return {
      level: 'warn',
      text: `${fontLabel(family)} is drawn by the browser and breaks up below ${PIXEL_TEXT_BELOW} px on the panel. Use ${pick.label} (${pick.note}) instead.`,
    };
  }
  if (size % font.lineH === 0) return null;
  const scale = pixelScale(font, size);
  const steps = [1, 2, 3].map((n) => `${n * font.lineH}`);
  return {
    level: 'note',
    text: `${fontLabel(family)} draws in whole ${font.lineH} px steps: ${size} px draws at ${scale * font.lineH} px (${scale}×). Use ${steps[0]}, ${steps[1]} or ${steps[2]} px.`,
  };
}

/**
 * The few characters past ASCII that the app itself puts in small text: the dash an
 * unread value shows, an ellipsis, and the degree sign on a temperature. The degree sign
 * is drawn here; the others borrow the nearest ASCII glyph.
 */
const SUBSTITUTES = { '—': '-', '–': '-', '−': '-', '…': '.', ' ': ' ' };
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
  for (const ch of String(text)) w += glyphOf(font, ch)[0] * scale + letterSpacing;
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
 * the browser's type. Widgets lay their labels out with these so a gutter fits the text
 * that is actually drawn in it.
 */
export function textMetrics(fontSize, family = 'monospace') {
  const f = pixelFontFor(fontSize, family);
  if (f) {
    const s = pixelScale(f, fontSize);
    return { charW: f.advance * s, lineH: f.lineH * s, capH: f.ascent * s, pixel: true };
  }
  return { charW: fontSize * 0.62, lineH: fontSize, capH: fontSize, pixel: false };
}
