/**
 * The typefaces elements draw in, bundled so the editor and a server render draw the same
 * glyphs: IBM Plex Mono, Sans and Serif (SIL Open Font License), regular and bold, and two
 * bitmap fonts from the Adafruit GFX Library (BSD), drawn pixel by pixel from glyph tables
 * (pixelfont.js). The Plex files are in public/fonts/; each host loads them its own way (a
 * FontFace in the browser, skia-canvas's FontLibrary on a server). The bitmap fonts are
 * code, so every host already has them.
 */

import { TOM_THUMB, GFX_5X7 } from './pixelfont-data.js';

export const FONT_MONO = 'IBM Plex Mono';
export const FONT_SANS = 'IBM Plex Sans';
export const FONT_SERIF = 'IBM Plex Serif';

/** The bitmap fonts' family names, as a text stores them. */
export const TOM_THUMB_FAMILY = 'tom-thumb';
export const GFX_5X7_FAMILY = 'gfx-5x7';

/** Below this, outline type is mostly grey and fragments on the panel; see pixelfont.js. */
const CLEAN_FROM_PX = 8;

/**
 * The choices the inspector offers, in its order. `note` is the size each is useful at,
 * shown in brackets after the name so the menu says what it means to pick one.
 */
export const FONTS = [
  { family: FONT_MONO, label: 'Mono', note: `${CLEAN_FROM_PX} px and up` },
  { family: FONT_SANS, label: 'Sans', note: `${CLEAN_FROM_PX} px and up` },
  { family: FONT_SERIF, label: 'Serif', note: `${CLEAN_FROM_PX} px and up` },
  { family: TOM_THUMB_FAMILY, label: 'Tom Thumb 3×5', note: `${TOM_THUMB.lineH} px steps`, bitmap: true },
  { family: GFX_5X7_FAMILY, label: 'Adafruit 5×7', note: `${GFX_5X7.lineH} px steps`, bitmap: true },
];

/** A family's menu name. */
export function fontLabel(family) {
  return FONTS.find((f) => f.family === family)?.label || family;
}

/** Every face to load, relative to public/fonts/. Chart titles are bold. */
export const FONT_FILES = [
  { family: FONT_MONO, weight: '400', file: 'IBMPlexMono-Regular.woff2' },
  { family: FONT_MONO, weight: '700', file: 'IBMPlexMono-Bold.woff2' },
  { family: FONT_SANS, weight: '400', file: 'IBMPlexSans-Regular.woff2' },
  { family: FONT_SANS, weight: '700', file: 'IBMPlexSans-Bold.woff2' },
  { family: FONT_SERIF, weight: '400', file: 'IBMPlexSerif-Regular.woff2' },
  { family: FONT_SERIF, weight: '700', file: 'IBMPlexSerif-Bold.woff2' },
];

// Documents saved before the fonts were bundled name the browser's generic families, which
// drew differently on every machine. Each loads as its Plex equivalent.
const LEGACY = { monospace: FONT_MONO, 'sans-serif': FONT_SANS, serif: FONT_SERIF };

/** A bundled family for any saved name: itself, its Plex equivalent, or Plex Mono. */
export function normalizeFontFamily(family) {
  // A bitmap font saved as a CSS stack ("tom-thumb, monospace") is still that font.
  const first = String(family ?? '').split(',')[0].trim().replace(/^["']|["']$/g, '');
  if (first === TOM_THUMB_FAMILY || first === GFX_5X7_FAMILY) return first;
  if (FONTS.some((f) => f.family === family)) return family;
  return LEGACY[family] || FONT_MONO;
}
