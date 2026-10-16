/**
 * A1 — your displays.
 *
 * Home, and the only screen that is about more than one device. Everything else in the
 * app is written against whichever record is active; this is where that changes.
 *
 * Two states in one screen. With devices it is a grid of tiles plus a dashed add slot;
 * with none it is the add slot alone. There is no separate empty-state screen because
 * there is nothing separate to say — the grid already contains the one action, and an
 * onboarding panel that appears and then never appears again is a screen most users
 * see exactly once.
 *
 * Tiles show what is on the panel rather than a device name and a status, which is what
 * makes the list read like a wall of little screens. The picture comes from the cache
 * a8.js writes on every confirmed draw — and, for every display this browser has never
 * watched draw, from that display's own bitmap feed, read here (see sweepThumbs). The
 * cache alone left most of the wall saying "Nothing drawn yet" about boards with a
 * perfectly good picture published to them.
 *
 * The pill beside it comes from that display's own STATUS feed, read the same way and
 * for the same reason — see the status section below, which is the longer version of
 * why a stored snapshot could not answer it.
 *
 * It is also where the Adafruit IO account is settled. The add tile is gated on one:
 * setup writes feeds from its first step, so a display added without a checked
 * username and key is a display whose setup cannot finish. See a1c.js.
 */

import { activateDevice, removeDevice } from '../device/activate.js';
import { hasIoConfig, connectedUser } from '../device/credentials.js';
import { openCredentialsGate } from './a1c.js';
import { openFlash } from './a6a.js';
import { feedKeyIn } from '../core/api.js';
import { readFeedLast, readFeedData } from '../device/feeds.js';
import { displayState, readReport, reportIsOverdue } from '../device/cycle.js';
import { boardReportsState } from '../device/device.js';
import { getState, subscribe } from '../core/state.js';
import { deviceEntry, navigate, currentScreen } from '../core/router.js';
import { DISPLAY_PRESETS, presetCardPhoto } from '../lib/presets.js';
import { readPanelCache, writePanelCache } from './a8.js';
import * as devices from '../device/devices.js';
import { $, val, escapeHtml, escapeAttr, fmtAgo, fmtLocalTime, fmtLocalDateTime, fmtInterval, toast } from '../core/util.js';
import { sleepModeFor } from '../core/config.js';

/**
 * What a tile can say about a device without activating it.
 *
 * The LABELS come off the stored record — that is the constraint that makes the grid
 * cheap, since rendering N tiles must not mean hydrating N boards, and it is why the
 * record carries `flow` and `displayConfig` snapshots rather than pointers.
 *
 * The STATE does not, and must not: see the status section below.
 */
function tileFacts(rec) {
  const flow = rec.flow || {};
  const preset = flow.selectedPanel ? DISPLAY_PRESETS[flow.selectedPanel] : null;
  const reading = readingFor(rec);

  return {
    label: devices.deviceLabel(rec),
    hardware: preset?.spec || 'Panel set up by hand',
    phase: reading.phase,
    when: whenLine(reading, rec),
    schedule: scheduleLine(rec),
  };
}

/**
 * What the display is set to do between draws, from its own record, e.g. "Sleeps 15
 * minutes · deep sleep · live updates paused". Read-only and from nothing but the record:
 * the sleep interval the editor last pushed for it, and the Live switch on Build the
 * Scene. Changing either is done there, on the display itself.
 */
function scheduleLine(rec) {
  const secs = Math.max(0, parseInt(rec.settings?.sleepDuration, 10) || 0);
  const parts = [];
  if (secs) parts.push(`Sleeps ${fmtInterval(secs)}`, `${sleepModeFor(secs)} sleep`);
  if (devices.livePaused(rec)) parts.push('live updates paused');
  return parts.join(' · ');
}

/** This display's bitmap feed, derived from its own record — no activation involved. */
function bitmapFeedFor(rec) {
  return feedKeyIn(rec.settings?.ioGroup, 'bitmap');
}

/** The last panel image cached for this display, if there is one. a8.js owns the
 *  format; this screen is the other end of it. */
function thumbFor(rec) {
  return readPanelCache(rec.id, bitmapFeedFor(rec) || null)?.src || null;
}

