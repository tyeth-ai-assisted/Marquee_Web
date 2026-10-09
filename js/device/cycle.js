/**
 * What the display is doing, from what the board said it is doing.
 *
 * ONE derivation, read by both consumers — the chrome pill (router.js) and the Showtime
 * bar (screens/a8.js). They are two views of the same question, and while they answered it
 * separately they disagreed: the pill read `deviceState` alone and said Sleeping directly
 * above a line reading "board reported · woke 4:39:35 PM".
 *
 * THREE states, and no arithmetic anywhere in the file. `{feed}-status` publishes `awake`
 * when the board comes up and `sleeping` when it arms its alarm (docs/marquee-status.md);
 * device.js writes those into flow state; a board that has proved it reports and then goes
 * quiet is the third. Between the two reports the board is up — cooling down or flashing,
 * which cannot be told apart from here and does not need to be.
 *
 * There used to be a modelled cycle in here: a fitted panel-refresh time, a network
 * allowance, a frame minimum, a wake time rolled forward by whole periods, and a countdown
 * drawn from all of it. It was an attempt to answer from the outside a question the board
 * answers itself, and on real hardware it was not close — a 2.13" tri-color with BUSY
 * unwired spends a flat 40s in refresh and up to 180s more waiting for the frame to age,
 * against a 14s estimate. What replaced it is this file plus the board's own timestamps,
 * which A8 prints verbatim instead of counting down.
 *
 * It also holds the READING of the status feed — parseStatus() and readReport() at the
 * foot of the file. Same reasoning one level down: device.js polls that feed for the
 * active board and A1 reads it for every other one, and those two must not each grow
 * their own idea of what a payload means.
 *
 * Deliberately the bottom of the module graph — state.js and nothing else. It has to be
 * importable from router.js, device.js and the screens, and device.js already imports
 * router.js, so anything reaching back the other way would close a cycle.
 */

import { getState } from '../core/state.js';

/**
 * True while a reported wake has not been answered by a reported sleep.
 *
 * The bracket. The board is up, on its own account, and the only thing that closes this is
 * hearing from it again — not a timer, and not anything computed here.
 */
export function takeInFlight(st = getState()) {
  return !!st.lastWokeAt && (!st.lastSleptAt || st.lastSleptAt < st.lastWokeAt);
}

/**
 * 'offline' | 'redrawing' | 'sleeping' — the whole vocabulary.
 *
 * `offline` first: it is the only one that is a judgement about the board rather than a
 * report from it, and it outranks a stale report by definition.
 *
 * The bracket second, because `deviceState` is not always the board's word. The push used
 * to write 'asleep' the moment it published a window — and a window is a REQUEST, taking
 * effect at the board's next fetch. It no longer does that for a board that reports, but
 * the ordering here is what makes the rule hold regardless: a reported wake with no
 * reported sleep after it means the board is up, whatever anything else says.
 */
export function displayState(st = getState()) {
  if (st.deviceState === 'offline') return 'offline';
  if (takeInFlight(st)) return 'redrawing';
  return st.deviceState === 'asleep' ? 'sleeping' : 'redrawing';
}

/**
 * A `{group}.status` payload, parsed.
 *
 * Tolerant on purpose (docs/marquee-status.md): the value is a string, JSON in
 * practice, and a bare `awake` has to work. A non-object parse is promoted to
 * `{ state }` so both spellings land in one shape, and unknown keys are carried
 * rather than rejected — the contract is additive, so a reader that refused what it
 * did not recognise would break on the next field anyone adds.
 */
export function parseStatus(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' ? obj : { state: String(obj) };
  } catch {
    return { state: text };
  }
}

