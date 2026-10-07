/**
 * Per-image dithering.
 *
 * Dithering is for pictures. Error diffusion run over the whole panel also reaches every
 * anti-aliased glyph edge and chart line, leaving specks round the text and gaps in thin
 * diagonals, so it is no longer applied to the scene as a whole. Each picture is dithered
 * on its own, at exactly the size it is drawn on the panel, and swapped into the scene for
 * the capture; the whole-panel pass then only snaps to the nearest palette colour
 * (render.js). Palette colours map to themselves under that pass, so a dithered picture
 * passes through it untouched and nothing else is ever dithered.
 *
 * The display's dither settings are the default for pictures. A picture can override them
 * with its own `dither` attr ('inherit' or absent = the default).
 *
 * The top half is pure (pixels in, pixels out) so `node --test` reaches it; only
 * withDitheredImages() and ditheredImageCanvas() touch the DOM.
 */

import { display, PALETTES, hexToRGB } from './palette.js';
import { renderIndexedBmp, RENDER_METHOD } from './bitmap.js';

/** What an image's own `dither` may be. 'inherit' follows the display. */
export const IMAGE_DITHERS = ['inherit', 'FloydSteinberg', 'ordered', 'none'];

/**
 * The dither settings one picture is drawn with: its own when it has them, otherwise
 * the display's. `diffusion` may be set per picture for Floyd–Steinberg; the ordered map
 * size always comes from the display.
 */
export function imageDitherOf(attrs = {}, d = display) {
  const own = attrs.dither;
  if (own && own !== 'inherit' && IMAGE_DITHERS.includes(own)) {
    return {
      dither: own,
      diffusion: Number.isFinite(attrs.diffusion) ? attrs.diffusion : d.diffusion,
      orderedMap: d.orderedMap,
    };
  }
  return { dither: d.dither || 'FloydSteinberg', diffusion: d.diffusion, orderedMap: d.orderedMap };
}

/**
 * Dither RGBA pixels to a palette, keeping transparency.
 *
 * A partly transparent pixel is composited over `background` (the page it will land on)
 * before it is dithered, and comes out either opaque (alpha >= 128) or fully transparent,
 * so whatever sits under a cut-out PNG still shows through it. Every opaque pixel of the
 * result is an exact palette colour.
 *
 * @returns {Uint8ClampedArray} w*h*4 RGBA
 */
export function ditherPixels(rgba, w, h, paletteHexes, background, { dither, diffusion, orderedMap }) {
  const [br, bg, bb] = hexToRGB(background);
  const flat = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h * 4; i += 4) {
    const a = rgba[i + 3] / 255;
    flat[i] = Math.round(rgba[i] * a + br * (1 - a));
    flat[i + 1] = Math.round(rgba[i + 1] * a + bg * (1 - a));
    flat[i + 2] = Math.round(rgba[i + 2] * a + bb * (1 - a));
    flat[i + 3] = 255;
  }
  const { indices, colormap } = renderIndexedBmp(flat, w, h, paletteHexes, {
    method: RENDER_METHOD[dither] || 'floyd', diffusion, orderedMap,
  });
  const out = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < indices.length; p++) {
    const c = colormap[indices[p]], i = p * 4;
    out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2];
    out[i + 3] = rgba[i + 3] >= 128 ? 255 : 0;
  }
  return out;
}

// ---------- DOM -------------------------------------------------------------

/** A stable id per decoded picture, so the cache can key on it without holding it. */
const sourceIds = new WeakMap();
let nextSourceId = 1;
function sourceId(img) {
  if (!sourceIds.has(img)) sourceIds.set(img, nextSourceId++);
  return sourceIds.get(img);
}

/**
 * Recently dithered pictures. A render runs on every live take and every preview refresh,
 * and most of them change nothing about the pictures, so the work is kept. Small, because
 * a scene holds a handful of pictures and a stale entry is just memory.
 */
const cache = new Map();
const CACHE_MAX = 24;

/**
 * `img` (cropped to `crop` when given) scaled to w×h and dithered, as a canvas the same
 * size. The scaling is done here with the browser's best filter, not by Konva at capture
 * time, because the dither has to see the pixels the panel will get.
 */
export function ditheredImageCanvas(img, crop, w, h, opts, type = display.type, background = display.background) {
  const key = [sourceId(img), crop ? `${crop.x},${crop.y},${crop.width},${crop.height}` : '-', w, h,
    type, background, opts.dither, opts.diffusion, opts.orderedMap].join('|');
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }

  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  // willReadFrequently pins this canvas to the CPU rasterizer, so the same picture scales
  // to the same pixels every time and an idle scene never dithers into a "new" take
  // (see withSoftwareRaster in stage.js).
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (crop) ctx.drawImage(img, crop.x, crop.y, crop.width, crop.height, 0, 0, w, h);
  else ctx.drawImage(img, 0, 0, w, h);
  const src = ctx.getImageData(0, 0, w, h);
  const px = ditherPixels(src.data, w, h, PALETTES[type] || PALETTES.mono, background, opts);
  ctx.putImageData(new ImageData(px, w, h), 0, 0);

  cache.set(key, c);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return c;
}

/** The element a Konva.Image belongs to: itself for a static image, its frame for a feed image. */
function ownerOf(k) {
  if (k.getAttr('etype') === 'image') return k;
  const g = k.findAncestor('.element');
  return g && g.getAttr('etype') === 'feedimage' ? g : null;
}

/**
 * Run `fn` with every picture in `layer` replaced by its dithered version, then put the
 * originals back. The swap and the restore are synchronous, so the on-screen stage never
 * draws the dithered pictures; only a capture made inside `fn` sees them.
 */
export function withDitheredImages(layer, fn) {
  const swaps = [];
  try {
    for (const k of layer.find('Image')) {
      const owner = ownerOf(k);
      const img = k.image();
      if (!owner || !img || !k.isVisible()) continue;
      const w = Math.max(1, Math.round(k.width() * k.scaleX()));
      const h = Math.max(1, Math.round(k.height() * k.scaleY()));
      const crop = k.crop();
      const cropped = crop && crop.width > 0 && crop.height > 0 ? crop : null;
      const canvas = ditheredImageCanvas(img, cropped, w, h, imageDitherOf(owner.attrs));
      swaps.push({ k, img, crop: cropped, width: k.width(), height: k.height(), scaleX: k.scaleX(), scaleY: k.scaleY() });
      k.image(canvas);
      k.crop({ x: 0, y: 0, width: 0, height: 0 });
      k.size({ width: w, height: h });
      k.scale({ x: 1, y: 1 });
    }
    return fn();
  } finally {
    for (const s of swaps) {
      s.k.image(s.img);
      s.k.crop(s.crop || { x: 0, y: 0, width: 0, height: 0 });
      s.k.size({ width: s.width, height: s.height });
      s.k.scale({ x: s.scaleX, y: s.scaleY });
    }
  }
}
