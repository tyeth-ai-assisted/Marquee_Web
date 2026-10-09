/**
 * Pure-JS port of the ImageMagick render pipeline this editor used to shell out to:
 *
 *   magick in.png [-dither FloydSteinberg -define dither:diffusion-amount=N% |
 *                  -ordered-dither oNxN | -dither None] -remap eink-<type>.png gif:-
 *   magick gif:- -compress none BMP3:-
 *
 * The output is byte-identical to ImageMagick 7.1.2-27 (Q16 HDRI, macOS build) — see
 * test/bitmap.test.js, which checks every golden BMP ImageMagick produced. To stay
 * identical this file mirrors MagickCore/quantize.c, threshold.c and coders/bmp.c
 * quirk for quirk, and each function names the ImageMagick routine it reproduces.
 * Do not "simplify" the arithmetic: operation order and float rounding are the spec.
 *
 * No DOM here — the same module runs in the browser and under `node --test`.
 */

const QR = 65535.0;               // QuantumRange (Q16)
const QS = 1.0 / 65535.0;         // QuantumScale
const MAX_TREE_DEPTH = 8;
const EQL = 16;                   // ErrorQueueLength (Riemersma)
const ERW = 1.0 / 16;             // ErrorRelativeWeight
const f32 = Math.fround;

/**
 * quantize.c: `#define CacheShift 3` on __APPLE__, 2 elsewhere. The dither paths
 * cache colour lookups by the top (8 - CacheShift) bits of each channel, so this
 * constant decides which pixels share a cached answer. 3 reproduces the macOS
 * `magick` the goldens were made with; a Linux build would need 2 and can differ
 * in rare pixels.
 */
export const CACHE_SHIFT = 3;

/** Editor dither names -> pipeline method names. */
export const RENDER_METHOD = { FloydSteinberg: 'floyd', ordered: 'ordered', none: 'none' };

// ---------- quantum helpers (Q16 HDRI: Quantum is a C float) -----------------

/** pixel-accessor.h ClampPixel(): clamp to [0, QuantumRange], then a float cast. */
function clampPixel(v) {
  if (v < 0.0) return 0.0;
  if (v >= QR) return QR;
  return f32(v);
}

/** quantum.h ScaleQuantumToChar(), Q16 HDRI branch — all in single precision. */
function q2c(q) {
  if (Number.isNaN(q) || q <= 0.0) return 0;
  const scaled = f32(q / 257);
  if (scaled >= 255) return 255;
  return Math.trunc(f32(scaled + 0.5));
}

/** quantize.c ColorToQNodeId() (no alpha: the remap palettes carry none). */
function nodeId(r, g, b, index) {
  return ((q2c(clampPixel(r)) >> index) & 1)
    | (((q2c(clampPixel(g)) >> index) & 1) << 1)
    | (((q2c(clampPixel(b)) >> index) & 1) << 2);
}

/** quantize.c CacheOffset(). */
function cacheOffset(r, g, b) {
  const s = 8 - CACHE_SHIFT;
  return (q2c(clampPixel(r)) >> CACHE_SHIFT)
    | ((q2c(clampPixel(g)) >> CACHE_SHIFT) << s)
    | ((q2c(clampPixel(b)) >> CACHE_SHIFT) << (2 * s));
}

