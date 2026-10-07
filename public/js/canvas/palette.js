/**
 * The display descriptor the whole render pipeline reads, plus the panel
 * palettes it quantizes to.
 *
 * `display` is mutable shared state on purpose: it is the one object that the
 * editor, the config form and the render call all agree on. Everything that changes it also has to re-fit the
 * canvas and invalidate any dither preview — see config.js, which owns the form
 * bindings that do exactly that.
 */

/**
 * The panel's blank page: what every palette calls white, and the default background.
 *
 * Pure white. It was the e-paper tint #F2F4EF, which looked right on screen but is not
 * what a photo's white is, and not a fixed point of the ordered dither (which thresholds
 * each channel against 0 and 255): blank paper came out speckled with ink. The firmware
 * maps every BMP palette entry by brightness, so it draws either one as white.
 */
export const PAPER = '#FFFFFF';

/** The paper colour documents were saved with before PAPER became pure white. */
export const LEGACY_PAPER = '#F2F4EF';

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

/**
 * The colours each panel type can show — the single source of truth the renderer
 * (canvas/bitmap.js) quantizes to. Originally extracted from the ImageMagick
 * `-remap` PNGs now kept under test/fixtures/palettes/ as provenance.
 *
 * Order here is for the editor's swatches only: the BMP palette that reaches the
 * panel is in the renderer's octree order, exactly as ImageMagick emitted it.
 */
export const PALETTES = {
  mono:      ['#2F2429', PAPER],
  gray4:     ['#2F2429', '#70696B', '#B1AFAD', PAPER],
  tricolor:  ['#2F2429', PAPER, '#D72627'],
  // black/white/red/yellow; red+yellow from the product 6373 datasheet
  quadcolor: ['#2F2429', PAPER, '#FD2A00', '#FFFF03'],
};

/**
 * A saved document with every LEGACY_PAPER colour swapped for PAPER.
 *
 * Every colour a document holds — the display background, inks, fills, text-box
 * backgrounds, lamp and battery shades, series colours — is a palette entry, so the old
 * paper can appear anywhere a colour can. Walking the whole tree rather than listing the
 * fields means a colour field added later is migrated without anyone remembering to.
 * Returns a copy; the input is not touched.
 */
export function migrateLegacyPaper(doc) {
  const legacy = LEGACY_PAPER.toLowerCase();
  const walk = (v) => {
    if (typeof v === 'string') return v.length === 7 && v.toLowerCase() === legacy ? PAPER : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(doc);
}

export const MODE_LABELS = {
  mono: 'mono',
  gray4: '4 grays',
  tricolor: 'black/white/red',
  quadcolor: 'black/white/red/yellow',
};

/**
 * Panels whose firmware entry already turns the portrait scan buffer on its side, so
 * rotation 0 is LANDSCAPE on the glass. The MagTag's 128×296 buffer is presented as
 * 296×128 at rotation 0; the editor's canvas has to agree or the bitmap it ships is
 * the wrong way round. Every other catalogued panel shows its buffer as-is at 0.
 * 'magtag-2025' is the MagTag's old id, kept so a canvas.json saved under it still
 * imports landscape.
 */
export const LANDSCAPE_AT_ZERO_PANELS = new Set(['magtag', 'magtag-2025']);

export function landscapeAtZero(panel = display.panel) {
  return LANDSCAPE_AT_ZERO_PANELS.has(String(panel || '').trim());
}

/** Logical canvas dimensions once rotation (and the firmware's own step) is applied. */
export function logicalDims() {
  return logicalDimsOf(display);
}

/**
 * The same answer for any descriptor, not just the live one — an imported document
 * carries the display it was authored on, and fitting it means knowing how big THAT
 * canvas was.
 */
export function logicalDimsOf(d) {
  const swap = ((d.rotation || 0) % 180 !== 0) !== landscapeAtZero(d.panel || '');
  return {
    w: swap ? d.height : d.width,
    h: swap ? d.width : d.height,
  };
}

export function hexToRGB(hex) {
  if (typeof hex !== 'string') return [0, 0, 0]; // elements without a fill (e.g. images)
  const v = hex.replace('#', '');
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

/** The entry of `palHex` nearest to `hex`, by straight RGB distance. */
export function nearestColor(hex, palHex) {
  const c = hexToRGB(hex);
  let best = palHex[0], bestD = Infinity;
  for (const p of palHex) {
    const [r, g, b] = hexToRGB(p);
    const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

export const isHexColor = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

/**
 * The display background a document asks for, as a colour this panel can show.
 *
 * Restricted to the palette, like every ink: anything else would only dither into a
 * speckle of the colours either side of it. A document saved before the field existed
 * has none and gets PAPER, which is what its canvas always was, so an old layout loads
 * exactly as it looked. PAPER is in every palette, so the fallback never needs snapping.
 */
export function paletteBackground(bg, type = display.type) {
  if (!isHexColor(bg)) return PAPER;
  return nearestColor(bg, PALETTES[type] || PALETTES.mono);
}

/**
 * A palette entry is "neutral" when its channels are near-equal. Derived rather
 * than hardcoded so a new palette gets the right behaviour for free. The ink
 * hex isn't a pure grey (#2F2429), hence the tolerance rather than r === g === b.
 *   mono / tricolor / quadcolor -> [ink, paper];  gray4 -> all four shades.
 */
export function isNeutralHex(hex) {
  const [r, g, b] = hexToRGB(hex);
  return Math.max(r, g, b) - Math.min(r, g, b) <= 24;
}

export function neutralShades() {
  return PALETTES[display.type].filter(isNeutralHex);
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
