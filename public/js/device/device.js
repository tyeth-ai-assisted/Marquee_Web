/**
 * Everything that talks to a real board: the display add, the chunked canvas
 * write, the sleep/wake cycle, and the reset that tears all of it down.
 *
 * The shape of this module is dictated by one fact — a deep-sleeping e-paper
 * device is unreachable between wakes, and it pipelines its replies with no gap
 * (checkin.complete, then the next cycle's goodnight microseconds later). So
 * nothing here latches on "the last event seen": the board's reports are read
 * as an ordered log, pulled with a cursor into a local queue, and each stage
 * CONSUMES the event it cares about while leaving the others queued in order
 * for whoever owns them.
 */

import { bitmapFeedKey, sleepFeedKey, statusFeedKey, IO_MAX_NO_HISTORY } from '../core/api.js';
import { navigate } from '../core/router.js';
import { layer, hideDitherPreview } from '../canvas/stage.js';
import { select } from '../canvas/selection.js';
import { resetCounter } from '../canvas/elements.js';
import { refreshInterval } from '../core/config.js';
import { sleepPayloadFor } from './schedule.js';
import { activeDevice, livePaused } from './devices.js';
import {
  serialize, invalidateCanvasBaseline, saveCanvasNow, cancelCanvasSave,
} from '../core/doc.js';
import { renderBitmap, renderOrReport, tooLargeForIO, publishToIO } from '../canvas/render.js';
import { refreshFeedElements, readFeedData, hasFeedBindings, feedReadCost } from './feeds.js';
import { takeInFlight, parseStatus, readReport, TAKE_CEILING_MS, REPORT_GRACE_MS } from './cycle.js';
import {
  getState, setState, setPublished, clearPublished, getPublished,
  getQueued, setQueued, clearQueued, subscribe,
} from '../core/state.js';
import { syncPushBlock } from '../screens/a7.js';
import { Konva } from '../canvas/konva.js';
import { $, val, toast, fmtLocalSeconds } from '../core/util.js';

// ---------- observers -------------------------------------------------------

const deviceListeners = new Set();
/** Emits {type} for 'pushed' | 'queued' | 'woke' | 'slept' | 'reset' | 'status'.
 *
 *  'queued' means the image feed moved without anyone navigating anywhere — the queue
 *  button, and the live take below. A8 reads it as "re-read the pair". */
export function onDeviceEvent(fn) { deviceListeners.add(fn); }
function emit(type, detail = {}) { deviceListeners.forEach((fn) => fn({ type, ...detail })); }

/**
 * Say what the device is doing, to whoever is listening.
 *
 * There is no line in the toolbox for this any more. The chrome pill is the app's one
 * readout of awake vs asleep (displayState() in cycle.js, off the status feed), and a
 * second one at the foot of the editor rail — written by this path, from what the editor
 * had just done rather than from what the board reported — was the copy that eventually
 * disagreed with it.
 *
 * The EVENT stays, and it is the part that was load-bearing: a8.js re-reads the feed on
 * it, and `text` is still the most specific account of the step in flight for anything
 * that wants to show one.
 */
function status(text) {
  emit('status', { text });
}
function debugLine(text) {
  const el = $('sleepDebug');
  if (el) el.textContent = text;
}

// ---------- epoch -----------------------------------------------------------

/**
 * Bumped by every "Reset state". The cycle is driven by long-lived async loops
 * (the per-wake resend chain, the 45s retransmit window) that nulling a variable
 * cannot interrupt — they are already awaiting a fetch. Each captures the epoch
 * it started under and abandons itself the moment it changes, so a reset can't
 * be followed by a write to a device we just tore down.
 */
let stateEpoch = 0;

/**
 * The sleep window as it goes onto the feed, from the live sleep form — read fresh every
 * time, never snapshotted. A snapshot is what made the timer look unchangeable: the
 * duration was frozen at the moment the push was pressed.
 *
 * The SHAPE is schedule.js#sleepPayloadFor(), shared with the A1 tiles that publish a
 * schedule for a display that is not open. See docs/marquee-sleep.md.
 */
function currentSleepPayload() {
  return sleepPayloadFor(refreshInterval());
}

// ---------- countdown -------------------------------------------------------

let sleepCountdownTimer = null;

/**
 * `wakesAt` in flow state is the armed wake time, and it outlives this timer: Showtime's
 * headline reads it as "sleeping until 9:47 AM", and A1 reads each display's own out of
 * its status feed. Nothing counts it DOWN any more — the clapperboard that did was the
 * last per-second readout in the app and is gone.
 *
 * `since` is when the sleep actually BEGAN. It defaults to now, which is right for
 * the caller that just sent the command — but a status feed datum is read up to a
 * poll late, and anchoring that to the read instead of to the board's own timestamp
 * would push the wake time out a little further on every cycle.
 */
function startSleepCountdown(seconds, { since = Date.now() } = {}) {
  if (sleepCountdownTimer) { clearInterval(sleepCountdownTimer); sleepCountdownTimer = null; }
  const total = Math.max(0, Math.floor(seconds) || 0);
  const from = Number.isFinite(since) ? since : Date.now();
  setState({ deviceState: 'asleep', wakesAt: from + total * 1000, sleepSeconds: total });

  const fmt = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
  let left = Math.max(0, Math.round((from + total * 1000 - Date.now()) / 1000));
  const tick = () => {
    if (left <= 0) {
      clearInterval(sleepCountdownTimer);
      sleepCountdownTimer = null;
      // The timer only ESTIMATES the sleep duration — it does not mean the
      // device is back. Stay in a waiting state until the real checkin.complete
      // arrives (the poller flips this), or the poller gives up.
      status('⏰ Sleep timer elapsed — waiting for the device to check in…');
      return;
    }
    status(`💤 Sleeping — ${fmt(left)} remaining`);
    left--;
  };
  tick();
  if (total > 0) sleepCountdownTimer = setInterval(tick, 1000);
}

function stopSleepCountdown() {
  if (sleepCountdownTimer) { clearInterval(sleepCountdownTimer); sleepCountdownTimer = null; }
}

/**
 * "Push to display" — the Act II → Act III transition.
 *
 * Nothing here is a synchronous conversation with the board. Both halves of the
 * push are plain Adafruit IO feed writes that the board collects on its own
 * schedule: the dashboard on the image feed, the sleep window on its sibling.
 *
 * And because nothing acknowledges either write, this does NOT wait. Holding a
 * spinner for a board that may not be awake for another fifteen minutes would be
 * theatre — the honest UI is to say what was published and move to Act III.
 */
