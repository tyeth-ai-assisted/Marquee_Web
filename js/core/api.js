/**
 * Adafruit IO, the one service this editor talks to. The browser calls it directly
 * for feed reads and datum publishes; there is no server of our own — rendering
 * happens in the page (canvas/bitmap.js) and state lives in localStorage.
 */

/**
 * IO datum size ceilings, in bytes of the base64 payload. We assume feed history
 * is OFF (the 512 KB ceiling) as the default setup; the 1 KB history-on tier is
 * recorded here for reference but is not what gating uses.
 */
export const IO_MAX_HISTORY = 1024;
export const IO_MAX_NO_HISTORY = 512 * 1024;

/**
 * The Adafruit IO host, for the whole app — feed reads, publishes, and the group
 * A5b creates. Every request resolves through here so there is exactly one place
 * that names it.
 */
export function ioHost() {
  return 'io.adafruit.com';
}

/**
 * One console line per Adafruit IO request, naming the FULL feed key it is aimed at.
 *
 * On by default and deliberately so. Every feed key in this app is now DERIVED — from
 * the group, from the device name, from a slug of something the user typed — and a
 * derivation that goes wrong produces a request to a plausible-looking feed that
 * simply is not the one anybody meant. The 404 that follows says the feed does not
 * exist; it does not say which feed was asked for, and that is the only fact worth
 * having. So the key is printed at the moment of the call, group-qualified and
 * username-scoped, exactly as it goes on the wire.
 *
 * Never logs the key — see ioFetch() in provision.js. `X-AIO-Key` is a header and
 * stays one.
 */
export function ioLog(action, feedKey, note = '') {
  const { owner, key } = feedRef(feedKey);
  console.log(`[io] ${action} ${owner || '(no user)'}/${key || '(no feed)'} @ ${ioHost()}${note ? ` — ${note}` : ''}`);
}

function ioUser() {
  return (globalThis.document?.getElementById('ioUser')?.value || '').trim();
}

/**
 * Split a feed key into the account it lives under and its key on that account.
 *
 * A feed someone else SHARED with you is stored as "owner/key" — IO feed keys cannot
 * contain a slash, so the prefix is unambiguous — and every other key is bare and
 * belongs to the connected account. Encoding the owner in the key rather than beside
 * it means an element binding, a chart's `feeds[].key` and the `series` map all carry
 * a shared feed without learning a new attribute, and documents saved before shared
 * feeds existed still read exactly as they did.
 *
 * `user` is injectable so this stays testable without a DOM.
 */
export function feedRef(feedKey, user = ioUser()) {
  const k = String(feedKey || '');
  const i = k.indexOf('/');
  return i < 0 ? { owner: user, key: k } : { owner: k.slice(0, i), key: k.slice(i + 1) };
}

/** The REST URL for a feed (owned or shared), plus an optional path suffix like "/data/last". */
export function feedUrl(feedKey, suffix = '') {
  const { owner, key } = feedRef(feedKey);
  return `https://${ioHost()}/api/v2/${encodeURIComponent(owner)}/feeds/${encodeURIComponent(key)}${suffix}`;
}

/**
 * Turn whatever someone pasted from a shared feed's page into "owner/key", or null.
 *
 * IO's feed page offers four spellings of the same feed and any of them is a
 * reasonable thing to paste:
 *   https://io.adafruit.com/abachman/feeds/secondary.shared-message-buffer
 *   https://io.adafruit.com/api/v2/abachman/feeds/secondary.shared-message-buffer/data
 *   abachman/feeds/secondary.shared-message-buffer          (MQTT)
 *   abachman/secondary.shared-message-buffer                (our own stored form)
 */
export function parseSharedFeed(input) {
  let s = String(input || '').trim();
  s = s.replace(/^[a-z]+:\/\/[^/]+\/?/i, '')      // scheme + host
       .replace(/^io\.adafruit\.com\/?/i, '')       // host pasted without a scheme
       .replace(/^api\/v2\//i, '')
       .replace(/[?#].*$/, '')
       .replace(/\/+$/, '');
  const parts = s.split('/').filter(Boolean);
  if (parts[1] === 'feeds') parts.splice(1, 1);
  // Anything after the key is an endpoint on it (/data, /data/last, /details …).
  const [owner, key] = parts;
  if (!owner || !key) return null;
  const ok = /^[A-Za-z0-9_.-]+$/;
  return ok.test(owner) && ok.test(key) ? `${owner}/${key}` : null;
}

/**
 * The Adafruit IO GROUP every feed this device uses lives in — one group per
 * device, created (or found) by A5b. It is the only feed identity the user sets;
 * the feed keys below are all derived from it.
 *
 * This replaced a flat image-feed key with "-sleep" and "-status" siblings glued
 * on. Same idea — one name, three feeds, no way for them to drift apart — but the
 * group is a thing IO itself knows about, so A5b can ask whether it exists rather
 * than guessing from a naming convention.
 */
export function ioGroupKey() {
  return (document.getElementById('ioGroup')?.value || '').trim();
}

/**
 * The packed panel image the device renders. Written by the web app, read by the
 * board.
 *
 * Empty when no group is set, which publishToIO already reports as missing
 * credentials.
 */
export function bitmapFeedKey() {
  return groupFeed('bitmap');
}

/** The feed carrying the sleep window — seconds until the next wake. See
 *  docs/marquee-sleep.md for the payload. */
export function sleepFeedKey() {
  return groupFeed('sleep');
}

/**
 * The feed the BOARD writes, reporting when it woke and when it went back to
 * sleep — the only acknowledgement this editor gets.
 *
 * Board -> editor only, which is the whole reason it is not the sleep feed: the
 * firmware reads that one as "the last value is my window", and a board writing its
 * own status there would shadow its own config within one cycle. One writer per
 * feed keeps /data/last unambiguous in both directions.
 *
 * See docs/marquee-status.md for the payload.
 */
export function statusFeedKey() {
  return groupFeed('status');
}

/**
 * The editable scene itself — the canvas document, as JSON, exactly the shape of
 * canvas.json.
 *
 * The one feed on the group the BOARD never reads. It exists so the design stops
 * living only in the browser that drew it: with it, opening a display on A1 shows the
 * scene that display is actually carrying rather than whatever this browser last
 * happened to author, and a browser that has never seen the board can still edit it.
 *
 * History OFF, like the bitmap feed and for the same reason — a scene with an embedded
 * image runs to tens of kilobytes against IO's 1 KB history cap.
 */
export function canvasStateFeedKey() {
  return groupFeed('canvas-state');
}

/**
 * A feed inside a NAMED group, for a caller that is not asking about the active
 * device. A1 renders a thumbnail for every display in the browser and must not
 * activate one to work out where its picture lives, so it passes each record's own
 * group key through here.
 *
 * The same derivation as everything above, exported rather than copied: a second
 * spelling of `${group}.${name}` is how one screen ends up reading a feed nothing
 * else writes.
 */
export function feedKeyIn(group, name) {
  const g = (group || '').trim();
  return g ? `${g}.${name}` : '';
}

/**
 * A feed inside the device's group, in IO's group-qualified form:
 * "marquee-magtag" + "bitmap" -> "marquee-magtag.bitmap".
 *
 * That dotted key is what the /feeds/{key}/… endpoints take for a grouped feed, and
 * encodeURIComponent leaves the dot alone, so every existing call site addresses it
 * without special-casing.
 */
function groupFeed(name) {
  return feedKeyIn(ioGroupKey(), name);
}