/**
 * The same vocabulary as the chrome pill (router.js), from the same derivation, in the
 * same two classes — plus the one reading this screen needs and the chrome does not.
 *
 * The chrome only ever describes the ACTIVE board, which by definition has a watch on
 * it. A wall of tiles is mostly boards nobody is watching, so it has to be able to say
 * "I have not asked yet" and "it has never told me" without dressing either up as a
 * state the board is in.
 */
const PILL = {
  redrawing:  ['pill-on-air', 'On air'],
  sleeping:   ['pill-asleep', 'Sleeping 💤'],
  offline:    ['pill-offline', 'Offline'],
  unreported: ['pill-asleep', 'No status'],
  unreachable:['pill-asleep', 'No status'],
  checking:   ['pill-asleep', 'Checking\u2026'],
};

function pillHTML(f) {
  const [cls, text] = PILL[f.phase] || PILL.checking;
  return `<span class="pill ${cls}"><span class="dot"></span>${text}</span>`;
}

/**
 * A device tile: the picture, what the record knows, and the things you do to the board
 * itself — re-flash it, move it to another network, remove it.
 *
 * The card cannot be one big button any more — those live inside it, and a control
 * inside a control is neither valid markup nor reachable by keyboard. So the opening
 * action is an empty button STRETCHED OVER the card (see .card-open), leaving the
 * picture and the meta as direct children of the card exactly as they were when the
 * card itself was the button. Wrapping them in the button instead was tried first and
 * is what cropped every thumbnail: it put a flex container between the card and the
 * preview box for a control that draws nothing.
 */
function deviceTileHTML(rec) {
  const f = tileFacts(rec);
  const src = thumbFor(rec);
  const glass = src
    ? `<img class="thumb-img" src="${escapeAttr(src)}" alt="">`
    : '<span class="thumb-empty">Nothing drawn yet</span>';

  return `<div class="device-card card blueprint" data-device="${escapeAttr(rec.id)}">
    <button type="button" class="card-open" aria-label="Open ${escapeAttr(f.label)}"></button>
    <span class="thumb">${glass}</span>
    <span class="meta">
      <span class="row">${pillHTML(f)}<span class="when">${escapeHtml(f.when)}</span></span>
      <span class="name">${escapeHtml(f.label)}</span>
      <span class="hardware">${escapeHtml(f.hardware)}</span>
      ${f.schedule ? `<span class="hardware schedule">${escapeHtml(f.schedule)}</span>` : ''}
    </span>
    <span class="card-actions">
      <button type="button" class="btn btn-sm btn-ghost" data-firmware="${escapeAttr(rec.id)}"
        aria-label="Update firmware on ${escapeAttr(f.label)}"
        title="Flash the latest firmware release — also how you re-upload it">Update firmware</button>
      <button type="button" class="btn btn-sm btn-ghost" data-wifi="${escapeAttr(rec.id)}"
        aria-label="Update Wi-Fi for ${escapeAttr(f.label)}">Update Wi-Fi</button>
      <button type="button" class="btn btn-sm btn-danger card-remove" data-remove="${escapeAttr(rec.id)}"
        aria-label="Remove ${escapeAttr(f.label)}">Remove</button>
    </span>
  </div>`;
}

/**
 * A draft gets a tile of its own rather than being hidden.
 *
 * Only reached once something has been entered — devices.js discards an untouched draft
 * on the way in here. Past that point, quietly dropping a half-configured board because
 * the user clicked away is worse than showing an unfinished one and letting them decide.
 */
