/**
 * The scene on Adafruit IO — canvas.json up to {group}.canvas-state, and back down.
 *
 * The document used to exist in exactly one place, and it did not travel: a
 * per-device key in THIS browser's localStorage. Open a display from another machine
 * and the editor had nothing to show for a board that was, at that moment, drawing
 * something. This module is the second place, and the only one both sides of that
 * gap can see.
 *
 * UP is a mirror of the autosave, not a second save path: doc.js still writes
 * localStorage first and unconditionally, and calls in here afterwards. So a publish
 * that fails costs nothing — the document is already stored, and the next edit tries
 * again.
 *
 * The cadence is the whole design of the write side. doc.js debounces at 400ms, which
 * is right for localStorage and would be one IO datum per word typed. So: a longer
 * debounce on top, a floor on the gap between publishes, and a de-dupe on the exact
 * payload. Dragging an element across the canvas is one publish when the drag ends.
 *
 * DOWN is activate.js's business — see hydrateFromCanvasFeed() there for who wins when
 * the feed and this browser disagree.
 */

import { canvasStateFeedKey, IO_MAX_NO_HISTORY } from '../core/api.js';
import { MARQUEE_FEEDS, createGroupFeed } from './provision.js';
import { publishToIO } from '../canvas/render.js';
import { readFeedLast } from './feeds.js';
import { withoutSamples } from '../core/samples.js';
import { val, toast, fmtBytes } from '../core/util.js';

/** Idle time after the last edit before the scene goes up. Long enough that a drag,
 *  a resize or a sentence typed into a label is one datum rather than thirty. */
const DEBOUNCE_MS = 3000;

/** Floor on the gap between two publishes, however busy the canvas is. Adafruit IO
 *  rate-limits per account across every feed, and this feed must never be the reason
 *  a status read or a bitmap push gets throttled. */
const MIN_GAP_MS = 15000;

/** The job waiting to go up: the payload AND the feed it was scheduled for. The feed
 *  is captured rather than re-read at send time so a device switch inside the debounce
 *  window can't put the outgoing display's scene on the incoming display's feed. */
let pending = null;
let timer = null;
let lastPublishAt = 0;

/**
 * The exact payload IO is known to hold. Set when we publish AND when we hydrate from
 * the feed, because both mean "the feed already says this" — without the second, every
 * hydrate would immediately echo what it just read back up.
 */
let lastPublishedJson = null;

/**
 * The same thing with every feed READING taken out of it (samples.js).
 *
 * The scene and the picture of the scene are two different feeds, and only one of them
 * changes when a thermometer does. device.js re-reads the bindings on the board's own
 * cycle now, and each of those refreshes redraws the layer, which is a document change as
 * far as doc.js is concerned — so without this baseline a panel watching a one-minute feed
 * would put a fresh copy of the entire document, embedded images and all, onto
 * {group}.canvas-state once a cycle, forever, for as long as a tab is open. That is the
 * exact opposite of MIN_GAP_MS's promise above.
 *
 * So the de-dupe is on the DESIGN. A structural edit still goes up immediately and carries
 * whatever readings it happens to be carrying; a reading on its own does not. What the
 * feed then holds is the scene as of the last real edit, which is what it held before any
 * of this existed — and a browser hydrating from it re-reads the bindings itself.
 */
let lastPublishedDesign = null;

/** Failures are reported once. This runs on a timer behind the user's typing, and a
 *  toast per attempt would turn one wrong feed key into a wall of them. */
let reportedFailure = false;
let reportedTooLarge = false;

/** Feeds this session has already tried to create, by full key. A display set up before
 *  canvas-state existed has a group with three feeds in it and no fourth, and the 404
 *  that produces is the only notice anyone gets — see createMissingFeed(). */
const createAttempted = new Set();

/**
 * Add canvas-state to a group that predates it.
 *
 * A5b creates the whole set at setup and is never run again for a display that is
 * already configured, so without this the feature would work on new displays and
 * silently not on every board already on a bench. Attempted ONCE per feed per session,
 * on the 404 rather than speculatively: an account that is out of feeds, or a key
 * without write access, must not have this retried behind the user's typing.
 */
async function createMissingFeed(feed) {
  if (createAttempted.has(feed)) return false;
  createAttempted.add(feed);
  const group = feed.slice(0, feed.lastIndexOf('.'));
  const spec = MARQUEE_FEEDS.find((f) => f.key === 'canvas-state');
  if (!group || !spec) return false;
  const out = await createGroupFeed(val('ioUser'), val('ioKey'), group, spec);
  return out.ok;
}