function hexToRgb8(hex) {
  const v = String(hex).replace('#', '');
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

// ---------- the colour cube (-remap) ----------------------------------------

/**
 * quantize.c ClassifyImageColors() on the remap palette image, then
 * SetImageColormap()/DefineImageColormap(). Every palette colour becomes a leaf at
 * depth 8; the colormap is the depth-first walk of the tree (children 0..7, then
 * self), which is why the BMP palette order is NOT the order of PALETTES.
 */
function buildCube(paletteRgb8, withCache) {
  const mk = (parent, level) => ({ parent, child: new Array(8).fill(null), unique: 0, colorNumber: -1, level, total: [0, 0, 0] });
  const root = mk(null, 0);
  root.parent = root;                       // GetQCubeInfo: root->parent = root
  for (const [r8, g8, b8] of paletteRgb8) {
    const r = f32(257.0 * r8), g = f32(257.0 * g8), b = f32(257.0 * b8);
    let node = root, index = MAX_TREE_DEPTH - 1;
    for (let level = 1; level <= MAX_TREE_DEPTH; level++) {
      const id = nodeId(r, g, b, index);
      if (!node.child[id]) node.child[id] = mk(node, level);
      node = node.child[id];
      index--;
    }
    node.unique += 1;
    node.total[0] += 1 * QS * clampPixel(r);
    node.total[1] += 1 * QS * clampPixel(g);
    node.total[2] += 1 * QS * clampPixel(b);
  }
  const colormap = [];
  (function define(n) {
    for (let i = 0; i < 8; i++) if (n.child[i]) define(n.child[i]);
    if (n.unique !== 0) {
      const a = 1.0 / n.unique;             // MagickSafeReciprocal(number_unique)
      n.colorNumber = colormap.length;
      colormap.push([f32(a * QR * n.total[0]), f32(a * QR * n.total[1]), f32(a * QR * n.total[2])]);
    }
  })(root);
  const cube = { root, colormap, cache: null, target: null, distance: 0, colorNumber: 0 };
  if (withCache) {
    cube.cache = new Int32Array(1 << (4 * (8 - CACHE_SHIFT)));
    cube.cache.fill(-1);
  }
  return cube;
}

/** quantize.c ClosestColor(): DFS, ties (`<=`) go to the later node. */
function closestColor(cube, node) {
  for (let i = 0; i < 8; i++) if (node.child[i]) closestColor(cube, node.child[i]);
  if (node.unique !== 0) {
    const p = cube.colormap[node.colorNumber], q = cube.target;
    let pixel = p[0] - q[0], distance = pixel * pixel;
    if (distance <= cube.distance) {
      pixel = p[1] - q[1]; distance += pixel * pixel;
      if (distance <= cube.distance) {
        pixel = p[2] - q[2]; distance += pixel * pixel;
        if (distance <= cube.distance) { cube.distance = distance; cube.colorNumber = node.colorNumber; }
      }
    }
  }
}

/**
 * The lookup every ImageMagick assign/dither loop does: walk the tree down the
 * pixel's bits (levels 7..1) until a child is missing, then search the PARENT's
 * subtree for the closest colour. Not a global nearest-colour search.
 */
function classify(cube, r, g, b) {
  let node = cube.root;
  for (let index = MAX_TREE_DEPTH - 1; index > 0; index--) {
    const id = nodeId(r, g, b, index);
    if (!node.child[id]) break;
    node = node.child[id];
  }
  cube.target = [r, g, b];
  cube.distance = 4.0 * (QR + 1.0) * (QR + 1.0) + 1.0;
  closestColor(cube, node.parent);
  return cube.colorNumber;
}

function lookupCached(cube, r, g, b) {
  const i = cacheOffset(r, g, b);
  let idx = cube.cache[i];
  if (idx < 0) { idx = classify(cube, r, g, b); cube.cache[i] = idx; }
  return idx;
}

// ---------- input stages ----------------------------------------------------

/** Canvas RGBA (8-bit) -> ImageMagick quantum floats (ScaleCharToQuantum: 257*v). */
function toQuantum(rgba, w, h) {
  const out = new Float32Array(w * h * 3);
  for (let i = 0, j = 0; i < w * h * 4; i += 4, j += 3) {
    out[j] = f32(257.0 * rgba[i]);
    out[j + 1] = f32(257.0 * rgba[i + 1]);
    out[j + 2] = f32(257.0 * rgba[i + 2]);
  }
  return out;
}

/** config/thresholds.xml: o2x2, o4x4, o8x8. */
const THRESHOLD_MAPS = {
  2: { w: 2, h: 2, div: 5, lv: [1, 3, 4, 2] },
  4: { w: 4, h: 4, div: 17, lv: [1, 9, 3, 11, 13, 5, 15, 7, 4, 12, 2, 10, 16, 8, 14, 6] },
  8: { w: 8, h: 8, div: 65, lv: [1, 49, 13, 61, 4, 52, 16, 64, 33, 17, 45, 29, 36, 20, 48, 32, 9, 57, 5, 53, 12, 60, 8, 56, 41, 25, 37, 21, 44, 28, 40, 24, 3, 51, 15, 63, 2, 50, 14, 62, 35, 19, 47, 31, 34, 18, 46, 30, 11, 59, 7, 55, 10, 58, 6, 54, 43, 27, 39, 23, 42, 26, 38, 22] },
};

/**
 * threshold.c OrderedDitherImage() with the default 2 levels per channel. Note a
 * channel that is exactly QuantumRange lands on level 1 and can come out as
 * 2*QuantumRange where the map cell is 1; HDRI ClampToQuantum is a bare float cast
 * so ImageMagick keeps that value, and so must we until the remap clamps it.
 */
function orderedDither(rgba, w, h, mapSize) {
  const map = THRESHOLD_MAPS[mapSize];
  const out = new Float32Array(w * h * 3);
  const levels = 1.0;                       // 2 levels, minus one (threshold.c:1970)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const m = map.lv[(x % map.w) + map.w * (y % map.h)];
      const o = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) {
        const q = f32(257.0 * rgba[(y * w + x) * 4 + c]);
        let threshold = Math.trunc(QS * q * (levels * (map.div - 1) + 1));
        const level = Math.trunc(threshold / (map.div - 1));
        threshold -= level * (map.div - 1);
        out[o + c] = f32((level + (threshold >= m ? 1 : 0)) * QR / levels);
      }
    }
  }
  return out;
}

