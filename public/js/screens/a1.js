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
 * Under the name, the two things that decide what a display does NEXT: whether the
 * editor is republishing its feed-bound widgets on the board's cycle (the live take in
 * device.js — ▶ / ❚❚, and a switch), and the sleep schedule it is on, read off its own
 * SLEEP feed and changeable from the tile. See the live/schedule section below.
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
import { boardReportsState, syncLiveUpdates } from '../device/device.js';
import {
  parseSleepPayload, reportedSleep, pickSleepSchedule, sleepPayloadFor, scheduleLine, fmtSleepShort,
} from '../device/schedule.js';
import { publishToIO } from '../canvas/render.js';
import { INTERVAL_OPTIONS } from './a7.js';
import { getState, subscribe } from '../core/state.js';
import { deviceEntry, navigate, currentScreen } from '../core/router.js';
import { DISPLAY_PRESETS, presetCardPhoto } from '../device/presets.js';
import { readPanelCache, writePanelCache } from './a8.js';
import * as devices from '../device/devices.js';
import {
  $, val, escapeHtml, escapeAttr, fmtAgo, fmtLocalTime, fmtLocalDateTime, toast, setFieldValue,
} from '../core/util.js';

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
  };
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

  return `<div class="device-card card" data-device="${escapeAttr(rec.id)}">
    <button type="button" class="card-open" aria-label="Open ${escapeAttr(f.label)}"></button>
    <span class="thumb">${glass}</span>
    <span class="meta">
      <span class="row">${pillHTML(f)}<span class="when">${escapeHtml(f.when)}</span></span>
      <span class="name">${escapeHtml(f.label)}</span>
      <span class="hardware">${escapeHtml(f.hardware)}</span>
      ${tileLiveHTML(rec)}
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
  return `<div class="device-card card is-draft" data-draft="true">
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

const ADD_TILE_HTML = `<button type="button" class="add-tile" id="a1Add">
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
    // The same batch says what the board armed, which the schedule line is checked against.
    boardSleeps.set(rec.id, reportedSleep(data));
    repaintStatus(rec);
    repaintLive(rec);
  }
}

// ---------- live updates and the sleep schedule -----------------------------
//
// The two settings that decide what a display does next, on the tile so they can be read
// across the wall and changed without opening each display in turn.
//
// LIVE UPDATES are the editor's, not the board's: device.js re-renders the feed-bound
// widgets and republishes the bitmap on the board's own cycle, for the ACTIVE display, for
// as long as this tab is open. The switch is a per-record flag (devices.js#livePaused)
// that liveBlockedBecause() refuses on, so it can be set for any display — it takes effect
// whenever that display is the one open.
//
// THE SCHEDULE is read off each display's own {group}.sleep feed — the window as last
// published — with the board's own `sleeping` report and then the record's setting as
// fallbacks (schedule.js#pickSleepSchedule says why in that order). Changing it here
// publishes a new payload to that feed, the same three fields a push sends, and saves the
// interval as the display's setting so the next push agrees with it.
//
// Session memory only, like the status reads: a schedule can be changed from another
// browser, and a cached one restored tomorrow would claim a window nobody published.

/** How long a sleep-feed read is good for. The schedule moves far less often than the
 *  status, so this rides the thumbnail sweep's cadence rather than the status sweep's. */
const SCHEDULE_TTL_MS = 60000;

/**
 * id -> what that display's sleep feed said:
 *
 *   { kind: 'payload', p }  a schedule — schedule.js#parseSleepPayload() plus `at`
 *   { kind: 'empty' }       the feed read fine and holds nothing usable
 *   { kind: 'unreachable' } the read itself failed
 *
 * Absent means not asked yet. As with `reports`, the four are kept apart because the tile
 * says something different for each.
 */
const schedules = new Map();

/** id -> what the board last said it slept on (schedule.js#reportedSleep), or null. Filled
 *  by the status sweep for every other display and by the schedule sweep for the active
 *  one, whose status feed the status sweep leaves to the watch. */
const boardSleeps = new Map();

let lastScheduleSweepAt = 0;

/** Bumped by every sweep and every render, as with the other two sweeps. */
let scheduleRun = 0;

/** This display's sleep feed, derived from its own record — no activation involved. */
function sleepFeedFor(rec) {
  return feedKeyIn(rec.settings?.ioGroup, 'sleep');
}

function scheduleFor(rec) {
  const e = schedules.get(rec.id);
  return pickSleepSchedule({
    feed: e?.kind === 'payload' ? e.p : null,
    board: boardSleeps.get(rec.id) || null,
    localSecs: fallbackSleepFor(rec),
  });
}

/** The ▶ / ❚❚ switch. It states the setting rather than offering its opposite: a play
 *  glyph on a display that is live reads as "it is playing", which is the question asked
 *  of a wall of tiles. aria-pressed carries the same fact to a screen reader. */
function liveToggleHTML(rec) {
  const label = devices.deviceLabel(rec);
  const paused = devices.livePaused(rec);
  const where = rec.id === devices.activeDeviceId()
    ? 'This is the display open in the editor, so it applies now.'
    : 'It applies whenever this display is the one open in the editor.';
  const title = paused
    ? `Live updates paused: feed-bound widgets are not republished on the board's cycle. ${where} Click to resume.`
    : `Live updates on: feed-bound widgets are re-read and republished on the board's own cycle while this tab is open. ${where} Click to pause.`;
  return `<button type="button" class="live-toggle" data-live="${escapeAttr(rec.id)}"
      data-paused="${paused}" aria-pressed="${paused ? 'false' : 'true'}"
      aria-label="Live updates for ${escapeAttr(label)}" title="${escapeAttr(title)}">
      <span class="live-icon" aria-hidden="true">${paused ? '❚❚' : '▶'}</span>
      <span class="live-text">${paused ? 'Paused' : 'Live'}</span>
    </button>`;
}

