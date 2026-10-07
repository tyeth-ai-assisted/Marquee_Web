/**
 * A picture that arrived as a FEED VALUE.
 *
 * Adafruit IO feeds carry strings, and a camera project (the doorbell, the bird feeder,
 * anything that `base64`s a JPEG and publishes it) puts the whole file on the feed as one
 * datum. With feed history OFF a datum may run to 512 KB (`IO_MAX_NO_HISTORY`); with it ON
 * the cap is 1 KB, which no picture fits, so an image feed is always a history-off feed
 * and holds exactly one datum — the current frame.
 *
 * This module turns such a value into something a browser can decode. Pure on purpose —
 * no DOM, no Konva, nothing but the IO constant — so `node --test` can reach every branch
 * of the sniffing, and so the editor and a test agree on what counts as an image.
 *
 * What a value may look like, all accepted:
 *   iVBORw0KGgo…                       raw base64, the common case (what IO's own uploader
 *                                      and the Adafruit camera guides publish)
 *   data:image/png;base64,iVBORw0KGgo… a data URL, as our own canvas.json stores images
 *   …with newlines or spaces inside    some encoders wrap at 76 columns
 *   …with - and _ instead of + and /   URL-safe base64
 *
 * The declared type is never trusted. A data URL's `image/jpeg` header on PNG bytes is
 * an honest mistake a browser would forgive, and a bare base64 blob says nothing about its
 * type at all, so the format is read off the first bytes in every case. Unknown magic is
 * refused rather than handed to the browser to guess at.
 */

import { IO_MAX_NO_HISTORY } from './api.js';

/** The formats a feed image may be, by MIME type, with the name the inspector shows. */
export const FEED_IMAGE_TYPES = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/gif': 'GIF',
  'image/bmp': 'BMP',
};

/**
 * File signatures, longest first so a prefix match cannot shadow a longer one. BMP's is
 * only two bytes ("BM"), which is why it is sniffed last and why a value has to clear the
 * length floor below before any of this runs — "BM" is also how a sentence could start.
 */
const MAGIC = [
  ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['image/gif', [0x47, 0x49, 0x46, 0x38]],                      // GIF8(7|9)a
  ['image/jpeg', [0xff, 0xd8, 0xff]],
  ['image/bmp', [0x42, 0x4d]],
];