function draftTileHTML(rec) {
  const label = devices.deviceLabel(rec);
  const named = label !== 'Untitled display';
  // Nothing has been drawn on a draft, so the picture is the panel's product shot — the
  // same one its card showed on A4. Only before a panel is picked is there nothing to show.
  const photo = presetCardPhoto(rec.flow?.selectedPanel);
  const glass = photo
    ? `<img class="thumb-img" src="${escapeAttr(photo)}" alt="" decoding="async">`
    : '<span class="thumb-empty">Setup unfinished</span>';
  const thumbClass = photo ? 'thumb thumb-photo' : 'thumb';
  return `<div class="device-card card blueprint is-draft" data-draft="true">
    <button type="button" class="card-open" data-resume="${escapeAttr(rec.id)}"
      aria-label="Resume setup for ${escapeAttr(named ? label : 'this display')}"></button>
    <span class="${thumbClass}">${glass}</span>
    <span class="meta">
      <span class="row"><span class="pill pill-setup">Setup in progress 🔧</span></span>
      <span class="name">${escapeHtml(named ? label : 'New display')}</span>
      <span class="hardware">This device is not set up yet, click here to pick up where you left off</span>
    </span>
    <span class="card-actions">
      <button type="button" class="btn btn-sm btn-danger card-remove" data-remove="${escapeAttr(rec.id)}"
        aria-label="Remove ${escapeAttr(named ? label : 'this display')}">Remove</button>
    </span>
  </div>`;
}

const ADD_TILE_HTML = `<button type="button" class="add-tile blueprint" id="a1Add">
    <i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>
    <span class="plus">+</span>
    <span class="cap">Add a new marquee display</span>
    <span class="sub">Let's get started!</span>
  </button>`;

// ---------- what each display is actually doing ------------------------------
//
// From the board's own status feed, and from nothing else.
//
// These tiles used to read `rec.flow` — a snapshot of live flow state, mirrored into
// the record by main.js's subscribe. Three things were wrong with that, and they
// compounded into a wall of boards all claiming to be on air while they slept:
//
//   - That mirror only ever writes the ACTIVE record, and only one status feed is ever
//     polled (device.js resolves statusFeedKey() through the live #ioGroup field). So
//     every other tile was frozen at whatever its board's state was the last time it
//     was open — and the usual freeze is the worst one. You push, the board goes
//     'online-awake' with a lastWriteAt, you switch away, and the tile says On air for
//     good while the board is off sleeping.
//   - "Live" was `!asleep && !!lastWriteAt`. lastWriteAt is the EDITOR's own write, so
//     it is evidence about the editor; and excluding only 'asleep' meant a board
//     device.js had already judged 'offline' came out green as well.
//   - state.js#normalize() nulls lastWokeAt/lastSleptAt on the way in, precisely
//     because they are stale claims about a board that has since moved on. A tile
//     reading them straight out of the record was trusting exactly what state.js
//     refuses to.
//
// So each display's state is read from its OWN {group}.status feed — the same feed
// device.js watches, through the same reading (cycle.js#readReport), judged silent by
// the same rule (cycle.js#reportIsOverdue). A record carries its own group key, so this
// needs no activation, exactly like the thumbnail sweep below.
//
// NO MODELLING. A board that has never reported is shown as not having reported. The
// modelled cycle that used to answer this question was deleted for not surviving
// contact with hardware (see cycle.js), and a wall of twelve tiles is the last place to
// reintroduce it twelve times over.
//
// In memory for the session only — deliberately unlike the thumbnail cache next door. A
// picture stays true until something redraws it; "asleep, wakes at 9:47" does not, and a
// cached one restored tomorrow morning would be a lie with a timestamp on it.

/** Data points per read. More than one for device.js's reason: a read can land after
 *  both transitions, and the 'sleeping' needs the 'awake' to be bracketed against. */
const STATUS_BATCH = 4;

/** How long a status read is good for. Short — this is the fact on the tile most likely
 *  to have changed while you were away — but not zero, or bouncing in and out of a
 *  display would re-read every feed on the account. */
const STATUS_TTL_MS = 20000;

/**
 * id -> what happened when we asked that display's feed:
 *
 *   { kind: 'report', r }   the board said something; `r` is cycle.js's reading of it
 *   { kind: 'silent' }      the feed read fine and holds nothing we recognise
 *   { kind: 'unreachable' } the read itself failed
 *
 * Absent means not asked yet, which is a fourth thing and the reason this is a Map of
 * outcomes rather than of reports. Collapsing any two of these loses a distinction the
 * tile has to draw: "asleep" and "we have no idea" are not the same claim.
 */
const reports = new Map();

let lastStatusSweepAt = 0;

