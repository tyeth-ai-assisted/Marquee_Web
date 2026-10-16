/**
 * The display descriptor the whole render pipeline reads, and the helpers bound
 * to it. The palettes and the pure colour/geometry rules live in lib/palette.js and
 * are re-exported here, so editor code has one place to import from.
 *
 * `display` is mutable shared state on purpose: it is the one object that the
 * editor, the config form and the render call all agree on. Everything that changes it also has to re-fit the
 * canvas and invalidate any dither preview — see config.js, which owns the form
 * bindings that do exactly that.
 */

import {
  PAPER, PALETTES, landscapeAtZero as landscapeAtZeroOf, logicalDimsOf,
  paletteBackground as paletteBackgroundOf, neutralShadesOf,
} from '../lib/palette.js';

export {
  PAPER, LEGACY_PAPER, PALETTES, MODE_LABELS, LANDSCAPE_AT_ZERO_PANELS, logicalDimsOf,
  hexToRGB, nearestColor, isHexColor, isNeutralHex, migrateLegacyPaper,
} from '../lib/palette.js';

/**
 * Seeded with the MagTag, matching the DISPLAY_PRESETS entry and the HTML
 * defaults in index.html. width/height are the panel's NATIVE scan geometry —
 * the 2.9" is a portrait 128×296 buffer — and `rotation` is the 90° step the
 * config asks the firmware to apply on top of it. `panel` is the firmware's panel
 * id, carried here because for some panels it changes what rotation 0 LOOKS like
 * (see LANDSCAPE_AT_ZERO_PANELS). logicalDims() below is the one that answers
 * "how big is the canvas".
 */
export const display = {
  width: 128,        // physical panel width, before rotation
  height: 296,       // physical panel height, before rotation
  rotation: 0,       // 0 | 90 | 180 | 270 (degrees)
  panel: 'magtag',
  type: 'mono',      // mono | gray4 | tricolor | quadcolor
  dither: 'FloydSteinberg',
  diffusion: 85,
  orderedMap: 8,
  // The colour the canvas starts as, before any element is drawn on it. Unlike the
  // fields above it is part of the ARTWORK, not the bench: deserialize() takes it from
  // the document even when it keeps this descriptor. Always a colour of the current
  // palette — see paletteBackground().
  background: PAPER,
};

export function landscapeAtZero(panel = display.panel) {
  return landscapeAtZeroOf(panel);
}

/** Logical canvas dimensions once rotation (and the firmware's own step) is applied. */
export function logicalDims() {
  return logicalDimsOf(display);
}

export function paletteBackground(bg, type = display.type) {
  return paletteBackgroundOf(bg, type);
}

export function neutralShades() {
  return neutralShadesOf(display.type);
}

/**
 * Roughly how long this panel takes to put a new image on the glass, in seconds.
 *
 * E-ink refresh is a physical process, so it scales with BOTH the color mode and
 * the panel area: a mono 2.9" clears in a couple of seconds, while a four-color
 * 7.5" spends most of half a minute cycling its particles. These are
 * datasheet-order FULL refresh times — a board waking from deep sleep has no
 * previous frame to do a partial update against — fitted as a floor plus a
 * per-megapixel slope:
 *
 *   mono       2.9" ≈  2s    7.5" ≈  5s
 *   gray4      2.9" ≈  3s    7.5" ≈  8s
 *   tricolor   2.9" ≈ 14s    7.5" ≈ 25s
 *   quadcolor  2.9" ≈ 19s    7.5" ≈ 30s
 *
 * An estimate, and used only where being EARLY is the failure — a take promoted onto
 * "on the panel now" before the panel has finished flashing is claiming a redraw that
 * has not happened yet.
 */
const REFRESH_FIT = {
  mono:      { base: 1.5, perMpx: 8 },
  gray4:     { base: 3,   perMpx: 12 },
  tricolor:  { base: 13,  perMpx: 30 },
  quadcolor: { base: 18,  perMpx: 30 },
};

export function panelRefreshSeconds() {
  const { base, perMpx } = REFRESH_FIT[display.type] || REFRESH_FIT.mono;
  // Native geometry, not logicalDims(): rotation doesn't change how many pixels
  // the driver has to cycle.
  return Math.round(base + perMpx * (display.width * display.height) / 1e6);
}

/** Human-readable summary of the active dither method + its parameter. */
export function ditherLabel() {
  if (display.dither === 'none') return 'no dither';
  if (display.dither === 'ordered') return `ordered o${display.orderedMap}×${display.orderedMap}`;
  return `Floyd–Steinberg ${display.diffusion}%`;
}

/**
 * The same value on the face of A7's dither trigger. ditherLabel() is written to
 * sit inside a line of prose ("… · no dither · shown at 2×"); the chip IS the
 * control, so it names the option the way the option names itself — "None", not
 * "no dither", and with no percentage to tune when there is nothing to tune.
 */
export function ditherChipLabel() {
  if (display.dither === 'none') return 'None';
  if (display.dither === 'ordered') return `Ordered o${display.orderedMap}×${display.orderedMap}`;
  return `Floyd–Steinberg ${display.diffusion}%`;
}
