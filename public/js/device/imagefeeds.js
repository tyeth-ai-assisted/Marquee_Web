/**
 * Pictures on Adafruit IO feeds: getting one there (#36).
 *
 * Every image on a marquee canvas lives on a feed. A user either picks a feed that already
 * holds a picture (a camera project's, say; see pickFeed in feeds.js) or uploads one here:
 * the picture is fitted to the panel, encoded under IO's 512 KB ceiling for a history-off
 * datum, and published to a NEW feed created with history off. Nothing is written to IO
 * until the picture is known to fit, so a refusal never leaves an empty feed counting
 * against the account's feed limit.
 *
 * The requests go straight to IO with the account key in the header, like every other
 * read and publish in this editor. IO's own error text is passed through verbatim: it is
 * the only thing that says WHY (the account is at its feed limit, the name is taken, the
 * value is too large), and a paraphrase would lose that.
 */

import { ioHost, ioLog, feedUrl, IO_MAX_NO_HISTORY } from '../core/api.js';
import { val } from '../core/util.js';
import { logicalDims } from '../canvas/palette.js';
import { parseFeedImage, FEED_IMAGE_TYPES } from '../lib/feedimage.js';

/** JPEG qualities tried, best first, once a lossless PNG of the picture is too large. */
const JPEG_STEPS = [0.92, 0.85, 0.75, 0.6, 0.45];

/** IO's message when it sends one, otherwise something that names the status. */
function errorText(status, data) {
  const said = data && (data.error || (Array.isArray(data.errors) && data.errors.join(', ')));
  return said || `Adafruit IO replied ${status}`;
}

/** One request: `{ ok, status, data }` or `{ ok: false, status, error }`. Never throws. */
async function io(url, { method = 'GET', body } = {}) {
  const headers = { 'X-AIO-Key': val('ioKey') };
  if (body) headers['Content-Type'] = 'application/json';
  try {
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => null);
    return res.ok ? { ok: true, status: res.status, data } : { ok: false, status: res.status, error: errorText(res.status, data) };
  } catch {
    return { ok: false, status: 0, error: `Could not reach ${ioHost()}` };
  }
}

const accountFeeds = () => `https://${ioHost()}/api/v2/${encodeURIComponent(val('ioUser'))}/feeds`;

/** A feed's record, for its `history` setting and its name. */
export function readFeedRecord(feedKey) {
  ioLog('read   ', feedKey, 'feed record');
  return io(feedUrl(feedKey));
}

/**
 * Turn a feed's history off. Only ever after the user has said yes: it changes the feed
 * for everything else that reads it, which from then on sees only the latest value.
 */
export async function turnHistoryOff(feedKey) {
  const out = await io(feedUrl(feedKey), { method: 'PUT', body: { feed: { history: false } } });
  ioLog('update ', feedKey, out.ok ? 'history turned OFF' : `history change failed (${out.status}) ${out.error}`);
  return out;
}

/** Create a feed in the account's default group, with history off. `data.key` is its key. */
export async function createPictureFeed(name) {
  const out = await io(accountFeeds(), { method: 'POST', body: { feed: { name, history: false } } });
  ioLog('create ', out.data?.key || name, out.ok ? 'picture feed, history OFF' : `feed creation failed (${out.status}) ${out.error}`);
  return out;
}

/** Publish a picture's base64 as the feed's value. */
export async function publishPicture(feedKey, base64) {
  ioLog('publish', feedKey, `picture, ${base64.length} B`);
  return io(feedUrl(feedKey, '/data'), { method: 'POST', body: { value: base64 } });
}

async function deleteFeed(feedKey) {
  const out = await io(feedUrl(feedKey), { method: 'DELETE' });
  ioLog('delete ', feedKey, out.ok ? 'empty picture feed removed' : `delete failed (${out.status}) ${out.error}`);
  return out;
}