/** Bumped by every sweep and every render, so a sweep still walking the list when the
 *  grid is rebuilt underneath it stops rather than painting into stale tiles. */
let statusRun = 0;

/** The flow-state fields a tile's status row is drawn from. Anything else moving —
 *  lastScreen, ioSetup, the panel selection — is not this screen's business, and
 *  repainting on it would rebuild a row on every keystroke in the editor. */
const REPAINT_ON = ['deviceState', 'wakesAt', 'wakeSource', 'lastWokeAt', 'lastSleptAt', 'lastWriteAt'];

/** This display's status feed, derived from its own record — no activation involved. */
function statusFeedFor(rec) {
  return feedKeyIn(rec.settings?.ioGroup, 'status');
}

/** What to assume when a board sleeps without saying for how long. That display's own
 *  setting, not the live form field — the form belongs to whichever board is active. */
function fallbackSleepFor(rec) {
  return Math.max(0, parseInt(rec.settings?.sleepDuration, 10) || 0);
}

/**
 * 'redrawing' | 'sleeping' | 'offline' | 'unreported' | 'checking', with whatever times
 * came with it.
 */
function readingFor(rec) {
  // The ACTIVE display is not read from here. device.js has a live watch on this very
  // feed, polling it every few seconds, holding a cursor, and applying an offline
  // judgement floored at when the watch started — all things a single read cannot do.
  // Its flow state is strictly fresher than anything this screen could fetch.
  if (rec.id === devices.activeDeviceId()) {
    const st = getState();
    // Same switch A8 uses: until the board has spoken once, there is nothing to report.
    return { phase: boardReportsState() ? displayState(st) : 'unreported', st };
  }

  const e = reports.get(rec.id);
  if (!e) return { phase: 'checking', st: null };
  if (e.kind === 'unreachable') return { phase: 'unreachable', st: null };
  if (e.kind === 'silent') return { phase: 'unreported', st: null };
  // readReport() returns flow-state field names, which is what displayState() reads —
  // the two halves of cycle.js meeting in the middle. It cannot itself return 'offline':
  // that is a judgement about silence, and one read hears no silence.
  return { phase: reportIsOverdue(e.r) ? 'offline' : displayState(e.r), st: e.r };
}

/**
 * The one line of time under the pill.
 *
 * An ABSOLUTE wake time, not a countdown: nothing on this screen ticks, so "wakes in
 * 4:12" would be frozen at whatever it was when the grid last rendered. "wakes at
 * 9:47 AM" stays true however long the tile sits there.
 */
function whenLine({ phase, st }, rec) {
  const at = (t) => fmtLocalTime(new Date(t));
  switch (phase) {
    case 'redrawing':
      return st?.lastWokeAt ? `woke at ${at(st.lastWokeAt)}` : 'awake now';
    case 'sleeping':
      // A pin alarm has no wake TIME — it sleeps until a finger lands on the button — so
      // there is no clock to print and inventing one would be a fiction.
      if (st?.wakeSource === 'pin') return 'wakes on the button';
      return Number.isFinite(st?.wakesAt) ? `wakes at ${at(st.wakesAt)}` : 'asleep';
    case 'offline': {
      const last = st?.reportedAt ?? st?.lastSleptAt ?? st?.lastWokeAt;
      // A date and time, not "2d ago": an offline board is one you go and look at, and
      // the moment it last spoke is what you check it against.
      return last ? `last updated: ${fmtLocalDateTime(new Date(last))}` : 'not reporting';
    }
    // Same pill as 'unreported' — both mean we cannot say what the board is doing — but
    // the reason is different and belongs somewhere, so it goes on the detail line
    // rather than inventing a second pill for a distinction about US, not the board.
    case 'unreachable':
      return 'could not read its feed';
    case 'unreported': {
      // The board has said nothing, so the only true thing left is what WE did. Named as
      // a publish rather than a refresh: a push is a feed write, and whether the panel
      // ever drew it is exactly the question this feed exists to answer and has not.
      const w = rec.flow?.lastWriteAt;
      return w ? `published ${fmtAgo(w)}` : '';
    }
    default:
      return '';
  }
}