// ---------- assignment stages -----------------------------------------------

/** quantize.c AssignImageColors(), NoDitherMethod branch. Memoised per exact colour
 *  (the answer depends only on the colour, so this cannot change the output). */
function assignNoDither(px, w, h, cube) {
  const idx = new Uint8Array(w * h);
  const memo = new Map();
  for (let i = 0; i < w * h; i++) {
    const r = px[i * 3], g = px[i * 3 + 1], b = px[i * 3 + 2];
    const key = (q2c(r) << 16) | (q2c(g) << 8) | q2c(b);
    let v = memo.get(key);
    if (v === undefined) { v = classify(cube, r, g, b); memo.set(key, v); }
    idx[i] = v;
  }
  return idx;
}

/** quantize.c FloydSteinbergDither(): serpentine, 7/1/5/3 sixteenths, `diffusion`
 *  from -define dither:diffusion-amount. The order of the additions matters. */
function floydSteinberg(px, w, h, cube, diffusion) {
  const idx = new Uint8Array(w * h);
  let current = new Float64Array(w * 3), previous = new Float64Array(w * 3);
  const cm = cube.colormap;
  for (let y = 0; y < h; y++) {
    const odd = (y & 1) !== 0, v = odd ? -1 : 1;
    for (let x = 0; x < w; x++) {
      const u = odd ? w - 1 - x : x;
      const o = (y * w + u) * 3;
      let r = px[o], g = px[o + 1], b = px[o + 2];
      if (x > 0) {
        const k = (u - v) * 3;
        r += 7.0 * diffusion * current[k] / 16;
        g += 7.0 * diffusion * current[k + 1] / 16;
        b += 7.0 * diffusion * current[k + 2] / 16;
      }
      if (y > 0) {
        if (x < w - 1) {
          const k = (u + v) * 3;
          r += diffusion * previous[k] / 16;
          g += diffusion * previous[k + 1] / 16;
          b += diffusion * previous[k + 2] / 16;
        }
        const k0 = u * 3;
        r += 5.0 * diffusion * previous[k0] / 16;
        g += 5.0 * diffusion * previous[k0 + 1] / 16;
        b += 5.0 * diffusion * previous[k0 + 2] / 16;
        if (x > 0) {
          const k = (u - v) * 3;
          r += 3.0 * diffusion * previous[k] / 16;
          g += 3.0 * diffusion * previous[k + 1] / 16;
          b += 3.0 * diffusion * previous[k + 2] / 16;
        }
      }
      r = clampPixel(r); g = clampPixel(g); b = clampPixel(b);
      const i = lookupCached(cube, r, g, b);
      idx[y * w + u] = i;
      const c = cm[i], k = u * 3;
      current[k] = r - c[0]; current[k + 1] = g - c[1]; current[k + 2] = b - c[2];
    }
    const t = current; current = previous; previous = t;
  }
  return idx;
}

/** GetQCubeInfo(): weights along a curve of exponential decay. */
const RIEMERSMA_WEIGHTS = (() => {
  const ws = [];
  let weight = 1.0;
  for (let i = 0; i < EQL; i++) {
    ws.push(1.0 / weight);
    weight *= Math.exp(Math.log(1.0 / ERW) / (EQL - 1.0));
  }
  return ws;
})();

const WEST = 0, EAST = 1, NORTH = 2, SOUTH = 3, FORGET = 4;