/** A File, as a data URL. */
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function decode(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/**
 * A picture ready for a feed:
 *   -> { ok: true, base64, mime, dataUrl, width, height, bytes, scaled, img }
 *   -> { ok: false, reason }   'unreadable' | 'too-large'
 *
 * `source` is a File, or an already-decoded image or canvas (an image from before #36
 * being moved onto a feed). The picture is fitted inside `max` (the panel, by default):
 * a frame can never be bigger than the panel, so larger pixels would only cost bytes.
 * A file that already fits, in a format feeds may hold, goes up byte-for-byte. Anything
 * else is redrawn and encoded as PNG, then as JPEG at falling quality, until it is under
 * `limit`. A picture that is still too large is refused before anything is written.
 */
export async function encodePicture(source, { max = logicalDims(), limit = IO_MAX_NO_HISTORY } = {}) {
  let img = source;
  let original = null;
  if (source instanceof Blob) {
    let url;
    try { url = await readAsDataUrl(source); } catch { return { ok: false, reason: 'unreadable' }; }
    img = await decode(url);
    if (!img) return { ok: false, reason: 'unreadable' };
    original = parseFeedImage(url, { max: limit });
  }
  const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
  if (!w0 || !h0) return { ok: false, reason: 'unreadable' };
  const scale = Math.min(1, max.w / w0, max.h / h0);
  const width = Math.max(1, Math.round(w0 * scale)), height = Math.max(1, Math.round(h0 * scale));

  if (original?.ok && scale === 1) {
    return { ok: true, ...pick(original), width, height, scaled: false, img };
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);
  const tries = [['image/png']];
  // JPEG has no alpha, so transparent areas would come out black. They are flattened
  // onto white first, the colour of the panel's paper.
  const flat = document.createElement('canvas');
  flat.width = width;
  flat.height = height;
  const fctx = flat.getContext('2d');
  fctx.fillStyle = '#FFFFFF';
  fctx.fillRect(0, 0, width, height);
  fctx.drawImage(canvas, 0, 0);
  for (const q of JPEG_STEPS) tries.push(['image/jpeg', q]);
  for (const [mime, q] of tries) {
    const parsed = parseFeedImage((mime === 'image/png' ? canvas : flat).toDataURL(mime, q), { max: limit });
    if (parsed.ok) return { ok: true, ...pick(parsed), width, height, scaled: scale < 1, img: canvas };
  }
  return { ok: false, reason: 'too-large' };
}

const pick = (p) => ({ base64: p.base64, mime: p.mime, dataUrl: p.dataUrl, bytes: p.bytes });

/** What encodePicture() produced, in a few words: "296×128 PNG, 41 KB". */
export function describePicture(pic) {
  return `${pic.width}×${pic.height} ${FEED_IMAGE_TYPES[pic.mime] || 'image'}, ${Math.max(1, Math.round(pic.bytes / 1024))} KB`;
}

/** Why encodePicture() refused, as a sentence. */
export function pictureProblem(reason) {
  return reason === 'too-large'
    ? `That picture is still over Adafruit IO's ${IO_MAX_NO_HISTORY / 1024} KB limit after shrinking it to fit the panel`
    : 'That file could not be read as a picture';
}

/**
 * Put an encoded picture on a new feed called `name`.
 *   -> { ok: true, feedKey, feedName }   or   { ok: false, error }
 *
 * If the feed is created but the publish fails, the feed is deleted again: an empty
 * feed the user never asked for would count against their feed limit.
 */
export async function uploadToNewFeed(name, pic) {
  const made = await createPictureFeed(name);
  if (!made.ok) return { ok: false, error: made.error };
  const feedKey = made.data?.key;
  const feedName = made.data?.name || name;
  if (!feedKey) return { ok: false, error: 'Adafruit IO created the feed but did not say its key' };
  const sent = await publishPicture(feedKey, pic.base64);
  if (!sent.ok) {
    await deleteFeed(feedKey);
    return { ok: false, error: sent.error };
  }
  return { ok: true, feedKey, feedName };
}

/** A feed name from a file name: "My Logo.png" -> "My Logo". */
export function feedNameFor(file) {
  const stem = String(file?.name || '').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9 _-]+/g, ' ').trim();
  return stem ? stem.slice(0, 60) : 'Marquee image';
}