/** Repaint one tile's status row in place, without rebuilding the grid under a sweep. */
function repaintStatus(rec) {
  const row = $('a1Grid')?.querySelector(`[data-device="${CSS.escape(rec.id)}"] .row`);
  if (!row) return;
  const f = tileFacts(rec);
  row.innerHTML = `${pillHTML(f)}<span class="when">${escapeHtml(f.when)}</span>`;
  renderCount();
}

/**
 * Ask every display that is not the active one what it is doing.
 *
 * Sequential and behind a TTL for the same reason the thumbnail sweep is: these are
 * reads against an account-wide rate limit shared with the status watch and with every
 * feed-bound element on the canvas.
 */
async function sweepStatus() {
  const run = ++statusRun;
  if (!val('ioUser') || !val('ioKey')) return;
  const stale = Date.now() - lastStatusSweepAt >= STATUS_TTL_MS;
  lastStatusSweepAt = Date.now();

  for (const rec of devices.listDevices()) {
    if (run !== statusRun || currentScreen() !== 'a1') return;
    if (rec.id === devices.activeDeviceId()) continue;   // the watch owns that one
    const feed = statusFeedFor(rec);
    if (!feed) continue;
    if (reports.has(rec.id) && !stale) continue;

    const data = await readFeedData(feed, { limit: STATUS_BATCH });
    if (run !== statusRun) return;
    // null is UNREADABLE — feed missing, credentials wrong, network down — and that is
    // not the same as "this board has never reported". Leave the tile saying whatever it
    // last honestly said rather than recording a silence nobody observed.
    if (!data) {
      // Nothing known yet, and now we could not ask: say so rather than leaving the tile
      // on "Checking…" for a read that has already failed and is not coming back.
      // A tile that DOES hold a report keeps it — it is still the last thing the board
      // honestly said, and reportIsOverdue() ages it into Offline on its own.
      if (!reports.has(rec.id)) { reports.set(rec.id, { kind: 'unreachable' }); repaintStatus(rec); }
      continue;
    }
    const r = readReport(data, { fallbackSleepSecs: fallbackSleepFor(rec) });
    reports.set(rec.id, r ? { kind: 'report', r } : { kind: 'silent' });
    repaintStatus(rec);
  }
}

// ---------- filling the empty tiles -----------------------------------------
//
// The cache a8.js writes only covers displays THIS browser has watched draw. Every
// other tile said "Nothing drawn yet" about a board with a perfectly good picture
// sitting on its bitmap feed — the one thing on this screen that is knowable without
// activating anything, since a record carries its own group key.
//
// So the grid paints from cache immediately and then asks IO, one display at a time.
// Sequential is deliberate: these are ~20 KB base64 payloads each and every read counts
// against an account-wide rate limit shared with every feed-bound element on the canvas.

/** How long a sweep is good for. Bouncing into a display and straight back out must not
 *  re-read every feed; a minute later, it is worth asking again. */
const SWEEP_TTL_MS = 60000;

let lastSweepAt = 0;

/** Bumped by every render() and every sweep, so a sweep that is still walking the list
 *  when the grid is rebuilt underneath it stops rather than painting into stale tiles. */
let sweepRun = 0;

function thumbSlot(id) {
  return $('a1Grid')?.querySelector(`[data-device="${CSS.escape(id)}"] .thumb`) || null;
}

function paintThumb(id, src) {
  const slot = thumbSlot(id);
  if (slot) slot.innerHTML = `<img class="thumb-img" src="${escapeAttr(src)}" alt="">`;
}

function paintThumbNote(id, text) {
  const slot = thumbSlot(id);
  if (slot) slot.innerHTML = `<span class="thumb-empty">${escapeHtml(text)}</span>`;
}

/**
 * Fill in what the tiles could not know, from each display's own bitmap feed.
 *
 * What lands in the cache is the NEWEST datum on the feed, which is very nearly always
 * the picture on the glass: on a history-off feed there is only ever one, and the board
 * redraws whatever is there on its next wake. It can be a take published minutes ago and
 * not yet collected — A8 is the screen that draws that distinction, and it has the wake
 * bracket to draw it with. A wall of thumbnails does not, and "the picture this display
 * is carrying" is the honest reading of it either way.
 *
 * Every failure is silent. A missing feed, no credentials, a network that is down — the
 * tile keeps saying nothing was drawn, which is exactly as much as we know.
 */