/** The feed already holds this exact document — told to us by whoever read it. Both
 *  baselines move together, or the next reading-only refresh would echo the hydrate
 *  straight back up. */
export function noteCanvasStateSeen(json) {
  lastPublishedJson = json;
  try {
    lastPublishedDesign = JSON.stringify(withoutSamples(JSON.parse(json)));
  } catch {
    // Unparseable is not a baseline. Leaving it null makes the next publish unconditional,
    // which is the safe direction.
    lastPublishedDesign = null;
  }
}

/**
 * Queue the document for the canvas-state feed.
 *
 * Silent about missing credentials, unlike a user-initiated publish: an account with
 * no group set yet is the ordinary state of a display halfway through Act I, not an
 * error to interrupt anyone with.
 */
export function scheduleCanvasStatePublish(doc) {
  const feed = canvasStateFeedKey();
  if (!feed || !val('ioUser') || !val('ioKey')) return;
  const json = JSON.stringify(doc);
  if (json === lastPublishedJson) return;
  // Nothing about the SCENE moved — only what the feeds behind it are saying. See
  // lastPublishedDesign.
  const design = JSON.stringify(withoutSamples(doc));
  if (design === lastPublishedDesign) return;
  pending = { feed, json, design };
  arm();
}

function arm() {
  clearTimeout(timer);
  const since = Date.now() - lastPublishAt;
  timer = setTimeout(flush, Math.max(DEBOUNCE_MS, MIN_GAP_MS - since));
}

async function flush() {
  timer = null;
  const job = pending;
  pending = null;
  if (!job) return;

  // elements.js allows a 25MB embedded image, so this ceiling is reachable by an
  // ordinary drag-and-drop rather than by abuse. Said once, and only about the feed:
  // the document itself is saved, and the board draws from the bitmap feed regardless.
  if (job.json.length > IO_MAX_NO_HISTORY) {
    if (!reportedTooLarge) {
      reportedTooLarge = true;
      toast(`The scene is ${fmtBytes(job.json.length)} — too large for the canvas-state feed. `
        + 'It is saved in this browser, but other machines will not see it.');
    }
    return;
  }

  lastPublishAt = Date.now();
  // Before the await, so edits landing during the request de-dupe against what is on
  // its way up rather than queueing a duplicate of it.
  lastPublishedJson = job.json;
  lastPublishedDesign = job.design;
  let out = await publishToIO(job.json, job.feed, { quiet: true });
  // A 404 is the ordinary answer for a display configured before this feed existed, so
  // it is answered rather than reported: make the feed, send again, say nothing.
  if (!out.ok && out.status === 404 && await createMissingFeed(job.feed)) {
    out = await publishToIO(job.json, job.feed, { quiet: true });
  }
  if (!out.ok) {
    // The first real failure is worth one line; after that the user has been told, and
    // this is a background mirror of a document that is already saved.
    if (!reportedFailure) {
      toast(`The scene could not be mirrored to "${job.feed}" (${out.error}) — `
        + 'it is saved in this browser, but other machines will not see it.');
    }
    reportedFailure = true;
    // The feed does NOT hold this. Dropping the baselines is what makes the next edit
    // — or the next successful publish of anything — carry the whole scene up again.
    lastPublishedJson = null;
    lastPublishedDesign = null;
  }
}

/**
 * The scene the feed is carrying, or null when there isn't one to be had — no group,
 * no credentials, an unreadable feed, an empty feed, or a datum that does not parse
 * into a document.
 *
 * Every one of those is answered the same way on purpose: the caller's only decision
 * is whether to adopt what came back, and "there is nothing to adopt" is one outcome
 * however it came about. The raw `json` rides along so the caller can hand it to
 * noteCanvasStateSeen() without re-stringifying a document that would come back
 * subtly different.
 */
export async function readCanvasState() {
  const feed = canvasStateFeedKey();
  if (!feed || !val('ioUser') || !val('ioKey')) return null;
  const d = await readFeedLast(feed);
  if (!d) return null;
  let doc = null;
  try {
    doc = JSON.parse(d.value);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.elements)) return null;
  return { doc, json: d.value, at: Number.isFinite(d.createdAt) ? d.createdAt : null };
}
