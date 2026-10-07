/**
 * Importing a canvas.json: is it one, how does it differ from the panel in front of
 * the user, and what does it look like fitted onto that panel.
 *
 * Pure on purpose — no DOM, no Konva — so `node --test` can reach it, the same as
 * samples.js. doc.js owns the dialog and the actual load; everything here only
 * answers questions about a document.
 *
 * The active display always wins. A document's `display` block describes the panel
 * it was AUTHORED on, and is read the way hydrateFromCanvasFeed() reads one: as
 * advice. Width, height, rotation and type are never taken from it — the only thing
 * the user may choose to adopt is the dithering, which is an authoring decision that
 * travels with the artwork.
 */

import { PALETTES, logicalDimsOf, isHexColor } from '../canvas/palette.js';
import { IMAGE_DITHERS } from '../canvas/imagedither.js';

/** Every etype deserialize() has a factory for. Anything else would silently load as
 *  a label, which is worse than saying so and leaving it out. */
export const KNOWN_ETYPES = new Set([
  'label', 'divider', 'image', 'linechart', 'gauge', 'indicator', 'battery', 'datetime',
  'feedimage',
]);

const isDataImage = (src) => typeof src === 'string' && src.startsWith('data:image/');

const ROTATIONS = new Set([0, 90, 180, 270]);
const DITHERS = new Set(['FloydSteinberg', 'ordered', 'none']);
const ORDERED_MAPS = new Set([2, 4, 8]);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isPosInt = (v) => Number.isInteger(v) && v > 0;

/**
 * The document's display block, keeping only the fields that make sense. A bad
 * field is a warning, not an error: the elements are still loadable, and the only
 * cost of an unknown size is that the import cannot be fitted.
 */
function validateDisplay(d, warnings) {
  if (d === undefined) return {};
  if (!isObj(d)) { warnings.push('The display block is not an object and was ignored.'); return {}; }
  const out = {};
  const keep = (key, ok, what) => {
    if (d[key] === undefined) return;
    if (ok(d[key])) out[key] = d[key];
    else warnings.push(`display.${key} (${JSON.stringify(d[key])}) is not ${what} and was ignored.`);
  };
  keep('width', isPosInt, 'a positive integer');
  keep('height', isPosInt, 'a positive integer');
  keep('rotation', (v) => ROTATIONS.has(v), '0, 90, 180 or 270');
  keep('type', (v) => Object.hasOwn(PALETTES, v), `one of ${Object.keys(PALETTES).join(', ')}`);
  keep('dither', (v) => DITHERS.has(v), 'FloydSteinberg, ordered or none');
  keep('diffusion', (v) => Number.isFinite(v) && v >= 0 && v <= 100, 'between 0 and 100');
  keep('orderedMap', (v) => ORDERED_MAPS.has(v), '2, 4 or 8');
  // Snapped to this panel's palette on load, like every ink, so any colour will do.
  keep('background', isHexColor, 'a #RRGGBB colour');
  if (typeof d.panel === 'string') out.panel = d.panel;
  // A size is only a size with both halves.
  if (!('width' in out) || !('height' in out)) { delete out.width; delete out.height; }
  return out;
}

/**
 * Parse and check a canvas.json.
 *
 * Errors block the import: the file is not a canvas document, or an element in it is
 * too broken to place. Warnings do not — an element this editor cannot draw is
 * DROPPED from the returned doc rather than guessed at, and the user is told.
 */
