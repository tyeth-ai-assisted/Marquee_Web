/**
 * Flow state — the small set of facts that decide which screen the user is on
 * and what each one says. Distinct from `display` (the panel descriptor, in
 * palette.js) and from the canvas document (doc.js).
 *
 * Everything here except the published snapshot survives a reload, so returning
 * to the tab drops you back where you were rather than at the start of setup.
 */

import { stripSamples } from './samples.js';

const KEY = 'marquee.flow';

const DEFAULTS = {
  /** Preset key from presets.js, or null when the panel was set up by hand. */
  selectedPanel: null,

  /** 'pending' | 'ready' | 'skipped' — whether A5b has confirmed the device's
   *  group and its feeds exist on Adafruit IO.
   *
   *  'skipped' is a deliberate choice and is never re-prompted: the editor works
   *  without a board, and someone who has no network to hand should not be held in
   *  setup. 'pending' re-opens A5b on the way to the editor, because nothing
   *  downstream can publish to feed keys nobody has checked. */
  ioSetup: 'pending',

  /** The group key A5b actually resolved. Compared against the live #ioGroup field
   *  on enter: editing the group in Settings afterwards makes the confirmation
   *  stale, because the feeds we verified are no longer the feeds we would publish
   *  to. Null until A5b has run. */
  ioGroupKey: null,

  /** 'online-awake' | 'asleep' | 'offline'. */
  deviceState: 'online-awake',

  /** Epoch ms. When the device is expected back, and when it last confirmed a
   *  write. Both null until a real cycle has run. */
  wakesAt: null,
  lastWriteAt: null,

  /** The sleep window the board actually collected, in seconds — NOT the number
   *  the form currently shows. A8 models the cycle from this, and an interval
   *  edited mid-sleep changes nothing until the board reads the feed again. Null
   *  until a cycle has run. */
  sleepSeconds: null,

  /** Epoch ms of the last wake and the last sleep the DEVICE ITSELF reported on its
   *  status feed. Null until it says so; never set from anything the editor merely
   *  published.
   *
   *  Act III shows the pair as the board's own record, and while `deviceState` is
   *  'online-awake' the wake also anchors the redraw clock: the start is evidence, the
   *  length is still the panel estimate.
   *
   *  Neither survives a reload — see load(). */
  lastWokeAt: null,
  lastSleptAt: null,

  /** What the current sleep wakes on: 'timer' | 'pin' | 'timer+pin' | null.
   *  The editor only ever publishes 'timer' (device.js#currentSleepPayload); the
   *  other two arrive from the board's own status feed, which reports what it
   *  actually armed. A pin-only alarm has no wake TIME, so A8 has to say "until you
   *  press the button" rather than tick a countdown at a `wakesAt` that would be a
   *  fiction. */
  wakeSource: null,

  /** Last screen visited, so a reload lands where the user left off. Per-device,
   *  because this object is now one device's slice — see devices.js. */
  lastScreen: null,
};

let state = load();

/**
 * A saved (or swapped-in) flow object, made safe to install as `state`.
 *
 * Two rules, and both of them are about not trusting the input:
 *
 *   - Only DEFAULTS keys survive. Spreading `{...DEFAULTS, ...saved}` used to keep
 *     every key ever written to this store, so a field deleted from the app lived on
 *     in localStorage forever. `actOneDone` is the immediate case: setup progress is
 *     recorded per-device now (`rec.setupStep` in devices.js), and a stale
 *     `actOneDone` sitting in a migrated blob would be a second, disagreeing answer.
 *   - The device-reported times are dropped, for the reason `published` is not saved
 *     at all: they are claims about what a board is doing, the board has certainly
 *     moved on, and no watch is running yet to correct them. This holds just as much
 *     for a device switch as for a page load — the incoming board has no watch either.
 */
export function normalize(saved) {
  const out = { ...DEFAULTS };
  if (saved && typeof saved === 'object') {
    for (const k of Object.keys(DEFAULTS)) {
      if (saved[k] !== undefined) out[k] = saved[k];
    }
  }
  out.lastWokeAt = null;
  out.lastSleptAt = null;
  return out;
}

function load() {
  try {
    return normalize(JSON.parse(localStorage.getItem(KEY) || '{}'));
  } catch {
    return { ...DEFAULTS };
  }
}

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage disabled/full */ }
}

const listeners = new Set();

