/**
 * The device store: which marquees this browser knows about, and which one the rest
 * of the app is currently pointed at.
 *
 * THE MODEL. Every other module in the app is written against exactly one device —
 * `display` in palette.js is a singleton, `ioGroupKey()` takes no device argument,
 * and fifteen call sites read `val('pmDevice')` off the DOM on the spot. Rather than
 * thread an id through all of that, the live stores ARE the active device's stores. A
 * record here is a SNAPSHOT of the per-device slices; switching device means flushing
 * the live stores into the outgoing record and loading the incoming one back in.
 *
 * That makes this file a pure store. It reads and writes localStorage and the DOM's
 * settings fields, and it imports nothing but util.js. It must stay that way:
 * provision.js:4 exists precisely so a setup screen does not drag Konva in through
 * feeds.js, and importing config.js or doc.js here would undo that for every screen.
 * The ordered re-init that a swap needs lives in activate.js, which is free to import
 * the editor; this module only moves the pointer and hands over the slices.
 *
 * FOUR KEY FAMILIES, not one blob:
 *
 *   marquee.devices          the index below — small, rewritten often
 *   marquee.canvas.<id>      one document per device
 *   marquee.canvasAt.<id>    when that document was last written here
 *   marquee.panelNow.<id>    one last-drawn panel image per device
 *
 * They are split because doc.js debounces a save every 400ms while you drag an
 * element, and because the payloads are large: elements.js allows 25MB per embedded
 * image and a8.js documents panel PNGs from 21KB to 340KB. One blob would rewrite
 * every device's artwork on every mouse move.
 */

import { $, toast } from '../core/util.js';

const INDEX_KEY = 'marquee.devices';
const CANVAS_KEY = (id) => `marquee.canvas.${id}`;
/** When CANVAS_KEY was last written, as its own tiny entry rather than a field inside
 *  the document. The document is rewritten on a 400ms debounce and can be megabytes;
 *  the stamp beside it is thirteen bytes, and keeping it out of the doc means nothing
 *  that reads a document has to know it is there. */
const CANVAS_AT_KEY = (id) => `marquee.canvasAt.${id}`;
const PANEL_KEY = (id) => `marquee.panelNow.${id}`;

/** The keys the pre-multi-device build wrote, read once by migrate() and then left
 *  alone. Not deleted: a user who downgrades should find their bench intact. */
const LEGACY = {
  settings: 'marquee.settings',
  flow: 'marquee.flow',
  displayConfig: 'marquee.displayConfig',
  panelNow: 'marquee.panelNow',
};

/**
 * Which settings fields belong to the ACCOUNT and which to the DEVICE.
 *
 * One table rather than two arrays, because two arrays is a shape where a newly added
 * field can end up in both or neither and nothing complains. main.js's single `input`
 * listener dispatches on this, and flushActive() reads the 'device' half back off the
 * DOM.
 *
 * `pmUser` is account-scoped, which is a limitation rather than a finding: one
 * Adafruit IO account for the whole app is fine for a bench tool and would not be
 * fine for a product.
 */
export const SETTINGS_SCOPE = {
  ioUser: 'account',
  ioKey: 'account',
  pmUser: 'account',
  pmDevice: 'device',
  ioGroup: 'device',
  sleepDuration: 'device',
};

export const ACCOUNT_FIELDS = Object.keys(SETTINGS_SCOPE).filter((k) => SETTINGS_SCOPE[k] === 'account');
export const DEVICE_FIELDS = Object.keys(SETTINGS_SCOPE).filter((k) => SETTINGS_SCOPE[k] === 'device');

function emptyEnv() {
  return { version: 1, activeId: null, order: [], draftId: null, account: {}, byId: {} };
}

let env = emptyEnv();

// ---------- storage ---------------------------------------------------------

/**
 * Every setItem in this app used to be a bare try/catch, which turns a full origin
 * quota into silent data loss. With N devices holding a canvas each — and elements.js
 * allowing a 25MB embedded image — that stops being theoretical, so per-device writes
 * go through here and say so when they fail.
 */
function writeKey(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    if (err && err.name === 'QuotaExceededError') {
      toast('Out of browser storage — this change was not saved. Remove a display to free space.');
    }
    return false;
  }
}

function readJson(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) ?? fallback) : fallback;
  } catch {
    return fallback;
  }
}

function persist() { writeKey(INDEX_KEY, JSON.stringify(env)); }