export function validateCanvasDoc(text) {
  const errors = [];
  const warnings = [];
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`Not valid JSON: ${e.message}`], warnings, doc: null };
  }
  if (!isObj(raw)) errors.push('The file is not a canvas document (expected a JSON object).');
  else {
    if (raw.version !== undefined && raw.version !== 1) {
      errors.push(`Unsupported canvas.json version ${JSON.stringify(raw.version)} (this editor reads version 1).`);
    }
    if (!Array.isArray(raw.elements)) errors.push('The file has no "elements" array.');
  }
  if (errors.length) return { ok: false, errors, warnings, doc: null };

  const elements = [];
  raw.elements.forEach((el, i) => {
    const at = `Element ${i + 1}`;
    if (!isObj(el)) { errors.push(`${at} is not an object.`); return; }
    if (!Number.isFinite(el.x) || !Number.isFinite(el.y)) {
      errors.push(`${at} (${el.etype ?? 'no etype'}) has no numeric x/y position.`);
      return;
    }
    if (!KNOWN_ETYPES.has(el.etype)) {
      warnings.push(`${at} has an unknown type ${JSON.stringify(el.etype)} and was skipped.`);
      return;
    }
    // A remote URL would taint the stage and break every render after it; an embedded
    // image is the only kind this editor ever writes.
    if (el.etype === 'image' && !isDataImage(el.src)) {
      warnings.push(`${at} is an image without embedded data and was skipped.`);
      return;
    }
    // A feed image's picture is a reading, so it may legitimately be absent — the frame
    // is the design and the next read fills it. A picture that IS there is held to the
    // same rule as a static image's, and dropped (not the element) when it fails.
    if (el.etype === 'feedimage' && el.src != null && !isDataImage(el.src)) {
      warnings.push(`${at} is a feed image whose picture is not embedded data; the picture was dropped.`);
      el = { ...el, src: null, natW: null, natH: null };
    }
    // A picture's own dither. Unknown is not fatal: the picture just follows the panel.
    if ((el.etype === 'image' || el.etype === 'feedimage') && el.dither !== undefined
        && !IMAGE_DITHERS.includes(el.dither)) {
      warnings.push(`${at} has an unknown dither ${JSON.stringify(el.dither)}; it will use the panel default.`);
      el = { ...el };
      delete el.dither;
      delete el.diffusion;
    }
    elements.push(el);
  });
  if (errors.length) return { ok: false, errors, warnings, doc: null };

  const display = validateDisplay(raw.display, warnings);
  return { ok: true, errors, warnings, doc: { version: 1, display, elements } };
}

/**
 * How the document's display differs from the active one. `srcDims` is null when the
 * document carries no usable size — nothing to fit from, so the import is 1:1.
 */
export function compareDisplay(src, dst) {
  const srcDims = src.width && src.height ? logicalDimsOf(src) : null;
  const dstDims = logicalDimsOf(dst);
  return {
    srcDims,
    dstDims,
    sizeDiffers: !!srcDims && (srcDims.w !== dstDims.w || srcDims.h !== dstDims.h),
    typeDiffers: !!src.type && src.type !== dst.type,
    // Only the fields that matter for the chosen method: a diffusion % under an
    // ordered dither is a setting nobody would see.
    ditherDiffers: !!src.dither && (src.dither !== dst.dither
      || (src.dither === 'FloydSteinberg' && src.diffusion !== undefined && src.diffusion !== dst.diffusion)
      || (src.dither === 'ordered' && src.orderedMap !== undefined && src.orderedMap !== dst.orderedMap)),
  };
}

/** The size fields of each etype — the ones the transformend bake in elements.js
 *  scales, plus the fonts that ride inside a widget. */
const SIZE_KEYS = {
  label: ['fontSize', 'width', 'padding'],
  datetime: ['fontSize', 'width', 'padding'],
  divider: ['width', 'height'],
  image: ['w', 'h'],
  feedimage: ['w', 'h'],
  linechart: ['w', 'h', 'axisFontSize'],
  gauge: ['w', 'ringWidth'],
  indicator: ['w'],
  battery: ['w'],
};

/**
 * The document scaled uniformly to fit `dst` and centered on it. A new document —
 * the input is never touched, so the dialog can offer 1:1 and Fit off the same
 * validated doc. Minimum sizes are left to the factories, which clamp on load.
 */
export function fitDoc(doc, srcDims, dstDims) {
  const s = Math.min(dstDims.w / srcDims.w, dstDims.h / srcDims.h);
  const ox = (dstDims.w - srcDims.w * s) / 2;
  const oy = (dstDims.h - srcDims.h * s) / 2;
  const elements = doc.elements.map((el) => {
    const out = { ...el, x: Math.round(el.x * s + ox), y: Math.round(el.y * s + oy) };
    (SIZE_KEYS[el.etype] || []).forEach((k) => {
      if (Number.isFinite(el[k])) out[k] = Math.max(1, Math.round(el[k] * s));
    });
    return out;
  });
  return { ...doc, elements };
}
