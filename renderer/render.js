/**
 * A canvas.json to the panel's BMP, on a server: the editor's own lib/ (scene, bindings,
 * renderer, dither) drawn by Konva on skia-canvas, which is Skia like Chrome, with the same
 * bundled fonts. The host (Adafruit IO) reads the feeds plan() asks for and passes the
 * results in; this module writes them into the document, fills in the time, decodes
 * images, and renders. It reads nothing and publishes nothing itself.
 *
 * The input is user-authored and is treated as hostile: images must be data: URLs, and the
 * panel must be a size the editor could have produced.
 */

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Konva from 'konva';
import 'konva/skia-backend';
import { FontLibrary, loadImage } from 'skia-canvas';

import { renderScene } from '../public/js/lib/render.js';
import { feedReads, bakeReadings } from '../public/js/lib/bindings.js';
import { PALETTES } from '../public/js/lib/palette.js';
import { FONT_FILES } from '../public/js/lib/fonts.js';
import { FA_FAMILY } from '../public/js/lib/icons.js';
import { normalizeDatetimeAttrs, strftime } from '../public/js/lib/timefmt.js';

// Konva warns about attrs it would type differently (a feed reading in `value` is a string),
// which the editor tolerates on purpose; on a server it would only fill the logs.
Konva.showWarnings = false;

// skia-canvas draws on the GPU when the machine has one, and a GPU's rasterizer does not
// produce the same bytes as the CPU's. Lambda has no GPU, so every render is pinned to the
// CPU: a developer's laptop, CI and production then agree on the sha.
const makeCanvas = Konva.Util.createCanvasElement;
Konva.Util.createCanvasElement = () => {
  const canvas = makeCanvas();
  canvas.gpu = false;
  return canvas;
};

/** The editor's own bounds on a panel side (resW / resH in index.html). */
export const MIN_SIDE = 8;
export const MAX_SIDE = 4096;

/** The largest image a document may embed, decoded, in pixels. */
export const MAX_IMAGE_PIXELS = 4096 * 4096;

const fontPath = (file) => fileURLToPath(new URL(`../public/fonts/${file}`, import.meta.url));

let fontsLoaded = false;

/** The faces canvas text draws in, registered once per process. */
export function loadFonts() {
  if (fontsLoaded) return;
  const byFamily = Object.groupBy(FONT_FILES, (f) => f.family);
  for (const [family, files] of Object.entries(byFamily)) FontLibrary.use(family, files.map((f) => fontPath(f.file)));
  FontLibrary.use(FA_FAMILY, [fontPath('fa-solid-900.woff2')]);
  fontsLoaded = true;
}

/** `timeZone` if this runtime knows it, else UTC. */
export function knownZone(timeZone) {
  if (!timeZone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

/**
 * The document as it should draw at `now`: each date & time element showing that instant in
 * its own zone, or `timeZone` (the account's) when it names none, or UTC when that is unknown.
 */
export function atTime(doc, { now = Date.now(), timeZone = 'UTC' } = {}) {
  const elements = (doc.elements || []).map((el) => {
    if (el.etype !== 'datetime') return el;
    const { timeFmt, timeTz } = normalizeDatetimeAttrs(el);
    const timeValue = strftime(now, timeFmt, timeTz || timeZone) ?? strftime(now, timeFmt, 'UTC');
    return timeValue === null ? el : { ...el, timeValue };
  });
  return { ...doc, elements };
}

/**
 * Images arrive as data URLs inside the document; decoded here, by element index. A feed
 * image's picture arrives the same way: bakeReadings() turns the feed's value into a data
 * URL in its `src`, and a feed image whose feed was not read keeps its `feed:` reference,
 * which is not decoded and draws as the empty frame.
 *
 * ONLY data URLs. skia-canvas's loadImage() would fetch an http(s) URL or read a file path,
 * and this document was written by a user: a src of `http://169.254.169.254/...` must never
 * become a request from inside the host's network. The editor only ever stores data URLs, so
 * anything else is left out, like an image that will not decode.
 */
async function decodeImages(doc) {
  const images = {};
  await Promise.all((doc.elements || []).map(async (el, i) => {
    if (el.etype !== 'image' && el.etype !== 'feedimage') return;
    if (typeof el.src !== 'string' || !/^data:image\//i.test(el.src)) return;
    try {
      const img = await loadImage(el.src);
      if (img.width * img.height <= MAX_IMAGE_PIXELS) images[i] = img;
    } catch {
      // an undecodable image is left out, as it is in the editor
    }
  }));
  return images;
}

const isSide = (n) => Number.isInteger(n) && n >= MIN_SIDE && n <= MAX_SIDE;

function checkRequest(doc, display) {
  if (!doc || doc.version !== 1 || !Array.isArray(doc.elements)) throw new Error('expected a version 1 canvas document');
  if (!display?.width || !display?.height || !display?.type) throw new Error('expected a display with width, height and type');
  if (!isSide(display.width) || !isSide(display.height)) {
    throw new Error(`expected a display between ${MIN_SIDE} and ${MAX_SIDE} pixels a side`);
  }
  if (!PALETTES[display.type]) throw new Error(`unknown display type "${display.type}"`);
}

/**
 * What a document reads, for the host to fetch before calling render():
 *
 *   -> { reads: [{ id, feed, kind: 'last' } | { id, feed, kind: 'chart', hours, raw, limit }],
 *        datetime }
 *
 * See feedReads() in lib/bindings.js. Results go back to render() as `readings`, filed
 * under each read's `id`.
 */
export function plan({ doc } = {}) {
  if (!doc || doc.version !== 1 || !Array.isArray(doc.elements)) throw new Error('expected a version 1 canvas document');
  return feedReads(doc);
}

/**
 * Render a document.
 *
 *   doc        canvas.json
 *   readings   { last: { [id]: value }, chart: { [id]: IO /data/chart body } }, keyed by the
 *              ids plan() hands out; optional. A missing or null reading keeps the value
 *              saved in the document, so a document with readings already baked in (or a
 *              host that read nothing) renders as saved.
 *   display    the panel ({ width, height, rotation, panel, type, dither, diffusion,
 *              orderedMap }); defaults to the document's own
 *   now        epoch ms for date & time elements
 *   timeZone   the zone a date & time element with none uses
 *
 *   -> { base64, sha, bytes, width, height }
 */
export async function render({ doc, readings, display = doc?.display, now, timeZone } = {}) {
  checkRequest(doc, display);

  loadFonts();
  const timed = atTime(bakeReadings(doc, readings), { now, timeZone });
  // The account's zone rides on the display, for the chart's time axis: the process's own
  // zone is the server's (UTC on Lambda), not anything the user would recognise.
  const zoned = { ...display, timeZone: knownZone(timeZone) };
  const out = renderScene(Konva, timed, { display: zoned, images: await decodeImages(timed) });

  return {
    base64: out.base64,
    sha: createHash('sha256').update(out.base64).digest('hex'),
    bytes: out.bmp.length,
    width: out.width,
    height: out.height,
  };
}