async function sweepThumbs() {
  const run = ++sweepRun;
  if (!val('ioUser') || !val('ioKey')) return;
  // The TTL governs RE-reading a tile that already has a picture. A tile with none is
  // asked about every time: it is the empty tile this whole sweep exists for, and
  // leaving it empty for a minute because of a sweep that happened before its display
  // was added would be the same bug in a smaller window.
  const stale = Date.now() - lastSweepAt >= SWEEP_TTL_MS;
  lastSweepAt = Date.now();

  for (const rec of devices.listDevices()) {
    // The grid was rebuilt, or the user left. Either way the tiles this was painting
    // into are gone.
    if (run !== sweepRun || currentScreen() !== 'a1') return;
    const feed = bitmapFeedFor(rec);
    if (!feed) continue;

    const known = !!thumbFor(rec);
    if (known && !stale) continue;
    if (!known) paintThumbNote(rec.id, 'Reading the feed…');
    const d = await readFeedLast(feed);
    if (run !== sweepRun) return;
    if (!d) {
      if (!known) paintThumbNote(rec.id, 'Nothing drawn yet');
      continue;
    }
    const take = {
      src: `data:image/bmp;base64,${String(d.value || '').replace(/\s+/g, '')}`,
      at: d.createdAt,
    };
    writePanelCache(rec.id, feed, take);
    paintThumb(rec.id, take.src);
  }
}

/**
 * The count under the heading, from the same reading as the pills.
 *
 * "on air" is claimed only where a board has SAID so — a display still being checked, or
 * one that has never reported, is not counted. That means the number can climb as the
 * sweep lands, which is the honest shape: it is a count of evidence, not of tiles.
 */
function renderCount(list = devices.listDevices()) {
  const live = list.filter((r) => readingFor(r).phase === 'redrawing').length;
  $('a1Count').textContent = list.length
    ? `${list.length} display${list.length === 1 ? '' : 's'} · ${live} on air right now`
    : 'No displays yet';
}

function render() {
  sweepRun++;    // whatever a thumbnail sweep was painting into is about to be replaced
  statusRun++;   // and the same for a status sweep
  const list = devices.listDevices();
  const draft = devices.getDraft();

  renderCount(list);

  $('a1Grid').innerHTML = [
    ...list.map(deviceTileHTML),
    draft ? draftTileHTML(draft) : '',
    ADD_TILE_HTML,
  ].join('');

  renderAccountButton();
}

/**
 * Which account the app is pointed at, on the button that changes it.
 *
 * The username is the whole content: "Adafruit IO account" alone says nothing a
 * user with two accounts needs, and it is exactly the user with two accounts who
 * will click this. textContent, not innerHTML — a username is user data.
 */
function renderAccountButton() {
  const btn = $('a1Account');
  if (!btn) return;
  const connected = hasIoConfig();
  btn.dataset.connected = String(connected);
  $('a1AccountUser').textContent = connected ? connectedUser() : 'not connected';
}

/**
 * Mint a display and go and set it up.
 *
 * Named because it is now a continuation as well as a click handler: when there
 * are no credentials it is what A1-C runs on success, which is what makes
 * cancelling the dialog leave nothing behind — the draft is not created until
 * after the account is.
 */
async function startNewDisplay() {
  const rec = devices.createDraft();
  // createDraft() only mints the record; the app still has to be pointed at it, and
  // that means flushing whatever device was active behind this list.
  await activateDevice(rec.id);
  navigate('a4');
}

/**
 * What removing a display actually costs, said before it happens.
 *
 * Named rather than inlined because it is the one thing on this screen that cannot be
 * undone, and because the second paragraph is the part that matters: the record goes,
 * and so do the display's group and four feeds on Adafruit IO — the scene on canvas-state
 * with them (removeDevice() → provision.js#deleteGroupFeeds, best-effort). The board is
 * not touched: it keeps drawing whatever it last fetched, and will find its feeds gone the
 * next time it wakes.
 *
 * Same wording as "Remove display" in Settings, which is the same action reached from
 * the other end.
 */
