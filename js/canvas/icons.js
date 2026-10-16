/**
 * The load gate for the faces canvas text needs. The icon glyph table is lib/icons.js,
 * re-exported here so editor code has one place to import from.
 */

import { FA_FAMILY, FA_WEIGHT } from '../lib/icons.js';
import { FONT_FILES } from '../lib/fonts.js';

export {
  FA_FAMILY, FA_WEIGHT, FA_LINK, GAUGE_ICONS, DEFAULT_GAUGE_ICON, iconGlyph,
} from '../lib/icons.js';

// ---------- the font-ready gate ---------------------------------------------
//
// Canvas text needs its faces actually loaded, and @font-face loading is lazy: the first
// paint after a cold load would draw substitute glyphs, and the dither preview would cache
// that. So text and icon-bearing widgets are re-built once every face has resolved: the
// icon font and the IBM Plex faces text draws in (lib/fonts.js).

let readyPromise = null;

export function fontsReady() {
  if (readyPromise) return readyPromise;
  const faces = [`${FA_WEIGHT} 16px "${FA_FAMILY}"`, ...FONT_FILES.map((f) => `${f.weight} 16px "${f.family}"`)];
  readyPromise = document.fonts
    ? Promise.all(faces.map((face) => document.fonts.load(face))).then(() => true, () => false)
    : Promise.resolve(false);
  return readyPromise;
}

/**
 * Run `fn` once the faces have resolved. Never rejects: a failed load leaves the
 * browser's substitute glyphs, which are visible and reportable, rather than
 * throwing from inside a widget rebuild.
 */
export function onFontsReady(fn) {
  fontsReady().then(fn);
}