async function pushToDisplay() {
  const btn = $('sendBmpSleep');
  const epoch = stateEpoch;
  btn.disabled = true;
  const restore = () => { btn.disabled = false; syncPushBlock(); };
  btn.textContent = 'Rendering…';

  try {
    // Sampled feed values are part of serialize(), so refresh before snapshotting:
    // sampling after would bake a signature the very next edit disagrees with.
    await refreshFeedElements(undefined, { advanceCarousels: true });
    const doc = serialize();

    const r = await renderOrReport('push to the display');
    if (!r) return;
    if (tooLargeForIO(r.bmp)) return;

    // Skip past whatever the board reported before this push, so a previous cycle's
    // 'sleeping' cannot be credited to the one starting here.
    await resetStatusWatch();
    if (epoch !== stateEpoch) return;

    // 1) The dashboard first. If only one of the two writes lands, better it is
    // this one: a board holding a new image and an old sleep window still shows
    // the right thing.
    btn.textContent = 'Publishing to IO…';
    const io = await publishToIO(r.bmp);
    if (!io.ok) return;
    // What IO now holds. The live take below compares against this before republishing, so
    // a push is not immediately followed by a byte-identical one on the next cycle.
    noteBitmapOnFeed(r.bmp);

    // 2) The sleep window, as JSON on the sibling feed. Not size-checked — the
    // payload is a few dozen bytes and tooLargeForIO is about the BMP.
    btn.textContent = 'Publishing sleep…';
    const payload = currentSleepPayload();
    const sio = await publishToIO(JSON.stringify(payload), sleepFeedKey());

    // "Reset state" ran while we were publishing — the world this was building on
    // is gone, so stop without touching flow state.
    if (epoch !== stateEpoch) return;

    // This push republishes both feeds, so any take still waiting on a modelled
    // redraw is superseded — letting its promotion fire later would put an older
    // design on the left panel.
    dropQueuedWrite();
    setPublished({ png: 'data:image/png;base64,' + r.png, doc, at: Date.now() });

    // A failed sleep publish leaves us not knowing what the board will do, so it
    // arms nothing: the board falls back to the interval its firmware holds.
    const armed = sio.ok ? payload.alarm_type : null;
    setState({ lastWriteAt: Date.now(), wakeSource: armed });

    // 3) The countdown, but only when there is a time to count to. An unpublished
    // window has none — showing a clock for it would be inventing a wake time.
    //
    // Nor does a board that narrates its own cycle. What was just published is a REQUEST:
    // it takes effect at the board's next fetch, and the board then says what it actually
    // armed. Starting a countdown here would assert a sleep it has not taken — on top of a
    // take very likely still running — and the wake time would be wrong twice over, once
    // for the take still in progress and again for any cooldown. Its own report is a poll
    // away, and that one is evidence.
    if (boardReportsState()) {
      stopSleepCountdown();
      status('📨 Sleep window published — waiting for the board to say what it armed');
    } else if (armed === 'timer') {
      startSleepCountdown(payload.sleep_time);
    } else {
      stopSleepCountdown();
      setState({ deviceState: 'asleep', wakesAt: null });
      status('⚠️ Dashboard published, but the sleep window did not reach the feed');
    }

    toast(sio.ok
      ? `Published the dashboard and the sleep window — the board picks both up on its next wake`
      : `Dashboard published, but the sleep window failed (${sio.error}) — the board will sleep on the interval its firmware holds`);

    emit('pushed');
    // Watch the board's own feed for the rest of the cycle. This only LOOKS — it
    // never waits on an ack: a board running older firmware reports nothing, and
    // the modelled cycle stays in charge until one does.
    watchForStatus();
    // Act III is the only screen left with anything to say about this push.
    navigate('a8');
  } finally {
    restore();
  }
}

// ---------- the fallback promotion -------------------------------------------
//
// The ONLY estimate left anywhere, and it is not shown to anyone: for a board whose
// firmware reports nothing, "has it drawn the take I queued" has no evidence behind it, so
// a timer answers it. Everything else that used to be modelled here — the countdown, the
// phase of the cycle, when the next wake was due — is gone; a reporting board says all of
// it, and a silent board now gets prose that admits nothing is known rather than a clock
// with invented numbers.

/**
 * One whole take, budgeted rather than fitted.
 *
 * Deliberately a single generous constant instead of a per-panel calculation, because the
 * calculation was the bug: a take is bounded by the driver, not by the image. A redraw with
 * BUSY unwired is a flat `refresh_time` (40s default) and cannot even begin until
 * `seconds_per_frame` (180s default) has passed since the last one, so a 2.13" tri-color
 * measured 123s against a 14s fit. Being LATE here shows a stale image for a moment; being
 * early claims a redraw that has not happened.
 */
const FALLBACK_TAKE_S = 240;

/** One fallback cycle: the window the board was asked for, then a whole take. */
const fallbackPeriodMs = (st) => ((st.sleepSeconds || refreshInterval()) + FALLBACK_TAKE_S) * 1000;

let queuedWriteTimer = null;

/**
 * Move the queued take onto the panel at the moment the board has plausibly drawn
 * it — the only "write confirmed" this path will ever get.
 *
 * That moment is the END of the first awake window to START after the publish. The
 * board fetches the feed once per wake, so a publish landing mid-wake has most
 * likely already missed that fetch: ceil() waits for the next one rather than
 * claiming a redraw that didn't include it.
 */
function scheduleQueuedWrite() {
  clearTimeout(queuedWriteTimer);
  const q = getQueued();
  const st = getState();
  const periodMs = fallbackPeriodMs(st);
  // A board that reports for itself never needs guessing at: applyStatus promotes on
  // the real 'sleeping', and a timer running alongside it would race that with an
  // estimate and sometimes win.
  if (statusSeen) return;
  if (!q || !st.wakesAt || periodMs <= 0) return;

  const n = Math.max(0, Math.ceil((q.at - st.wakesAt) / periodMs));
  const writtenAt = st.wakesAt + n * periodMs + FALLBACK_TAKE_S * 1000;
  const epoch = stateEpoch;

  queuedWriteTimer = setTimeout(() => {
    const take = getQueued();
    if (!take || epoch !== stateEpoch) return;   // reset, or a push superseded it
    clearQueued();
    // Timestamped with the modelled write, not with the publish that queued it:
    // A8's caption says "written <time>", and the queue was minutes earlier.
    setPublished({ ...take, at: writtenAt });
    setState({ lastWriteAt: writtenAt });
  }, Math.max(0, writtenAt - Date.now()));
}

/** A fresh push supersedes any queued take: it publishes its own image and claims
 *  the panel itself, so a pending promotion would later overwrite it with an older
 *  design. */