// ---------- reading ---------------------------------------------------------

/** Ready devices, in user order. Drafts are excluded STRUCTURALLY — they are in
 *  `byId` but never in `order` — so no caller can forget to filter one out. */
export function listDevices() {
  return env.order.map((id) => env.byId[id]).filter(Boolean);
}

export function activeDeviceId() { return env.activeId; }
export function activeDevice() { return env.activeId ? env.byId[env.activeId] || null : null; }
export function getDevice(id) { return env.byId[id] || null; }
export function getDraft() { return env.draftId ? env.byId[env.draftId] || null : null; }
export function getAccount() { return { ...env.account }; }

/**
 * What to call a device in the crumb and on its A1 tile.
 *
 * `marqueeName` first, and note where it lives: CONFIG_FIELDS in config.js, riding
 * along with the panel descriptor rather than sitting in the settings blob with the
 * other per-device strings. It is the most user-visible per-device field in the app,
 * stored in the place you would look last.
 */
export function deviceLabel(rec) {
  return (rec?.displayConfig?.marqueeName || rec?.settings?.pmDevice || '').trim() || 'Untitled display';
}

// ---------- writing ---------------------------------------------------------

function newId() {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function touch(rec) { rec.updatedAt = Date.now(); }

export function saveAccount(patch) {
  env.account = { ...env.account, ...patch };
  persist();
}

/** Patch the active record's top level. Used by the setup screens to record progress
 *  and by A5b to write the resolved group key back. */
export function patchActive(patch) {
  const rec = activeDevice();
  if (!rec) return null;
  Object.assign(rec, patch);
  touch(rec);
  persist();
  return rec;
}

/**
 * Whether this record is a finished display rather than one going through setup.
 *
 * A5C and A6-A are reached two ways: as steps of setup, and from an A1 tile to change
 * the Wi-Fi or re-flash a display that is already done. The second kind must not
 * record a setupStep — nothing would ever clear it, and every open of the display
 * would land back on that screen instead of the editor.
 */
export function isFinished(rec) {
  return rec?.status === 'ready' && !rec.setupStep;
}

/**
 * Patch one record's settings, active or not.
 *
 * For a field with a DOM home (DEVICE_FIELDS) on the ACTIVE record this is not enough on
 * its own: flushActive() reads those back off the form and would put the old value back.
 * Write the field with util.js#setFieldValue() instead, which is the convention for every
 * programmatic settings write. Fields with no DOM home — `livePaused` — live here only.
 */
export function patchSettings(id, patch) {
  const rec = env.byId[id];
  if (!rec) return null;
  rec.settings = { ...rec.settings, ...patch };
  touch(rec);
  persist();
  return rec;
}

/**
 * Has this display's live take been paused from its A1 tile?
 *
 * Stored on the record rather than in the settings form: it is a switch on the editor's
 * own behaviour, not a value the board or its config file ever sees, and it has to be
 * flippable for a display that is not the active one. Absent means live — every record
 * written before the switch existed keeps the behaviour it had.
 */
export function livePaused(rec) {
  return rec?.settings?.livePaused === true;
}

export function setSetupStep(id, step) {
  const rec = env.byId[id];
  if (!rec) return;
  rec.setupStep = step;
  touch(rec);
  persist();
}

/**
 * Mint an incomplete device and make it active. A1's add tile calls this; A4, A5b,
 * A5C and A6-A fill it in; A6-A promotes it.
 *
 * `flow` starts empty. There is one device path now, so nothing here chooses one —
 * a record migrated from a build that carried a `firmwarePath` simply drops it on
 * the next load (sanitize() keeps only DEFAULTS keys; see state.js).
 */
export function createDraft() {
  const id = newId();
  env.byId[id] = {
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'draft',
    setupStep: 'a4',
    settings: { pmDevice: '', ioGroup: '', sleepDuration: '300' },
    flow: {},
    displayConfig: null,
    /** The board's cfg-marquee.json, filled in by cfg.js as setup advances. */
    cfg: null,
  };
  env.draftId = id;
  persist();
  return env.byId[id];
}

/** End of A6-A: the draft becomes a device. This is the slot completeActOne() used to
 *  occupy, and the only place a record enters `order`. */
export function promoteDraft(id) {
  const rec = env.byId[id];
  if (!rec || rec.status !== 'draft') return null;
  rec.status = 'ready';
  rec.setupStep = null;
  touch(rec);
  if (!env.order.includes(id)) env.order.push(id);
  if (env.draftId === id) env.draftId = null;
  persist();
  return rec;
}

export function deleteDevice(id) {
  if (!env.byId[id]) return;
  delete env.byId[id];
  env.order = env.order.filter((x) => x !== id);
  if (env.draftId === id) env.draftId = null;
  if (env.activeId === id) env.activeId = env.order[0] || null;
  try { localStorage.removeItem(CANVAS_KEY(id)); } catch { /* already gone */ }
  try { localStorage.removeItem(CANVAS_AT_KEY(id)); } catch { /* already gone */ }
  try { localStorage.removeItem(PANEL_KEY(id)); } catch { /* already gone */ }
  persist();
}

/**
 * Send a device back through setup without forgetting it. Flow state and setup
 * progress go; the descriptor, the canvas and the settings stay, because those are the
 * bench setup rather than device state — the same line resetState() draws in device.js.
 */
export function resetDevice(id) {
  const rec = env.byId[id];
  if (!rec) return;
  rec.flow = {};
  rec.setupStep = 'a4';
  touch(rec);
  persist();
}

/**
 * Discard a draft that was opened and abandoned before anything was entered.
 *
 * Only the untouched case — still on the first step with no panel chosen. A draft that
 * got as far as a panel or a group key survives and shows on A1 as a resume tile:
 * silently throwing away a half-configured board is worse than showing an
 * unfinished one.
 */
export function discardUntouchedDraft() {
  const rec = getDraft();
  if (!rec) return;
  if (rec.setupStep === 'a4' && !rec.flow?.selectedPanel) deleteDevice(rec.id);
}

// ---------- the side stores -------------------------------------------------

export function saveCanvas(id, doc) {
  if (!writeKey(CANVAS_KEY(id), JSON.stringify(doc))) return;
  // Only after the document itself lands. A stamp newer than the document it claims to
  // describe is worse than no stamp: activate.js reads the two together to decide
  // whether this browser or the canvas-state feed is holding the newer scene.
  writeKey(CANVAS_AT_KEY(id), String(Date.now()));
}
export function loadCanvas(id) { return readJson(CANVAS_KEY(id), null); }

/** When this browser last saved this device's document, or null if it never has. */
export function canvasSavedAt(id) {
  try {
    const raw = Number(localStorage.getItem(CANVAS_AT_KEY(id)));
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  } catch {
    return null;   // storage disabled: no local save this can be older or newer than
  }
}

/** a8.js owns the contents; this owns the naming, so the key moves with the device. */
export function panelNowKey(id) { return PANEL_KEY(id); }

// ---------- the settings DOM ------------------------------------------------

function readField(id) {
  const el = $(id);
  if (!el) return undefined;
  return el.value;
}

function writeField(id, value) {
  const el = $(id);
  if (!el || value === undefined) return;
  el.value = value;
}

/** Snapshot the account-scoped fields off the DOM. */
export function snapshotAccountFields() {
  const out = {};
  ACCOUNT_FIELDS.forEach((id) => {
    const v = readField(id);
    if (v !== undefined) out[id] = v;
  });
  return out;
}

export function restoreAccountFields() {
  ACCOUNT_FIELDS.forEach((id) => writeField(id, env.account[id]));
}

export function restoreDeviceFields(settings = {}) {
  DEVICE_FIELDS.forEach((id) => writeField(id, settings[id]));
}

// ---------- the swap --------------------------------------------------------

/**
 * Write the live stores back into the active record.
 *
 * Called before every switch, and it is the reason doc.js's autosave has to be
 * cancelled first: a debounced save that fires after `activeId` has moved would put
 * the outgoing device's document into the incoming device's record.
 *
 * The canvas and displayConfig arrive as arguments rather than being read here,
 * because reading them means importing doc.js and config.js — see the module note.
 */
export function flushActive({ flow, displayConfig, canvas } = {}) {
  const rec = activeDevice();
  if (!rec) return;
  rec.settings = { ...rec.settings };
  DEVICE_FIELDS.forEach((id) => {
    const v = readField(id);
    if (v !== undefined) rec.settings[id] = v;
  });
  if (flow) rec.flow = flow;
  if (displayConfig) rec.displayConfig = displayConfig;
  if (canvas) saveCanvas(rec.id, canvas);
  env.account = { ...env.account, ...snapshotAccountFields() };
  touch(rec);
  persist();
}

/**
 * Move the pointer, flushing the device being left.
 *
 * Deliberately does NOT re-initialise anything. This module knows what a device is;
 * activate.js knows what has to be rebuilt when one changes underneath the app, and
 * calls this in the middle of doing it.
 */
export function setActive(id, snapshot) {
  if (!env.byId[id]) return null;
  if (env.activeId && env.activeId !== id) flushActive(snapshot);
  env.activeId = id;
  persist();
  return env.byId[id];
}

// ---------- migration -------------------------------------------------------

/**
 * Is there a bench setup here from before devices existed?
 *
 * Deliberately NOT gated on `actOneDone`. config.js writes marquee.displayConfig on the
 * first keystroke in any descriptor field and on every A4 card click, so a setup that
 * got most of the way through Act I but never finished it would have a descriptor, a
 * panel and credentials — and would be silently discarded by an actOneDone check.
 */
function hasLegacySetup() {
  const settings = readJson(LEGACY.settings, null);
  return !!(
    readJson(LEGACY.displayConfig, null)
    || readJson(LEGACY.flow, null)
    || (settings && Object.keys(settings).length)
  );
}

/**
 * Fold the old single-device stores into one record.
 *
 * The legacy field migration moves here from main.js#restoreSettings(), where it
 * ran on every boot forever. This is the last time the flat blob is ever read, so this
 * is the one place it can be genuinely one-time:
 *
 *   ioFeed  -> ioGroup   v1 stored a flat image-feed key before feeds moved into a group
 */
function migrate() {
  const settings = readJson(LEGACY.settings, {}) || {};
  const flow = readJson(LEGACY.flow, {}) || {};
  const displayConfig = readJson(LEGACY.displayConfig, null);

  if (typeof settings.ioGroup !== 'string' && typeof settings.ioFeed === 'string') {
    settings.ioGroup = settings.ioFeed;
  }

  const id = newId();
  const pick = (fields) => {
    const out = {};
    fields.forEach((k) => { if (settings[k] !== undefined) out[k] = settings[k]; });
    return out;
  };

  env = {
    version: 1,
    activeId: id,
    order: [id],
    draftId: null,
    account: pick(ACCOUNT_FIELDS),
    byId: {
      [id]: {
        id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: 'ready',
        // Null even when the old flow never finished Act I. A5C has no prior state
        // that could say whether it ran, and A3/A5/A6 are parked — so "resume setup"
        // would mean sending a bench that worked yesterday through a Wi-Fi screen it
        // has never needed. Letting it into the editor is the lesser wrong.
        setupStep: null,
        settings: pick(DEVICE_FIELDS),
        flow,
        displayConfig,
        // null distinguishes "never seeded" from "seeded and empty", so boot() knows
        // whether it still owes this record a GET /canvas.
        canvasSeeded: false,
      },
    },
  };

  const panel = localStorage.getItem(LEGACY.panelNow);
  if (panel) writeKey(PANEL_KEY(id), panel);

  persist();
}

/**
 * Load the index, migrating a pre-devices bench on the way past. Touches no DOM and
 * runs before initSettings()/initConfig(), both of which need a record to read from.
 */
export function initDevices() {
  const saved = readJson(INDEX_KEY, null);
  if (saved && saved.byId) {
    env = { ...emptyEnv(), ...saved };
    return;
  }
  if (hasLegacySetup()) migrate();
  else env = emptyEnv();
  // No evidence of a prior setup leaves an empty envelope: landingScreen() sends the
  // user to A1, which renders its empty state.
}

/** True when the active record has never been given a document — the one thing
 *  migration could not do synchronously when the document lived on a server. */
export function activeNeedsCanvasSeed() {
  const rec = activeDevice();
  return !!rec && rec.canvasSeeded === false && !loadCanvas(rec.id);
}

export function markCanvasSeeded(id, doc) {
  const rec = env.byId[id];
  if (!rec) return;
  rec.canvasSeeded = true;
  if (doc) saveCanvas(id, doc);
  persist();
}

/** Is this group key already claimed by another device? Two boards sharing a group
 *  publish to the same {group}.bitmap and each read the other's status as their own —
 *  the one way this store can produce genuinely wrong behaviour rather than a mess. */
export function groupKeyTaken(key, exceptId) {
  const k = (key || '').trim();
  if (!k) return false;
  return Object.values(env.byId).some((r) => r.id !== exceptId && (r.settings?.ioGroup || '').trim() === k);
}