/** The schedule in a line, plus the one note it needs when the line is not the whole
 *  story: nothing published yet, a feed that would not answer, or a board that slept on
 *  something other than what was published. The long version is the tooltip. */
function scheduleHTML(rec) {
  const s = scheduleFor(rec);
  const e = schedules.get(rec.id);
  const feed = sleepFeedFor(rec) || 'its sleep feed';
  let note = '';
  let title;
  if (s.source === 'feed') {
    const at = Number.isFinite(e?.p?.at) ? ` at ${fmtLocalDateTime(new Date(e.p.at))}` : '';
    title = `As published to ${feed}${at}. The board follows it from its next wake.`;
    if (s.boardSecs !== null) {
      note = `board slept ${fmtSleepShort(s.boardSecs)}`;
      title += ` The board has since reported sleeping ${fmtSleepShort(s.boardSecs)}, so its firmware may not read the sleep feed yet.`;
    }
  } else if (s.source === 'board') {
    title = `As the board last reported it. Nothing usable is on ${feed} yet.`;
  } else if (!e) {
    title = `This display's own setting, while ${feed} is checked.`;
  } else if (e.kind === 'unreachable') {
    note = 'not confirmed';
    title = `Could not read ${feed}, so this is the display's own setting.`;
  } else {
    note = 'not published';
    title = `This display's own setting. Nothing is on ${feed} yet: it goes with the next push, or pick an interval here to send it now.`;
  }
  return `<span class="sched" title="${escapeAttr(title)}">`
    + `<span class="sched-text">${escapeHtml(scheduleLine(s))}</span>`
    + (note ? `<span class="sched-note">${escapeHtml(note)}</span>` : '')
    + '</span>';
}

/**
 * The row under the name. Above the card's open overlay, like .card-actions, or the
 * overlay would swallow every click on it.
 *
 * The picker is a select with a hidden "Change" placeholder rather than a select of the
 * current value: the current value is already the line beside it, and "Every 15 min"
 * next to "Sleeps 15 min" is the same fact twice. Choosing an option is the whole edit.
 */
function tileLiveHTML(rec) {
  const label = devices.deviceLabel(rec);
  const options = INTERVAL_OPTIONS.map((secs) =>
    `<option value="${secs}">Every ${escapeHtml(fmtSleepShort(secs))} — ${sleepPayloadFor(secs).sleep_mode} sleep</option>`).join('');
  return `<span class="tile-live">
      ${liveToggleHTML(rec)}
      ${scheduleHTML(rec)}
      <select class="sched-pick" data-sleep="${escapeAttr(rec.id)}"
        aria-label="Change the sleep schedule for ${escapeAttr(label)}"
        title="Publish a new sleep schedule to this display's sleep feed">
        <option value="" selected hidden>Change</option>${options}
      </select>
    </span>`;
}

function tileSlot(id, sel) {
  return $('a1Grid')?.querySelector(`[data-device="${CSS.escape(id)}"] ${sel}`) || null;
}

/** Repaint the schedule line and the switch in place. The select is left alone: it may be
 *  the element with focus, and rebuilding it would drop a keyboard user mid-choice. */
function repaintLive(rec) {
  if (!rec) return;
  const sched = tileSlot(rec.id, '.sched');
  if (sched) sched.outerHTML = scheduleHTML(rec);
  const toggle = tileSlot(rec.id, '.live-toggle');
  if (!toggle) return;
  const hadFocus = document.activeElement === toggle;
  toggle.outerHTML = liveToggleHTML(rec);
  if (hadFocus) tileSlot(rec.id, '.live-toggle')?.focus();
}