function dropQueuedWrite() {
  clearTimeout(queuedWriteTimer);
  queuedWriteTimer = null;
  clearQueued();
}

// ---------- the status watch ------------------------------------------------
//
// The board reports two moments on its own feed: "awake" when it has connected,
// and "sleeping" as it arms its alarm. That pair is the only acknowledgement this
// editor gets, and it is worth more than a richer one-shot payload, because it
// BRACKETS the fetch: a take published before the 'awake' was on the feed when the
// board pulled, and one published between the two may have missed it.
//
// A feed's last value is STATE that stays put rather than an event log that has to
// be drained exactly once, so a late poll costs latency and nothing else — which is
// what makes a throttled background tab safe here.
//
// Payload contract: docs/marquee-status.md.

const STATUS_POLL_MS = 5000;
/** Data points per poll. More than one so a poll that lands after both transitions
 *  can still see the 'awake' that the 'sleeping' needs to be judged against. */
const STATUS_BATCH = 4;

let statusCursor = null;      // id of the newest datum already applied
let statusSeen = false;       // has this board EVER reported? the model/evidence switch
let statusPollTimer = null;
let lastAwakeAt = null;       // created_at of the most recent 'awake', for the bracket
let lastReportAt = null;      // created_at of the most recent report of any kind, for the log
let statusPolls = 0;          // polls made this cycle, so the log can show it is alive

const logClock = (t) => fmtLocalSeconds(new Date(t));

const since = (t) => `${Math.round((Date.now() - t) / 1000)}s ago`;

/** Durations in the log read in whatever unit keeps them short — an hourly interval in
 *  seconds is a number nobody can size at a glance. */