export function getState() { return state; }

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setState(patch) {
  const before = state;
  state = { ...state, ...patch };
  // Only notify on a real change, so a listener that re-renders a screen isn't
  // woken by every no-op write from a form handler.
  const changed = Object.keys(patch).some((k) => before[k] !== state[k]);
  persist();
  if (changed) listeners.forEach((fn) => fn(state, patch));
}

export function resetFlow() {
  state = { ...DEFAULTS };
  persist();
  listeners.forEach((fn) => fn(state, state));
}

/**
 * Install another device's flow slice wholesale — the load half of a device switch
 * (devices.js). Distinct from setState(), which patches the device you are on.
 *
 * Notified with the full state as the patch, the shape resetFlow() uses, because
 * every field may have moved at once and a subscriber comparing keys would have to
 * assume that anyway. A8's subscriber takes this as its cue to re-render the cycle
 * and re-fetch the takes, which is exactly what a swap owes it.
 */
export function replaceFlow(flow) {
  state = normalize(flow);
  persist();
  listeners.forEach((fn) => fn(state, state));
}

// ---------- the published dashboard -----------------------------------------
//
// What is actually on the glass, as opposed to what the editor is showing. A8
// renders this on the left and the live canvas on the right; the difference
// between them is the whole point of that screen.
//
// Deliberately NOT persisted: it holds a full-panel PNG data URL, and a stale
// one restored from a previous session would claim the panel is showing
// something we have no evidence it still shows.

let published = { png: null, doc: null, at: null };

export function getPublished() { return published; }

export function setPublished({ png, doc, at }) {
  published = { png, doc, at };
  listeners.forEach((fn) => fn(state, { published: true }));
}

export function clearPublished() {
  published = { png: null, doc: null, at: null };
  listeners.forEach((fn) => fn(state, { published: true }));
}

// ---------- the queued take -------------------------------------------------
//
// What has been published to the feeds but not yet drawn: the board is asleep, so
// this is neither on the glass nor merely a local edit. It is
// held until the modelled redraw completes, at which point it BECOMES `published`
// — see device.js, which owns that clock.
//
// Not persisted, for the same reason `published` isn't.

let queued = null;

export function getQueued() { return queued; }
export function setQueued(take) { queued = take; }
export function clearQueued() { queued = null; }

/**
 * The newest document that is ON THE FEED — the right thing to measure a live edit
 * against.
 *
 * A queued take is published: it is sitting on the bitmap feed and the board collects it
 * on its next wake. So an edit that made it into that take is not waiting on the user for
 * anything, which is exactly what A8 says about this number — "a take already on the feed
 * is not waiting on the user for anything, and saying '1 change queued' about it would
 * invite a second push of something already sent". Reading `published` alone said the
 * opposite: three edits queued still read as three changes queued.
 *
 * `published` is the baseline only when nothing is waiting, which is the case it was
 * written for.
 */
function baselineDoc() {
  return (queued && queued.doc) || published.doc;
}

/**
 * How many elements differ between what was written and what the editor holds.
 * Compared by serialized element, so a move, a recolor and a retyped label each
 * count once — this is the "3 changes waiting" number on A8, not a diff engine.
 *
 * Compared SAMPLE-BLIND (samples.js). serialize() bakes each bound element's last
 * reading into the document, and device.js now re-reads those bindings on the board's own
 * cycle — so without this, a panel watching a thermometer would report a change every
 * minute with nobody at the keyboard. A new reading is the panel doing its job; the live
 * take publishes it by itself, and it was never something the user was being asked to
 * send.
 */
export function countQueuedChanges(liveDoc) {
  const base = baselineDoc();
  if (!base || !liveDoc) return 0;
  const key = (el) => JSON.stringify(stripSamples(el));
  const before = (base.elements || []).map(key);
  const after = (liveDoc.elements || []).map(key);
  const pool = [...before];
  let added = 0;
  for (const el of after) {
    const i = pool.indexOf(el);
    if (i >= 0) pool.splice(i, 1);
    else added++;
  }
  // Anything left in the pool was removed or altered. An altered element shows
  // up once as a removal and once as an addition, so take the larger side rather
  // than the sum, or every edit would read as two changes.
  const removed = pool.length;
  const structural = Math.max(added, removed);
  // A display-settings change (mode, rotation, dither) redraws everything even
  // when no element moved, so it counts as one pending change on its own.
  const displayChanged = JSON.stringify(base.display) !== JSON.stringify(liveDoc.display);
  return structural + (displayChanged && structural === 0 ? 1 : 0);
}