/**
 * What a batch of status data says the board is doing — as a flow patch, or null if
 * nothing in the batch is a recognisable report.
 *
 * PURE, and that is the whole point of it living here. device.js reads this feed for
 * the ACTIVE board through a polling watch that also promotes takes, ticks a countdown
 * and emits events; A1 reads the same feed for every OTHER board and may do none of
 * those things. Those are two different sets of consequences drawn from one reading,
 * and the reading is the part that must not fork — this file already exists because
 * `displayState()` forked once and the pill spent a release disagreeing with the bar.
 *
 * `data` is newest-first, as readFeedData() returns it. `fallbackSleepSecs` is what to
 * assume when the board sleeps without saying for how long — the caller's, because it
 * is a fact about a particular device: the watch passes the live form field, A1 passes
 * that display's own stored setting.
 *
 * Note the pair, not just the head. The head says what the board is doing now; the
 * newest report of EACH kind brackets the last take, which is what lets a caller tell
 * a board found asleep (having demonstrably woken, drawn and gone back down) from one
 * that has never woken at all.
 */
export function readReport(data, { fallbackSleepSecs = 0 } = {}) {
  if (!Array.isArray(data)) return null;
  const seen = data
    .map((d) => ({ at: Number.isFinite(d.createdAt) ? d.createdAt : Date.now(), s: parseStatus(d.value) }))
    .filter((x) => x.s && (x.s.state === 'awake' || x.s.state === 'sleeping'));
  if (!seen.length) return null;

  const newestAwake = seen.find((x) => x.s.state === 'awake');
  const newestSleep = seen.find((x) => x.s.state === 'sleeping');
  const head = seen[0];

  const out = {
    reportedAt: head.at,
    lastWokeAt: newestAwake ? newestAwake.at : null,
    lastSleptAt: newestSleep ? newestSleep.at : null,
  };

  if (head.s.state === 'awake') {
    return { ...out, deviceState: 'online-awake', wakesAt: null, wakeSource: null, sleepSeconds: null };
  }

  // Asleep. `sleep_time` absent means "the board didn't say" and falls back; it must
  // never be READ as 0, which is a legal value meaning "do not sleep on the timer"
  // (docs/marquee-sleep.md) — hence Number.isFinite rather than a truthiness check.
  const wakeSource = head.s.alarm_type || 'timer';
  const secs = Number.isFinite(head.s.sleep_time) ? head.s.sleep_time : fallbackSleepSecs;
  // A pin-only alarm has no wake TIME — it sleeps until a finger lands on the button —
  // so there is no `wakesAt` to offer and a caller must not invent one.
  if (wakeSource === 'pin') {
    return { ...out, deviceState: 'asleep', wakesAt: null, wakeSource, sleepSeconds: null };
  }
  return { ...out, deviceState: 'asleep', wakesAt: head.at + secs * 1000, wakeSource, sleepSeconds: secs };
}

// ---------- when silence becomes a verdict -----------------------------------

/**
 * How long a board that HAS reported gets to say something before it is called offline.
 *
 * A watchdog, not a model, and generously past the worst take this hardware can produce
 * — a 2.13" tri-color with BUSY unwired spends 83s cooling down and 40s drawing
 * (docs/marquee-status.md). Here rather than in device.js because the poll deadline and
 * A1's read of a stale report are the same judgement made from two places, and the whole
 * reason this file exists is that the same judgement made from two places drifts.
 */
export const TAKE_CEILING_MS = 300000;

/** Slack on top of the ceiling: a slow WiFi associate or one retry has to fit inside it. */
export const REPORT_GRACE_MS = 60000;

/**
 * Has the board this report came from gone quiet past the point of doubt?
 *
 * Only a board that HAS reported can be judged for not reporting — which is implicit
 * here, since there is no report to pass otherwise. The clock runs from when the board
 * was next due to speak: its wake time if it told us one, or the wake it never closed.
 */
export function reportIsOverdue(r, now = Date.now()) {
  if (!r) return false;
  // A pin-only alarm may not fire for days. There is nothing to be late for.
  if (r.wakeSource === 'pin') return false;
  const due = r.deviceState === 'asleep' ? r.wakesAt : r.lastWokeAt;
  if (!Number.isFinite(due)) return false;
  return now > due + TAKE_CEILING_MS + REPORT_GRACE_MS;
}