/** Fewer base64 characters than this cannot hold a header, let alone a picture. */
const MIN_B64_CHARS = 16;

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** The first `n` decoded bytes of a base64 string, without decoding the rest of it. */
function headBytes(b64, n) {
  const chars = Math.ceil(n / 3) * 4;
  const chunk = b64.slice(0, chars);
  // atob refuses a chunk whose length is not a multiple of 4; pad the way an encoder would.
  const padded = chunk + '='.repeat((4 - (chunk.length % 4)) % 4);
  let bin;
  try { bin = atob(padded); } catch { return null; }
  const out = new Uint8Array(Math.min(n, bin.length));
  for (let i = 0; i < out.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The image type a base64 payload holds, by its signature — or null when it is not a
 * format this editor accepts.
 */
export function sniffImageType(b64) {
  const head = headBytes(String(b64 || ''), 8);
  if (!head) return null;
  for (const [mime, sig] of MAGIC) {
    if (head.length >= sig.length && sig.every((b, i) => head[i] === b)) return mime;
  }
  return null;
}

/** How many bytes a base64 string decodes to, from its length and padding alone. */
export function base64ByteLength(b64) {
  const s = String(b64 || '');
  if (!s.length) return 0;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - pad;
}

/**
 * Read a feed value as an image.
 *
 * Resolves to `{ ok: true, dataUrl, mime, base64, bytes }` — `dataUrl` is what an <img>
 * can load and what canvas.json stores; `bytes` the decoded size, for the inspector —
 * or `{ ok: false, reason }` with one of:
 *
 *   'empty'       nothing on the feed (null, undefined, or only whitespace)
 *   'not-base64'  a number, a word, JSON — a feed that is not an image feed at all
 *   'unknown'     base64 of something other than a PNG, JPEG, GIF or BMP
 *   'too-large'   over IO's 512 KB datum ceiling — nothing IO delivered can be, but a
 *                 value can also come in from a document, and a browser handed half a
 *                 megabyte of image to decode on every cycle deserves a say
 *
 * `max` is the base64 ceiling in characters, exposed so a test can hit the branch without
 * building half a megabyte of string.
 */
export function parseFeedImage(value, { max = IO_MAX_NO_HISTORY } = {}) {
  if (value === null || value === undefined) return { ok: false, reason: 'empty' };
  let s = String(value).trim();
  if (!s) return { ok: false, reason: 'empty' };

  // A data URL: keep the payload, drop the header. The declared type is sniffed over below.
  if (/^data:/i.test(s)) {
    const comma = s.indexOf(',');
    const header = comma < 0 ? s : s.slice(0, comma);
    if (comma < 0 || !/;base64$/i.test(header)) return { ok: false, reason: 'not-base64' };
    s = s.slice(comma + 1);
  }

  // Wrapped lines and URL-safe alphabets both decode once normalised.
  s = s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (s.length < MIN_B64_CHARS || !B64_RE.test(s)) return { ok: false, reason: 'not-base64' };
  if (s.length > max) return { ok: false, reason: 'too-large' };

  const mime = sniffImageType(s);
  if (!mime) return { ok: false, reason: 'unknown' };
  return { ok: true, mime, base64: s, bytes: base64ByteLength(s), dataUrl: `data:${mime};base64,${s}` };
}

/** The reasons above, as a sentence for a toast. */
export function feedImageProblem(reason, feedName = 'This feed') {
  switch (reason) {
    case 'empty': return `${feedName} has no image yet`;
    case 'not-base64': return `${feedName}'s value is not an image — expected base64 of a PNG, JPEG, GIF or BMP`;
    case 'unknown': return `${feedName}'s value is not a format this editor can show (PNG, JPEG, GIF or BMP)`;
    case 'too-large': return `${feedName}'s image is over Adafruit IO's ${IO_MAX_NO_HISTORY / 1024} KB limit`;
    default: return `${feedName} could not be read as an image`;
  }
}

/** How a picture is placed in its frame. */
export const FEED_IMAGE_FITS = [
  { id: 'contain', label: 'Fit inside', hint: 'Whole picture, centred, bars where the shape differs' },
  { id: 'cover', label: 'Fill frame', hint: 'Fills the frame, trimming the edges that do not fit' },
  { id: 'stretch', label: 'Stretch', hint: 'Fills the frame exactly, distorting the picture' },
];

/**
 * Where a natW×natH picture lands inside a frameW×frameH box.
 *
 * Returns `{ x, y, w, h }` in frame coordinates, plus `crop` (in picture coordinates) for
 * 'cover', which draws the frame-sized window of the picture that fits. Integer output,
 * because the panel is a bitmap and a half-pixel edge is a blurred edge after dithering.
 *
 * The frame is the authored thing and the picture a sample. A feed whose pictures swing
 * between portrait and landscape must not ratchet the element smaller on every change
 * (fit-into-the-previous-picture would), nor run off the panel (keep-width would), so
 * each new picture is placed into the SAME frame and the frame only moves when the user
 * moves it.
 */
export function fitRect(natW, natH, frameW, frameH, fit = 'contain') {
  const fw = Math.max(1, Math.round(frameW)), fh = Math.max(1, Math.round(frameH));
  const nw = Math.max(1, natW || 1), nh = Math.max(1, natH || 1);
  if (fit === 'stretch') return { x: 0, y: 0, w: fw, h: fh };
  if (fit === 'cover') {
    const scale = Math.max(fw / nw, fh / nh);
    // At least one source pixel each way, and never more than the picture has: a 1×1
    // picture in a 120×8 frame would otherwise round to a zero-high window placed
    // outside the picture, which Konva cannot draw. The origin is clamped the same way
    // so the window always lies inside the picture.
    const cw = Math.min(nw, Math.max(1, Math.round(fw / scale)));
    const ch = Math.min(nh, Math.max(1, Math.round(fh / scale)));
    return {
      x: 0, y: 0, w: fw, h: fh,
      crop: {
        x: Math.min(nw - cw, Math.max(0, Math.round((nw - cw) / 2))),
        y: Math.min(nh - ch, Math.max(0, Math.round((nh - ch) / 2))),
        width: cw, height: ch,
      },
    };
  }
  const scale = Math.min(fw / nw, fh / nh);
  const w = Math.max(1, Math.round(nw * scale)), h = Math.max(1, Math.round(nh * scale));
  return { x: Math.round((fw - w) / 2), y: Math.round((fh - h) / 2), w, h };
}