/**
 * quantize.c DitherImage() -> Riemersma()/RiemersmaDither(): ImageMagick's DEFAULT
 * dither, which is what `-remap` uses when no -dither flag precedes it (the
 * ordered-dither pipeline). Hilbert-curve walk with a 16-deep error queue. The four
 * recursion cases are transcribed verbatim; they are not symmetric.
 */
function riemersma(px, w, h, cube, diffusion) {
  const idx = new Uint8Array(w * h);
  const cm = cube.colormap;
  const err = new Float64Array(EQL * 3);
  const st = { x: 0, y: 0 };

  function visit(direction) {
    if (st.x >= 0 && st.x < w && st.y >= 0 && st.y < h) {
      const o = (st.y * w + st.x) * 3;
      let r = px[o], g = px[o + 1], b = px[o + 2];
      for (let i = 0; i < EQL; i++) {
        r += ERW * diffusion * RIEMERSMA_WEIGHTS[i] * err[i * 3];
        g += ERW * diffusion * RIEMERSMA_WEIGHTS[i] * err[i * 3 + 1];
        b += ERW * diffusion * RIEMERSMA_WEIGHTS[i] * err[i * 3 + 2];
      }
      r = clampPixel(r); g = clampPixel(g); b = clampPixel(b);
      const i = lookupCached(cube, r, g, b);
      idx[st.y * w + st.x] = i;
      err.copyWithin(0, 3);
      const c = cm[i];
      err[(EQL - 1) * 3] = r - c[0];
      err[(EQL - 1) * 3 + 1] = g - c[1];
      err[(EQL - 1) * 3 + 2] = b - c[2];
    }
    switch (direction) {
      case WEST: st.x--; break;
      case EAST: st.x++; break;
      case NORTH: st.y--; break;
      case SOUTH: st.y++; break;
      default: break;
    }
  }

  function hilbert(level, direction) {
    if (level === 1) {
      switch (direction) {
        case WEST:  visit(EAST);  visit(SOUTH); visit(WEST);  break;
        case EAST:  visit(WEST);  visit(NORTH); visit(EAST);  break;
        case NORTH: visit(SOUTH); visit(EAST);  visit(NORTH); break;
        case SOUTH: visit(NORTH); visit(WEST);  visit(SOUTH); break;
        default: break;
      }
      return;
    }
    switch (direction) {
      case WEST:
        hilbert(level - 1, NORTH); visit(EAST);  hilbert(level - 1, WEST);  visit(SOUTH);
        hilbert(level - 1, WEST);  visit(WEST);  hilbert(level - 1, SOUTH); break;
      case EAST:
        hilbert(level - 1, SOUTH); visit(WEST);  hilbert(level - 1, EAST);  visit(NORTH);
        hilbert(level - 1, EAST);  visit(EAST);  hilbert(level - 1, NORTH); break;
      case NORTH:
        hilbert(level - 1, WEST);  visit(SOUTH); hilbert(level - 1, NORTH); visit(EAST);
        hilbert(level - 1, NORTH); visit(NORTH); hilbert(level - 1, EAST);  break;
      case SOUTH:
        hilbert(level - 1, EAST);  visit(NORTH); hilbert(level - 1, SOUTH); visit(WEST);
        hilbert(level - 1, SOUTH); visit(SOUTH); hilbert(level - 1, WEST);  break;
      default: break;
    }
  }

  const extent = Math.max(w, h);
  let level = Math.trunc(Math.log2(extent));
  if ((1 << level) < extent) level++;
  if (level > 0) hilbert(level, NORTH);
  visit(FORGET);
  return idx;
}

// ---------- output ----------------------------------------------------------

/**
 * coders/bmp.c WriteBMPImage() for a PseudoClass image with `-compress none` and
 * the BMP3 magick, as it looks after the `gif:-` round trip: 1 bpp for <=2 colours,
 * else 4 bpp; a full 2^bpp palette (BGR0, unused entries zero); no resolution;
 * bottom-up rows padded to 4 bytes.
 */