/**
 * Read every display's sleep feed, and the active display's status feed for what its
 * board last armed.
 *
 * Sequential, behind a TTL, and silent on failure — the same terms as the other two
 * sweeps, for the same shared rate limit. One datum per feed through `/data?limit=1`: the
 * sleep feed keeps history, and its newest value is the schedule.
 */
async function sweepSchedules() {
  const run = ++scheduleRun;
  if (!val('ioUser') || !val('ioKey')) return;
  const stale = Date.now() - lastScheduleSweepAt >= SCHEDULE_TTL_MS;
  lastScheduleSweepAt = Date.now();

  for (const rec of devices.listDevices()) {
    if (run !== scheduleRun || currentScreen() !== 'a1') return;
    const feed = sleepFeedFor(rec);
    if (!feed) continue;
    if (schedules.has(rec.id) && !stale) continue;

    const data = await readFeedData(feed, { limit: 1 });
    if (run !== scheduleRun) return;
    if (!data) {
      // As with status: a schedule already read stays what we last honestly knew.
      if (!schedules.has(rec.id)) schedules.set(rec.id, { kind: 'unreachable' });
    } else {
      const p = data[0] ? parseSleepPayload(data[0].value) : null;
      schedules.set(rec.id, p ? { kind: 'payload', p: { ...p, at: data[0].createdAt } } : { kind: 'empty' });
    }

    // The status sweep skips the active display — the watch owns it — so what its board
    // last armed is read here. One read, only for the comparison.
    if (rec.id === devices.activeDeviceId()) {
      const status = statusFeedFor(rec);
      const sd = status ? await readFeedData(status, { limit: STATUS_BATCH }) : null;
      if (run !== scheduleRun) return;
      if (sd) boardSleeps.set(rec.id, reportedSleep(sd));
    }
    repaintLive(rec);
  }
}

/**
 * Publish a new schedule for one display, active or not.
 *
 * Feed first, setting second: a setting that moved and a publish that failed would leave
 * the tile and the next push disagreeing about a window the board never received. On
 * success both move together. Nothing here touches the sleep the board is already in —
 * the new window applies from its next wake, which is what the toast says.
 */
async function changeSchedule(rec, secs) {
  const feed = sleepFeedFor(rec);
  const name = devices.deviceLabel(rec);
  if (!feed) { toast(`${name} has no Adafruit IO group yet — finish its setup first`); return; }
  const payload = sleepPayloadFor(secs);
  // publishToIO() says why on failure, naming the feed.
  const out = await publishToIO(JSON.stringify(payload), feed);
  if (!out.ok) return;

  // The active display's interval has a DOM home that flushActive() reads back, so it is
  // written there, with the event, so A7's chip and the record follow. Any other display
  // has only its record.
  if (rec.id === devices.activeDeviceId()) setFieldValue('sleepDuration', String(payload.sleep_time));
  else devices.patchSettings(rec.id, { sleepDuration: String(payload.sleep_time) });

  schedules.set(rec.id, {
    kind: 'payload',
    p: { secs: payload.sleep_time, alarmType: payload.alarm_type, mode: payload.sleep_mode, at: Date.now() },
  });
  repaintLive(devices.getDevice(rec.id));
  toast(`${name} now sleeps ${fmtSleepShort(payload.sleep_time)} (${payload.sleep_mode} sleep) — the board picks it up on its next wake`);
}

/** Flip a display's live updates, and tell the runtime if it is the one running them. */
function toggleLive(rec) {
  const paused = !devices.livePaused(rec);
  devices.patchSettings(rec.id, { livePaused: paused });
  if (rec.id === devices.activeDeviceId()) syncLiveUpdates();
  repaintLive(devices.getDevice(rec.id));
  toast(`Live updates ${paused ? 'paused' : 'on'} for ${devices.deviceLabel(rec)}`);
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
  scheduleRun++; // and a schedule sweep
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

    // The live switch, and the schedule picker. A click on the select only opens it — its
    // change event below does the work — but it must not fall through to the card's open.
    const live = e.target.closest('[data-live]');
    if (live) {
      const rec = devices.getDevice(live.dataset.live);
      if (rec) toggleLive(rec);
      return;
    }
    if (e.target.closest('.sched-pick')) return;

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

  $('a1Grid').addEventListener('change', async (e) => {
    const pick = e.target.closest('.sched-pick');
    if (!pick) return;
    const secs = parseInt(pick.value, 10);
    // Back to "Change" straight away: the line beside it is what states the schedule.
    pick.value = '';
    const rec = devices.getDevice(pick.dataset.sleep);
    if (!rec || !Number.isFinite(secs)) return;
    pick.disabled = true;
    try { await changeSchedule(rec, secs); } finally { pick.disabled = false; }
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
    //
    // The schedule between them: one small read per display, and the line most likely to
    // be acted on from here.
    sweepStatus();
    sweepSchedules();
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