function fmtWait(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s`
    : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

/**
 * Narrate the watch.
 *
 * Two destinations, on purpose. The debug line under the tools panel is the LIVE
 * state — one line, always current. console.debug keeps the TRAIL, because "is the
 * board publishing" is a
 * question about history and one line cannot hold one; devtools hides debug-level
 * output unless you ask for Verbose, so this costs nothing for anyone who is not
 * currently staring at a board.
 */
function statusLog(line) {
  debugLine(`${statusFeedKey() || 'status feed'} · ${line}`);
  console.debug('[marquee-status]', line);
}

/** Has the board reported for itself at least once this session? While false, A8
 *  falls back to the modelled cycle; once true, a silent board means offline. */
export const boardReportsState = () => statusSeen;

/**
 * Start a cycle from whatever is already on the feed, without acting on it — a
 * status left behind by a previous bench run would otherwise drive this one.
 */
async function resetStatusWatch() {
  clearTimeout(statusPollTimer);
  statusPollTimer = null;
  lastAwakeAt = null;
  lastReportAt = null;
  statusPolls = 0;
  // A BATCH, not one datum. The cursor still moves to the newest, but the newest alone
  // cannot answer the only question that matters here — is the board up right now? — and
  // reading one meant the answer was thrown away with the rest of the history. A push
  // landing while the board is mid-take finds its `awake` sitting at the head of the feed,
  // seeds the cursor to exactly that datum, and so starts the cycle having discarded the
  // wake half of the bracket: no promotion check, and a watch that then has nothing to
  // wait on but an estimated deadline.
  const data = await readFeedData(statusFeedKey(), { limit: STATUS_BATCH });
  statusCursor = data && data.length ? data[0].id : null;
  if (!data) statusLog('unreadable — the feed may not exist yet, or the IO key is unset');
  else if (!data.length) statusLog('no history yet — nothing has ever been published here');
  else statusLog(`starting from datum ${data[0].id} (${logClock(data[0].createdAt)}), ignoring anything older`);
  if (data && data.length) adoptReportedState(data);
}

/**
 * Adopt the board's CURRENT state from the history the cursor just skipped past.
 *
 * Reading the head datum is not replaying history — a feed's last value is state, which is
 * the property this whole watch is built on. The newest thing the board said is what it is
 * doing now, and throwing that away with the rest of the batch is what left a push landing
 * mid-take with no wake to bracket against.
 *
 * What it deliberately does NOT do is run applyStatus(). That function has consequences —
 * it promotes a queued take onto the panel, it emits `pushed`/`slept` — and none of those
 * belong to a datum that was published before this cycle began. This only records.
 *
 * Either state counts as proof the board narrates itself, which is what stops the push
 * below from asserting a sleep on top of it.
 */
function adoptReportedState(data) {
  // The READING is cycle.js's, shared with A1 so the wall of tiles and the chrome pill
  // cannot answer this differently. What stays here is everything that reading MEANS to
  // the active board: the evidence flag, the open bracket, and the ticking countdown.
  //
  // BOTH ENDS of the last bracket come back, not just the head. The head alone says what
  // the board is doing; the pair says what it has already done, and Act III needs that to
  // tell the take on the glass from the take still waiting on the feed. Adopting only the
  // head left `lastWokeAt` null for a board found asleep — so a board that had demonstrably
  // woken, drawn and gone back to sleep was reported as having confirmed nothing.
  const r = readReport(data, { fallbackSleepSecs: refreshInterval() });
  if (!r) return;
  statusSeen = true;

  if (r.lastWokeAt) { lastAwakeAt = r.lastWokeAt; setState({ lastWokeAt: r.lastWokeAt }); }
  if (r.lastSleptAt) setState({ lastSleptAt: r.lastSleptAt });

  if (r.deviceState === 'online-awake') {
    setState({ deviceState: 'online-awake', wakesAt: null });
    statusLog(`board is mid-take — adopting the awake at ${logClock(r.reportedAt)} as the open bracket`);
    return;
  }

  // Asleep. startSleepCountdown() rather than r.wakesAt directly: it writes the same
  // three fields and then TICKS, which is the half a pure reading cannot carry.
  setState({ wakeSource: r.wakeSource });
  if (r.wakeSource === 'pin') setState({ deviceState: 'asleep', wakesAt: null, sleepSeconds: null });
  else startSleepCountdown(r.sleepSeconds, { since: r.reportedAt });
  statusLog(`board is asleep — adopting the sleeping at ${logClock(r.reportedAt)} `
    // A pin alarm has no duration to name; everything else does.
    + `(${r.sleepSeconds == null ? 'until the button' : `${r.sleepSeconds}s`} on ${r.wakeSource})`
    + `${r.lastWokeAt ? `, woke ${logClock(r.lastWokeAt)}` : ', no wake in this batch'}`);
}

let watchStarting = false;

/**
 * Start the status watch if it is not already running.
 *
 * The watch used to begin only at the end of a push, which meant a reloaded tab — or one
 * that had simply not pushed yet — never read the feed at all, on any screen. The board is
 * reporting the whole time regardless of what this editor is doing, so the watch belongs to
 * the session and not to the push: it starts at boot, survives navigation, and the chrome
 * pill is right in Act I for the same reason it is right in Act III.
 *
 * Seeding through resetStatusWatch() is what makes the pill correct IMMEDIATELY rather than
 * one poll later — adoptReportedState() reads the board's current state out of the same
 * batch that sets the cursor.
 *
 * Cheap to call repeatedly, which is the point: every caller can just say "there should be
 * a watch" without knowing whether there already is one.
 */
export async function ensureStatusWatch() {
  const st = getState();
  if (!statusFeedKey()) return;
  // A5b has not run, so the group key is a name someone half-typed and the feeds
  // behind it do not exist. Polling them is a 404 every five seconds for a fact we
  // already know, and it buries the real errors in the console. 'skipped' still
  // watches: the user declined to create the feeds, not to use ones already there.
  if (st.ioSetup === 'pending') return;
  // statusPollTimer alone is not enough of a guard: tick() awaits a fetch before setting it,
  // so two callers arriving in that gap would both start a loop and double the poll rate.
  if (statusPollTimer || watchStarting) return;
  watchStarting = true;
  try {
    await resetStatusWatch();
    watchForStatus();
  } finally {
    watchStarting = false;
  }
}

/** Anything newer than the cursor, oldest-first so transitions apply in order. */
async function pumpStatus() {
  const data = await readFeedData(statusFeedKey(), { limit: STATUS_BATCH });
  if (!data) return null;                       // unreadable: unknown, not "nothing"
  if (statusCursor === null) {
    // Unseeded — the feed was unreadable when the cycle started. Adopt the present
    // rather than replaying history, or a previous run's 'sleeping' would restart
    // this cycle's clock.
    statusCursor = data.length ? data[0].id : null;
    return [];
  }
  const fresh = [];
  for (const d of data) {                       // IO returns newest-first
    if (d.id === statusCursor) break;
    fresh.unshift(d);
  }
  if (fresh.length) statusCursor = fresh[fresh.length - 1].id;
  return fresh;
}

/**
 * One reported transition. It drives the shared flow state, so every screen that
 * already reacts to a state change reacts to these for free.
 */
function applyStatus(datum) {
  const s = parseStatus(datum.value);
  if (!s || (s.state !== 'awake' && s.state !== 'sleeping')) {
    // Logged rather than swallowed: a board publishing something this reader does not
    // understand is the single most likely thing to go wrong while the device half is
    // being written, and silence would make it look like nothing was published at all.
    statusLog(`ignored — unrecognised value ${JSON.stringify(String(datum.value).slice(0, 80))}`);
    return;
  }
  // Only a RECOGNISED state counts as a report — an unparseable datum is not
  // evidence, and treating it as such would retire the fallback for nothing.
  const first = !statusSeen;
  statusSeen = true;
  const at = Number.isFinite(datum.createdAt) ? datum.createdAt : Date.now();
  lastReportAt = at;
  if (first) status('📡 The board is reporting its own state — estimates retired');

  if (s.state === 'awake') {
    statusLog(`← awake${s.wake_reason ? ` (${s.wake_reason})` : ''} at ${logClock(at)}`
      + `${lastAwakeAt ? `, ${Math.round((at - lastAwakeAt) / 1000)}s after the last wake` : ''}`);
    stopSleepCountdown();
    lastAwakeAt = at;
    // The board's OWN timestamp, so Act III's banner and the redraw clock both run from
    // when it actually came up rather than from when this poll happened to see it.
    setState({ deviceState: 'online-awake', wakesAt: null, lastWokeAt: at });
    status(s.wake_reason === 'pin' ? '⏰ Board woke — button press'
      : s.wake_reason === 'reset' ? '⏰ Board woke — reset or first boot'
      : '⏰ Board woke — timer');
    emit('woke');
    return;
  }

  // 'sleeping': the board drew (or gave up) and is arming its alarm. Promote first,
  // so the panel and the clock update in one pass.
  statusLog(`← sleeping at ${logClock(at)}`
    + `${Number.isFinite(s.sleep_time) ? ` for ${s.sleep_time}s` : ' (no sleep_time reported)'}`
    + `${s.alarm_type ? ` on ${s.alarm_type}` : ''}`
    + `${lastAwakeAt ? `, awake ${Math.round((at - lastAwakeAt) / 1000)}s` : ''}`);

  const take = getQueued();
  if (take && lastAwakeAt != null && take.at < lastAwakeAt) {
    // The take was on the feed before the board connected, so that fetch saw it.
    dropQueuedWrite();
    setPublished({ ...take, at });
    setState({ lastWriteAt: at });
    emit('pushed');
    statusLog(`queued take promoted — it was published ${Math.round((lastAwakeAt - take.at) / 1000)}s `
      + 'before the board woke, so that fetch had it');
  } else if (take) {
    // Held rather than promoted. Worth saying out loud: from the outside this looks
    // like the queue being ignored, when it is the bracket refusing to guess.
    statusLog(lastAwakeAt == null
      ? 'queued take held — never saw this cycle\'s wake, so cannot tell if it was fetched'
      : `queued take held — published ${Math.round((take.at - lastAwakeAt) / 1000)}s AFTER the board `
        + 'woke, so that fetch may have missed it; it goes out next cycle');
  }

  const secs = Number.isFinite(s.sleep_time) ? s.sleep_time : refreshInterval();
  // wakeSource is what A8 reads to decide whether there is a wake TIME to count to.
  // lastWokeAt is deliberately LEFT alone: paired with lastSleptAt it is how long the
  // board was up, which is the most useful number on the banner.
  setState({ wakeSource: s.alarm_type || 'timer', lastSleptAt: at });
  if (s.alarm_type === 'pin') {
    stopSleepCountdown();
    setState({ deviceState: 'asleep', wakesAt: null, sleepSeconds: null });
  } else {
    startSleepCountdown(secs, { since: at });
  }
  // The board has armed its alarm, so the whole window is ours: this is the moment to put
  // a take carrying current readings on the feed, ahead of the fetch that follows. See
  // "the live take" below for why this event and no other.
  scheduleLiveTake();
  emit('slept');
}

// The offline ceiling and its grace are cycle.js#TAKE_CEILING_MS / REPORT_GRACE_MS —
// ONE number each, shared with A1, which makes the same judgement about a report it read
// off another display's feed. Generously over the worst take this hardware can produce: a
// 180s frame cooldown plus a 40s BUSY-less redraw plus the round trip. Not fitted per
// panel, because fitting it per panel is what produced a deadline of 86s for a 123s take.

/** The slow cadence, for when the board is not expected to say anything soon. */
const STATUS_IDLE_MS = 60000;

let watchStartedAt = null;

/**
 * When to look, and when to stop believing the board is coming back.
 *
 * Every anchor here is a FIXED point — a reported time, or when the watch began.
 * Anchoring on "now" would push the deadline forward on every tick, so a board that
 * died would be waited on forever at the fast cadence.
 */
function statusWindow(st) {
  // A pin-only alarm has no wake time and may not fire for days. There is nothing to
  // time out, so this watches slowly and forever rather than calling a board offline
  // for not having been pressed.
  if (st.wakeSource === 'pin') return { deadline: Infinity, idle: true };

  // Everything else gets ONE rule and one number. The old one had a deadline per case,
  // each computed from a fitted refresh time, and it wrote off a demonstrably alive board
  // 86s into a take that needed 123s — a 40s flat redraw behind an 83s frame cooldown, on a
  // panel the model thought was a 14s job. There is no version of that arithmetic worth
  // keeping, so this is a watchdog rather than a model: from whenever the board is next due
  // to speak, it gets one generous ceiling to do it in.
  //
  // `watchStartedAt` as a floor is what makes a stale report safe. A tab backgrounded for
  // an hour catches up on a 'sleeping' whose wake passed forty cycles ago; judging from
  // that would call a healthy board dead the instant we started listening again. Whenever
  // the watch (re)starts, the board gets a full ceiling from then.
  const due = takeInFlight(st) ? st.lastWokeAt : (st.wakesAt || lastReportAt || Date.now());
  const from = Math.max(due, watchStartedAt ?? 0);
  return { deadline: from + TAKE_CEILING_MS + REPORT_GRACE_MS };
}

/**
 * Watch the status feed.
 *
 * Polling is confined to the window the board could plausibly be up in: it is
 * unreachable for the rest, and IO's rate limit is a budget shared with every element
 * binding on the canvas. Outside the window this reschedules rather than polls, so the
 * watch survives an arbitrarily long sleep for the cost of one timer.
 */
function watchForStatus() {
  clearTimeout(statusPollTimer);
  watchStartedAt = Date.now();
  const epoch = stateEpoch;
  statusLog(statusFeedKey()
    ? `watching for the board to report (polling every ${STATUS_POLL_MS / 1000}s around each wake)`
    : 'no image feed set, so there is no status feed to watch');

  const tick = async () => {
    if (epoch !== stateEpoch) return;
    const { deadline, idle } = statusWindow(getState());
    const wait = () => { statusPollTimer = setTimeout(tick, idle ? STATUS_IDLE_MS : STATUS_POLL_MS); };

    // No quiet window. This used to skip polling for the length of a sleep on the grounds
    // that nothing can arrive before the wake — true of a board keeping perfect time, and
    // false of this one: the wake it reports is the alarm it armed, not the moment it comes
    // up, and a cooldown or a manual reset moves that by minutes. A watch that is asleep
    // when the board speaks is indistinguishable from one that is broken, which is exactly
    // how this looked. It costs 12 reads a minute against IO's 30 — see STATUS_POLL_MS.
    const fresh = await pumpStatus();
    if (epoch !== stateEpoch) return;
    statusPolls++;
    if (fresh === null) {
      statusLog(`poll ${statusPolls} — feed unreadable, retrying`);
      wait();
      return;
    }
    if (fresh.length) {
      // Applying these moves wakesAt, so the next tick re-reads the window.
      if (fresh.length > 1) statusLog(`${fresh.length} reports at once — catching up in order`);
      fresh.forEach(applyStatus);
      wait();
      return;
    }

    statusLog(`poll ${statusPolls} — nothing new`
      + `${lastReportAt ? `, last report ${since(lastReportAt)}` : ' yet'}`);

    if (Date.now() > deadline) {
      // Only a board that HAS reported can be judged silent. One that never did is
      // running older firmware, and the modelled cycle is still its best answer.
      if (statusSeen && getState().deviceState !== 'offline') {
        // deviceState alone retires the redraw clock, which reads lastWokeAt only while
        // the board is known to be up — so the reported times survive here on purpose,
        // and the banner can still show when it was last heard from.
        setState({ deviceState: 'offline', wakesAt: null });
        status('⚠️ No report from the board this cycle — it may not have come back');
        statusLog(`gave up on this cycle — ${fmtWait(Date.now() - deadline)} past the deadline`
          + `${lastReportAt ? `, last report ${since(lastReportAt)}` : ''}; still watching slowly`);
      } else if (!statusSeen) {
        statusLog('no report ever — this board is on the estimated cycle, which is expected '
          + 'until its firmware publishes');
      }
      // Keep looking, slowly: a board that is merely very late still counts, and the
      // next report puts the screen straight.
      statusPollTimer = setTimeout(tick, STATUS_IDLE_MS);
      return;
    }
    wait();
  };

  tick();
}

/** A catch-up read, for the moments when the poll cadence cannot be trusted: a
 *  backgrounded tab gets its timers throttled, and the feed's value is state rather
 *  than a stream, so one read closes the whole gap. */
export async function catchUpStatus() {
  if (statusCursor === null) return;
  const epoch = stateEpoch;
  const fresh = await pumpStatus();
  if (epoch !== stateEpoch || !fresh || !fresh.length) return;
  statusLog(`catching up — ${fresh.length} report${fresh.length === 1 ? '' : 's'} arrived while `
    + 'this tab was not being polled');
  fresh.forEach(applyStatus);
}

/** Stop watching and forget what was seen — a reset drops the world this was
 *  reporting on. `statusSeen` deliberately survives: whether the BOARD reports is a
 *  fact about its firmware, not about this cycle.
 *
 *  That reasoning holds for a reset and INVERTS for a device switch, where the next
 *  board is a different board with different firmware. stopDeviceRuntime() clears
 *  `statusSeen` for exactly that reason — see the note there. */
function stopStatusWatch() {
  clearTimeout(statusPollTimer);
  statusPollTimer = null;
  statusCursor = null;
  lastAwakeAt = null;
  watchStartedAt = null;
}

/**
 * "Queue for the next take" — what the push button does while the board sleeps.
 *
 * Deliberately not a push in the "and now watch it draw" sense: a deep-sleeping
 * panel has nothing listening. But nothing auto-registers on the board's behalf
 * either — the IO feeds ARE the mailbox, so the publish IS the queue.
 *
 * It writes the same two feeds as the push — they are the only mailbox a sleeping
 * board has — but it must not make the push's CLAIMS, because the board is mid-
 * sleep on a window it collected earlier and nothing here reaches it. So,
 * deliberately absent:
 *
 *   setPublished()        — that snapshot means "this is on the glass". The board
 *                           has not woken, let alone drawn, so recording it now
 *                           would make A8's two panels identical and hide the very
 *                           change being queued. It is held as the QUEUED take and
 *                           promoted when the modelled redraw lands, which is when
 *                           the panel actually changes — scheduleQueuedWrite.
 *   startSleepCountdown() — writing to a feed does not move the board's wake time.
 *                           `wakesAt` belongs to the sleep already running.
 *   lastWriteAt/wakeSource — nothing was written, and the alarm the board is
 *                           running is the one it armed before it slept; the new
 *                           window only takes effect after the next wake.
 */
async function queueForNextTake() {
  const btn = $('sendBmpSleep');
  const epoch = stateEpoch;
  btn.disabled = true;
  const restore = () => { btn.disabled = false; syncPushBlock(); };
  btn.textContent = 'Rendering…';

  try {
    // Bound feed values are part of the render, so re-read them first — same
    // reason as the push.
    await refreshFeedElements(undefined, { advanceCarousels: true });
    const doc = serialize();

    const r = await renderOrReport('queue the dashboard');
    if (!r) return;
    if (tooLargeForIO(r.bmp)) return;

    btn.textContent = 'Publishing to IO…';
    const io = await publishToIO(r.bmp);
    if (!io.ok) return;
    noteBitmapOnFeed(r.bmp);

    // The sleep window goes with it: an interval changed while editing is part of
    // the same take, and the board reads both feeds on the same wake.
    btn.textContent = 'Publishing sleep…';
    const sio = await publishToIO(JSON.stringify(currentSleepPayload()), sleepFeedKey());

    // "Reset state" ran while we were publishing — say nothing about a world that
    // is already gone.
    if (epoch !== stateEpoch) return;

    // Held, not published: this take is on the feed, and the panel changes when the
    // board next wakes and redraws.
    setQueued({ png: 'data:image/png;base64,' + r.png, doc, at: Date.now() });
    scheduleQueuedWrite();
    // The feed moved, and this is the only notice anything gets. A8 used to learn it from
    // the navigate() below re-running its enter hooks, which is an accident of routing
    // rather than a signal — and the live take has no navigation at all.
    emit('queued');

    toast(sio.ok
      ? 'Queued — the board collects it on its next wake'
      : `Dashboard queued, but the sleep window failed (${sio.error}) — the board keeps its current interval`);
    navigate('a8');
  } finally {
    restore();
  }
}

// ---------- the live take ---------------------------------------------------
//
// THE BUG THIS ANSWERS. A feed-bound widget was only ever re-read by a user action — a
// push, a queue, a preview, a click on "refresh" in the inspector. Every one of those is
// somebody asking to see a number. Nothing asked on the board's behalf, and the board is
// the only one actually looking: it wakes on its timer, fetches whatever datum is on the
// bitmap feed and redraws it, faithfully, forever. So a panel left cycling on its own
// showed the readings of the moment somebody last pressed something — for thirteen
// minutes, in the report this was written from, against a source feed publishing every
// sixty seconds.
//
// The fix is one caller that is not a user, and everything about it is shaped by that. It
// publishes quietly, it says a failure once, it never navigates, it refuses to publish to
// a board nobody has chosen to push to, and it does not touch the sleep feed — the window
// belongs to the sleep already running, and a second write per cycle would double the ops
// for a payload that has not changed.
//
// WHY IT HANGS OFF `sleeping` AND NOT `awake`. Three arguments, one moment. A `sleeping`
// report means the board has armed its alarm, so the whole window is ours and nothing is
// racing a fetch. It is also the only moment the promotion bracket above can credit: a
// take published now is older than the next `awake`, so applyStatus() promotes it next
// cycle instead of holding it (`take.at < lastAwakeAt`). And the firmware stays subscribed
// to the bitmap feed while it is up, so publishing on `awake` can land mid-take and buy a
// second panel refresh — up to two minutes of one, on a driver with BUSY unwired.
//
// What it does NOT do is aim at the freshest possible moment. Publishing at
// `wakesAt - lead` would carry newer numbers, but on a one-minute window the lead is most
// of the sleep, and a board that wakes early lands the publish inside its own fetch, which
// is the ambiguous case above. Data one window old is the staleness the board already has,
// and it is a strict improvement on never.

/** After the board says it is asleep, before the feed's only datum is replaced.
 *
 *  The bitmap feed is history-off, so what is on it at `sleeping` IS the take the board
 *  just drew — and A8 reads exactly that, on exactly this event, to photograph it before
 *  it is gone (see a8.js#fetchTakes and the `lastDrawn` cache). Publishing into that read
 *  would replace the picture being taken. The shortest window this editor offers is a
 *  minute, so a few seconds costs nothing and removes the race entirely. */
const LIVE_SETTLE_MS = 5000;

/** Floor between two live publishes, whatever asked for one. The same knob and the same
 *  reason as canvasfeed.js#MIN_GAP_MS: IO's ~30 ops a minute is an account-wide budget
 *  that the status watch above already spends 12 of. */
const LIVE_MIN_GAP_MS = 30000;

/** How long to wait out a gesture. A drag or a half-typed inspector field is not a
 *  moment to photograph the stage in — see liveStageBusy(). */
const LIVE_BUSY_RETRY_MS = 4000;

let liveTimer = null;
let liveRunning = false;
let liveAgain = false;
let lastLiveAt = 0;

/** The base64 BMP Adafruit IO is known to hold, or null when it holds none of ours.
 *
 *  The de-dupe that makes this feature nearly free: a gauge whose feed reports the same
 *  number for an hour renders the same bytes for an hour, and there is nothing to say. Set
 *  by the two user publishes as well as by this one, so the first cycle after a push does
 *  not republish what the push just sent. */
let lastPublishedBmp = null;

/** Said once per session, like canvasfeed.js. This runs on the board's clock behind
 *  whatever the user is doing, and a toast per cycle would be a wall of them. */
let liveReportedFailure = false;
let liveReportedTooLarge = false;

function liveLog(line) {
  console.debug('[marquee-live]', line);
}

/** Is someone's hand on the canvas right now? */
function liveStageBusy() {
  if (document.querySelector('#albumModal:not(.hidden)')) return true;
  if (Konva && typeof Konva.isDragging === 'function' && Konva.isDragging()) return true;
  const el = document.activeElement;
  if (!el || el === document.body || typeof el.closest !== 'function') return false;
  // The inspector and the popovers are rebuilt by a reselect; a field with focus in one of
  // them is a value being typed.
  return !!el.closest('#propBody, .sleep-pop, .dither-pop');
}

/**
 * Why this cycle should be skipped, as a sentence — or null to go ahead.
 *
 * A reason rather than a boolean so the console trail can say what happened. "Nothing was
 * published" has a dozen innocent causes and they are indistinguishable from a bug unless
 * the code says which one it was.
 *
 * Ordered cheapest and most decisive first.
 */
function liveBlockedBecause() {
  const st = getState();
  // A5b has not run, so the feeds behind the group key do not exist. The same guard, for
  // the same reason, as ensureStatusWatch().
  if (st.ioSetup === 'pending') return 'Adafruit IO setup has not been confirmed';
  if (!bitmapFeedKey() || !val('ioUser') || !val('ioKey')) return 'no group key or credentials yet';
  // THE CONSENT GUARD, and the one that must never be relaxed. Publishing this canvas to a
  // panel the user has not chosen to send to would put a stranger's draft on a board.
  // `lastWriteAt` is persisted per device, so this correctly resumes after a reload.
  if (!st.lastWriteAt && !getQueued() && !getPublished().doc) {
    return 'nothing has been pushed to this display yet';
  }
  // The switch on the A1 tile. After the consent guard so the trail still says when there
  // was never anything to pause.
  if (livePaused(activeDevice())) return 'live updates are paused for this display';
  if (!hasFeedBindings()) return 'nothing on this canvas is bound to a feed';
  // renderBitmap() photographs the stage through captureClean(), which deselects, drops
  // the zoom to 1:1 and puts both back — and select(null) rebuilds the inspector by
  // innerHTML. Under a live drag that is a jumping canvas; under a focused inspector field
  // it is the user's half-typed value destroyed. Nothing here is urgent enough to be worth
  // either, so a gesture postpones the take rather than cancelling it.
  if (liveStageBusy()) return 'busy';
  return null;
}

/**
 * Re-read the bindings, re-render, and put the result on the bitmap feed if it differs
 * from what is already there.
 *
 * Deliberately absent, for the reasons queueForNextTake() sets out above — nothing here
 * reaches the board, so nothing here may claim to have:
 *
 *   setPublished()         — the board has not drawn this. That claim is made by
 *                            applyStatus() on the next `sleeping`, from evidence.
 *   startSleepCountdown()  — writing a feed does not move an alarm the board already armed.
 *   lastWriteAt/wakeSource — same.
 *   publishToIO(sleep)     — the window has not changed.
 *   toast() on success     — nobody asked for this.
 *   navigate()             — this is not a user action and must never move the screen.
 */
async function takeLiveTake(reason) {
  if (liveRunning) { liveAgain = true; return; }
  const blocked = liveBlockedBecause();
  if (blocked) {
    liveLog('skipped — ' + blocked);
    // A gesture is temporary; everything else waits for the next trigger rather than
    // spinning a timer on a display that is switched off or has nothing bound.
    if (blocked === 'busy') armLiveTake(LIVE_BUSY_RETRY_MS, reason);
    return;
  }

  const epoch = stateEpoch;
  liveRunning = true;
  try {
    // Best-effort by contract: a failed read leaves the previous value rather than
    // blanking the element, so partial freshness still beats none.
    const allRead = await refreshFeedElements(undefined, { advanceCarousels: true });
    if (epoch !== stateEpoch) return;

    // renderBitmap() rather than renderOrReport(): that one toasts, and this runs on the
    // board's clock rather than on a click.
    let r;
    try {
      r = renderBitmap();
    } catch (e) {
      console.error('[marquee-live]', e);
      return;
    }

    if (r.bmp === lastPublishedBmp) {
      liveLog('nothing to publish — the render is byte-identical to what IO holds (' + reason + ')');
      return;
    }
    // tooLargeForIO() toasts; this is its quiet twin, said once.
    if (!r.fitsNoHistory) {
      if (!liveReportedTooLarge) {
        liveReportedTooLarge = true;
        toast('This dashboard is too large to refresh on the board\'s own cycle — shrink the '
          + 'panel or use fewer colours. The take already on the feed is unaffected.');
      }
      liveLog('skipped — ' + r.base64Bytes + ' B is over IO\'s ' + IO_MAX_NO_HISTORY + ' B ceiling');
      return;
    }

    lastLiveAt = Date.now();
    const out = await publishToIO(r.bmp, bitmapFeedKey(), { quiet: true });
    if (epoch !== stateEpoch) return;
    if (!out.ok) {
      if (!liveReportedFailure) {
        liveReportedFailure = true;
        toast('The dashboard could not be refreshed on "' + out.feed + '" (' + out.error + ') — '
          + 'the board keeps redrawing the take already on the feed.');
      }
      liveLog('publish failed — ' + out.error);
      // IO does not hold those bytes, so the next cycle must carry them again.
      lastPublishedBmp = null;
      return;
    }

    lastPublishedBmp = r.bmp;
    // Booked exactly as queueForNextTake() books one, and it becomes `published` by the
    // same route: the board's next `sleeping` promotes it, and scheduleQueuedWrite() is
    // the estimate a board that never reports gets instead.
    setQueued({ png: 'data:image/png;base64,' + r.png, doc: serialize(), at: Date.now() });
    scheduleQueuedWrite();
    emit('queued');
    liveLog('published ' + r.base64Bytes + ' B after ' + reason + ' — '
      + feedReadCost() + ' feed read(s)' + (allRead ? '' : ', some unreadable'));
  } finally {
    liveRunning = false;
    if (liveAgain) { liveAgain = false; armLiveTake(LIVE_SETTLE_MS, 'a trigger that arrived mid-run'); }
    else armLiveFallback();
  }
}

/** Run one, no sooner than the floor allows. */
function armLiveTake(delay, reason) {
  clearTimeout(liveTimer);
  const since = Date.now() - lastLiveAt;
  liveTimer = setTimeout(() => takeLiveTake(reason), Math.max(delay, LIVE_MIN_GAP_MS - since));
}

/**
 * The evidence trigger. Called from applyStatus()'s `sleeping` branch, which is the moment
 * this whole section is built around.
 */
function scheduleLiveTake() {
  armLiveTake(LIVE_SETTLE_MS, 'the board reported sleeping');
}

/**
 * The fallback, for a board whose firmware reports nothing.
 *
 * There is no `sleeping` to hang off, so the sleep window the editor last asked for is the
 * only clock available — the same model/evidence split scheduleQueuedWrite() makes one
 * section up, and it retires itself the moment a board proves it reports. Floored so a
 * one-minute interval cannot outrun the gap.
 */
function armLiveFallback() {
  clearTimeout(liveTimer);
  if (boardReportsState()) return;
  const period = Math.max(refreshInterval() * 1000, LIVE_MIN_GAP_MS);
  liveTimer = setTimeout(() => takeLiveTake('the estimated cycle'), period);
}

/**
 * What Adafruit IO now holds on the bitmap feed, told to us by whoever put it there.
 *
 * Called by the push and by the queue as well as by the live take, because the baseline is
 * about the FEED and not about who wrote to it: without it, the first cycle after a manual
 * push would republish bytes identical to the ones the push just sent.
 */
function noteBitmapOnFeed(bmp) {
  lastPublishedBmp = bmp;
  lastLiveAt = Date.now();
}

/**
 * The active display's live updates were switched on or off from its A1 tile.
 *
 * Off needs nothing but the timer cleared — liveBlockedBecause() refuses every take while
 * the flag is set, and a take already rendering finishes rather than being torn down. On
 * has to put a trigger back, because a skipped take re-arms nothing (see takeLiveTake):
 *
 *   board reports    wait for its next `sleeping`, the moment this section is built around
 *                    — unless it is asleep RIGHT NOW, in which case the window is already
 *                    ours and waiting would cost a whole cycle of stale numbers.
 *   board does not   the estimated cycle, exactly as at boot.
 */
export function syncLiveUpdates() {
  if (livePaused(activeDevice())) {
    clearTimeout(liveTimer);
    liveTimer = null;
    liveAgain = false;
    liveLog('paused from the display list');
    return;
  }
  if (!boardReportsState()) { armLiveFallback(); return; }
  if (getState().deviceState === 'asleep' && !takeInFlight()) {
    armLiveTake(LIVE_SETTLE_MS, 'live updates resumed while the board sleeps');
  }
}

/** Forget this board's take. A different display has a different panel on a different
 *  feed, so the byte baseline cannot travel with the session. */
function stopLiveTakes() {
  clearTimeout(liveTimer);
  liveTimer = null;
  liveAgain = false;
  lastPublishedBmp = null;
  lastLiveAt = 0;
  liveReportedFailure = false;
  liveReportedTooLarge = false;
}

// ---------- device switch ---------------------------------------------------

/**
 * Tear down everything this module holds about the board being left, without
 * touching the world outside the browser.
 *
 * This is resetState()'s steps 1–3 and nothing else: no confirm(), no button chrome,
 * no canvas wipe, no toast. The board is not being reset — it is
 * still out there running, and its autoresponders and wake response must survive
 * being looked away from. Only THIS PAGE's view of it is dropped.
 *
 * `statusSeen` is the one field that leaves here and does not leave stopStatusWatch().
 * That flag is the model/evidence switch behind boardReportsState() → displayState(),
 * which drives the chrome pill and A8's headline. Left set across a switch, a board
 * that has never said anything reads as "a board that proved it reports and then went
 * quiet" — the app would greet a brand-new draft with "Offline".
 */
export function stopDeviceRuntime() {
  // Invalidate every in-flight loop FIRST, before anything else changes under them.
  stateEpoch++;

  stopSleepCountdown();

  clearPublished();
  dropQueuedWrite();
  stopStatusWatch();
  stopLiveTakes();
  statusSeen = false;
}

// ---------- reset -----------------------------------------------------------

/**
 * One button back to a known-empty world. Two kinds of state accumulate:
 *
 *   1. the canvas — the elements plus the persisted document behind them
 *   2. this page's cycle state — the queued take, the published snapshot, the
 *      status watch and the countdown
 *
 * Deliberately KEPT: the display descriptor, sleep settings and IO credentials.
 * Those are the bench setup, not device state. Nothing here touches the Adafruit
 * IO feeds either: the board's last picture stays where it is, because clearing it
 * would blank a panel this button is not addressed to.
 */
async function resetState() {
  const btn = $('btnResetState');
  if (!confirm('Reset state?\n\nThis clears the canvas and stops watching the board.\n\n'
    + 'Display, sleep and Adafruit IO settings are kept, and nothing on Adafruit IO '
    + 'is touched.')) return;

  // 1) Invalidate every in-flight loop FIRST, before anything else changes under
  // them — an awaiting retransmit must not get a chance to write to the device.
  stateEpoch++;

  btn.disabled = true;
  btn.textContent = 'Resetting…';
  try {
    // 2) Kill the timers and the pending canvas save.
    stopSleepCountdown();
    cancelCanvasSave();

    // 3) Cycle state.
    clearPublished();
    dropQueuedWrite();
    stopStatusWatch();
    stopLiveTakes();
    setState({
      deviceState: 'online-awake', wakesAt: null, lastWriteAt: null,
      wakeSource: null, sleepSeconds: null, lastWokeAt: null, lastSleptAt: null,
    });

    // 4) The canvas. Elements only — the display block stays, so panel geometry
    // and dither settings survive.
    hideDitherPreview();
    layer.find('.element').forEach((n) => n.destroy());
    select(null);
    resetCounter();               // element ids start over from el1
    layer.draw();

    // 5) Re-baseline the saved document: the de-dupe baseline still holds the old
    // scene, so drop it or the empty canvas would never be persisted.
    invalidateCanvasBaseline();
    saveCanvasNow();

    status('☕ Device awake');
    debugLine('');
    emit('reset');

    toast('State reset — canvas cleared and the watch stopped');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Reset state';
  }
}

// ---------- boot ------------------------------------------------------------

export function initDevice() {
  $('sendBmpSleep')?.addEventListener('click', () => {
    // One button, two jobs: a sleeping board can only be queued for.
    if (getState().deviceState === 'asleep') return queueForNextTake();
    return pushToDisplay();
  });
  $('btnResetState')?.addEventListener('click', resetState);

  // A hidden tab has its timers throttled to a crawl, so the status poll can sleep
  // through a whole wake. Reading the feed once on the way back closes the gap —
  // the value is still sitting there, which is the point of watching state rather
  // than draining an event log.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    ensureStatusWatch();
    catchUpStatus();
    // The live take's own timer was throttled with everything else, and for a board that
    // does not report there is no catch-up report to re-arm it. Put the clock back.
    armLiveFallback();
  });

  // The board reports whether or not this editor has pushed anything, so the watch
  // starts with the session. A group key arriving later is what makes a status feed
  // exist to watch, hence the subscription as well as the call — both are no-ops
  // once a watch is running.
  ensureStatusWatch();
  subscribe(() => ensureStatusWatch());

  // The estimated clock for a board that never reports. A board that does report re-arms
  // this off its own `sleeping`, and armLiveFallback() stands down the moment one does.
  armLiveFallback();

  status('☕ Device awake');
}