function confirmRemoval(rec) {
  const name = devices.deviceLabel(rec);
  return confirm(`Remove "${name}"?\n\nIts dashboard and settings are deleted from this `
    + 'browser, and its group and feeds are deleted from Adafruit IO. The board itself is '
    + 'not touched — it keeps running whatever was last flashed onto it.');
}

export function initA1({ onEnter }) {
  $('a1Grid').addEventListener('click', async (e) => {
    // The tile's own controls come FIRST, Remove leading. Each sits inside a tile that
    // also opens on click, so a check that ran after the open would never be reached —
    // closest() finds the card from the button just as happily.
    //
    // One path for every tile, finished or still in setup: the same confirm, the same
    // removeDevice() (which a draft needs anyway — it is usually the ACTIVE record, see the
    // note there), and the same toast. A draft may already have its group and feeds on
    // Adafruit IO from A5b, so it costs as much to remove as anything else.
    const remove = e.target.closest('[data-remove]');
    if (remove) {
      const rec = devices.getDevice(remove.dataset.remove);
      if (!rec || !confirmRemoval(rec)) return;
      const name = devices.deviceLabel(rec);
      await removeDevice(rec.id);
      render();
      toast(`Removed ${name}`);
      return;
    }

    // Maintenance on a finished display: the same two setup screens, opened partway. The
    // display is activated first because both screens work on whichever record is active.
    const firmware = e.target.closest('[data-firmware]');
    if (firmware) {
      await activateDevice(firmware.dataset.firmware);
      openFlash({ stage: 'flash' });
      return;
    }

    const wifi = e.target.closest('[data-wifi]');
    if (wifi) {
      await activateDevice(wifi.dataset.wifi);
      navigate('a5c');
      return;
    }

    const resume = e.target.closest('[data-resume]');
    if (resume) {
      const rec = devices.getDevice(resume.dataset.resume);
      await activateDevice(rec.id);
      navigate(deviceEntry(rec));
      return;
    }

    const add = e.target.closest('#a1Add');
    if (add) {
      // The gate. Nothing is created on the way in, so cancelling the dialog is a
      // no-op rather than something to roll back.
      if (!hasIoConfig()) {
        openCredentialsGate({ mode: 'add', trigger: add, onSaved: startNewDisplay });
        return;
      }
      await startNewDisplay();
      return;
    }

    const card = e.target.closest('[data-device]');
    if (!card) return;
    const rec = devices.getDevice(card.dataset.device);
    if (!rec) return;
    await activateDevice(rec.id);
    navigate(deviceEntry(rec));
  });

  // Edit mode, and no continuation: changing the account from here settles a fact
  // about the browser, not a step in a flow, so a successful save just repaints
  // the button. That callback is the only difference from the add tile's path.
  $('a1Account').addEventListener('click', (e) => openCredentialsGate({
    mode: 'edit', trigger: e.currentTarget, onSaved: renderAccountButton,
  }));

  onEnter('a1', () => {
    // Arriving here is the moment an abandoned draft stops being in progress. Only the
    // untouched case is dropped — see discardUntouchedDraft().
    devices.discardUntouchedDraft();
    render();
    // After the paint, never before it: the grid is complete from cache the moment the
    // screen appears, and the feed reads fill in the gaps behind it.
    //
    // Status first. It is the fact most likely to be wrong on arrival — a board sleeps
    // and wakes on its own schedule while a picture only changes when something redraws
    // it — and the two sweeps share an account-wide rate limit, so the order they queue
    // in is the order they land in.
    sweepStatus();
    sweepThumbs();
  });

  // The active display's state moves UNDER this screen: the status watch is not
  // screen-bound, so it keeps polling while the list is open. render() only runs on the
  // way in, so without this a board that fell asleep in front of you kept saying On air
  // until you navigated away and came back.
  subscribe((st, patch) => {
    if (currentScreen() !== 'a1') return;
    if (!REPAINT_ON.some((k) => k in patch)) return;
    const rec = devices.activeDevice();
    if (rec) repaintStatus(rec);
  });
}