function writeBmp3(idx, w, h, colormap) {
  const colors = colormap.length;
  const bpp = colors <= 2 ? 1 : 4;
  const nColors = 1 << bpp;
  const bytesPerLine = 4 * Math.trunc((w * bpp + 31) / 32);
  const imageSize = bytesPerLine * h;
  const offset = 14 + 40 + 4 * nColors;
  const buf = new Uint8Array(offset + imageSize);
  const dv = new DataView(buf.buffer);
  buf[0] = 0x42; buf[1] = 0x4d;                       // "BM"
  dv.setUint32(2, offset + imageSize, true);
  dv.setUint32(6, 0, true);
  dv.setUint32(10, offset, true);
  dv.setUint32(14, 40, true);                          // BITMAPINFOHEADER
  dv.setInt32(18, w, true);
  dv.setInt32(22, h, true);
  dv.setUint16(26, 1, true);                           // planes
  dv.setUint16(28, bpp, true);
  dv.setUint32(30, 0, true);                           // BI_RGB
  dv.setUint32(34, imageSize, true);
  dv.setUint32(38, 0, true);                           // x pels/m (GIF has none)
  dv.setUint32(42, 0, true);                           // y pels/m
  dv.setUint32(46, nColors, true);                     // biClrUsed
  dv.setUint32(50, nColors, true);                     // biClrImportant
  let p = 54;
  for (let i = 0; i < colors; i++) {
    const c = colormap[i];
    buf[p++] = q2c(c[2]); buf[p++] = q2c(c[1]); buf[p++] = q2c(c[0]); buf[p++] = 0;
  }
  for (let y = 0; y < h; y++) {
    let q = offset + (h - 1 - y) * bytesPerLine;
    if (bpp === 1) {
      let bit = 0, byte = 0;
      for (let x = 0; x < w; x++) {
        byte = (byte << 1) | (idx[y * w + x] !== 0 ? 1 : 0);
        if (++bit === 8) { buf[q++] = byte; bit = 0; byte = 0; }
      }
      if (bit !== 0) buf[q++] = (byte << (8 - bit)) & 0xff;
    } else {
      let nib = 0, byte = 0;
      for (let x = 0; x < w; x++) {
        byte = (byte << 4) | (idx[y * w + x] & 0x0f);
        if (++nib === 2) { buf[q++] = byte; nib = 0; byte = 0; }
      }
      if (nib !== 0) buf[q++] = (byte << 4) & 0xff;
    }
  }
  return buf;
}

// ---------- the one entry point ---------------------------------------------

/**
 * Dither + palette-remap an RGBA raster and encode it as the indexed BMP3 the
 * panel firmware reads — exactly the bytes ImageMagick would have produced.
 *
 * @param {Uint8Array|Uint8ClampedArray} rgba  w*h*4 bytes, e.g. ImageData.data
 * @param {number} w
 * @param {number} h
 * @param {string[]} paletteHexes  e.g. PALETTES[display.type]; order does not matter
 * @param {{method?: 'floyd'|'ordered'|'none', diffusion?: number, orderedMap?: 2|4|8}} opts
 * @returns {{ bmp: Uint8Array, indices: Uint8Array, colormap: number[][] }}
 *   `indices` are palette indexes per pixel (row-major, top-down); `colormap` is the
 *   BMP palette as 8-bit [r,g,b] in BMP order, so indices[i] -> colormap[indices[i]].
 */
export function renderIndexedBmp(rgba, w, h, paletteHexes, { method = 'floyd', diffusion = 85, orderedMap = 8 } = {}) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) throw new Error(`bad dimensions ${w}x${h}`);
  if (rgba.length < w * h * 4) throw new Error(`rgba has ${rgba.length} bytes, need ${w * h * 4}`);
  const palette = paletteHexes.map(hexToRgb8);
  let cube, idx;
  if (method === 'none') {
    cube = buildCube(palette, false);
    idx = assignNoDither(toQuantum(rgba, w, h), w, h, cube);
  } else if (method === 'ordered') {
    const size = [2, 4, 8].includes(Number(orderedMap)) ? Number(orderedMap) : 8;
    cube = buildCube(palette, true);
    idx = riemersma(orderedDither(rgba, w, h, size), w, h, cube, 1.0);
  } else {
    const amt = Math.max(0, Math.min(100, Number(diffusion)));
    cube = buildCube(palette, true);
    idx = floydSteinberg(toQuantum(rgba, w, h), w, h, cube, amt * (1.0 / 100.0)); // StringToDoubleInterval("N%", 1.0)
  }
  return {
    bmp: writeBmp3(idx, w, h, cube.colormap),
    indices: idx,
    colormap: cube.colormap.map((c) => [q2c(c[0]), q2c(c[1]), q2c(c[2])]),
  };
}
