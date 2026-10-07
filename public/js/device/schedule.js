/**
 * A display's sleep schedule — what goes onto `{group}.sleep`, and how to say what a board
 * is sleeping on from whatever evidence there is.
 *
 * Pure, and next to cycle.js for the same reason cycle.js is pure: the payload is written
 * from two places (device.js's push for the ACTIVE display, an A1 tile for any display) and
 * read back by A1 for every display, and a second spelling of either half is how the label
 * a user sees and the value a board gets drift apart. Nothing here touches the DOM or
 * Adafruit IO; the callers do the reads and hand the results in.
 *
 * See docs/marquee-sleep.md for the payload, and docs/marquee-status.md for the report it
 * is compared against.
 */

import { parseStatus } from './cycle.js';

/**
 * The line between light and deep sleep, in seconds.
 *
 * Sleep mode is DERIVED from the interval rather than picked, because the interval
 * is the only thing the answer depends on — and two authors for one decision is
 * how the editor and the board end up disagreeing (a 15-second refresh set to Deep
 * paid a full boot + re-provision + redraw every fifteen seconds, and nothing said
 * so). Three tiers, which collapse into one comparison:
 *
 *   T < 60s     light. Under the MQTT keepalive the socket survives the nap
 *               outright, so waking costs nothing at all.
 *   60s-300s    light. The socket is gone and the reconnect is MQTT-only — still
 *               far cheaper than the boot + re-provision + EPD redraw a deep wake
 *               pays for.
 *   T >= 300s   deep. Past here the boot stops dominating, and holding RAM and a
 *               radio for five minutes to save one boot is the worse trade.
 *
 * The first two tiers give the same answer, so there is one threshold and it is
 * this one. The 60s tier is the reasoning, not configuration: nothing in this repo
 * reads a device keepalive.
 */
export const DEEP_SLEEP_THRESHOLD_SECS = 300;

/** The sleep mode for a sleep of `secs`, spelled the way the sleep feed carries it
 *  (docs/marquee-sleep.md). The interval picker, the A1 tiles and the published payload
 *  all read this, so the label a user sees and the value the board gets cannot drift. */
export function sleepModeFor(secs) {
  return secs >= DEEP_SLEEP_THRESHOLD_SECS ? 'deep' : 'light';
}

/**
 * The sleep window as it goes onto the feed. Three fields and no more.
 *
 * `alarm_type` is always "timer": the editor no longer offers a wake-on-button choice,
 * and the interval is the only sleep control left. The field stays in the payload so the
 * feed keeps one shape for any consumer already parsing it.
 */
export function sleepPayloadFor(secs) {
  const sleepTime = Math.max(0, Math.floor(Number(secs)) || 0);
  return { alarm_type: 'timer', sleep_mode: sleepModeFor(sleepTime), sleep_time: sleepTime };
}

/**
 * A `{group}.sleep` value, read back: `{ secs, alarmType, mode }`, or null.
 *
 * Tolerant the way the firmware is asked to be (docs/marquee-sleep.md#fallbacks): a value
 * that will not parse, or carries no usable `sleep_time`, is "nothing published" rather
 * than an error. `sleep_mode` is taken as written when it is one of the two spellings and
 * derived otherwise, so a hand-written datum still produces a sensible label.
 */
export function parseSleepPayload(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let obj;
  try { obj = JSON.parse(value); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const secs = Number(obj.sleep_time);
  if (!Number.isFinite(secs) || secs < 0) return null;
  const mode = obj.sleep_mode === 'light' || obj.sleep_mode === 'deep' ? obj.sleep_mode : sleepModeFor(secs);
  return { secs, alarmType: typeof obj.alarm_type === 'string' && obj.alarm_type ? obj.alarm_type : 'timer', mode };
}

/**
 * What the BOARD last said it slept on, from a batch of `{group}.status` data
 * (newest-first, as readFeedData() returns it): `{ secs, alarmType, at }`, or null.
 *
 * Deliberately not readReport(). That one substitutes a fallback interval when a report
 * leaves `sleep_time` out, which is right for a wake-time estimate and wrong here: this is
 * the board's own word or nothing, because it is what a schedule gets compared AGAINST.
 * A pin alarm counts without a `sleep_time` — it has no interval to report.
 */
export function reportedSleep(data) {
  if (!Array.isArray(data)) return null;
  for (const d of data) {
    const s = parseStatus(d?.value);
    if (!s || s.state !== 'sleeping') continue;
    const alarmType = typeof s.alarm_type === 'string' && s.alarm_type ? s.alarm_type : 'timer';
    const secs = Number.isFinite(s.sleep_time) ? s.sleep_time : null;
    if (secs === null && alarmType !== 'pin') continue;
    return { secs, alarmType, at: Number.isFinite(d.createdAt) ? d.createdAt : null };
  }
  return null;
}

/**
 * Which schedule to show for a display, from three sources in order of authority:
 *
 *   feed    the newest `{group}.sleep` payload — the schedule as SET, which is what the
 *           board is asked to follow from its next wake. `{ secs, alarmType, mode, at }`.
 *   board   what the board last reported on `{group}.status` — what it actually armed.
 *           Only consulted when nothing has been published.
 *   local   this display's own `sleepDuration` setting — what the next push would send.
 *           Last, because it is a fact about this browser and not about the board.
 *
 * The feed outranks the board because a change has to be visible the moment it is made:
 * the board keeps reporting the old interval until it next wakes and reads the feed, and a
 * tile that went on showing that would look like the change had not taken.
 *
 * `boardSecs` is the one-line diff docs/marquee-sleep.md promises: set when the board
 * reported a sleep AFTER the schedule was published and it slept on something else — a
 * board ignoring the feed, or running firmware that does not read it yet. A report from
 * before the publish is expected to differ and is not flagged.
 */
export function pickSleepSchedule({ feed = null, board = null, localSecs = null } = {}) {
  if (feed) {
    const differs = board && board.alarmType !== 'pin' && Number.isFinite(board.secs)
      && Number.isFinite(board.at) && Number.isFinite(feed.at)
      && board.at > feed.at && board.secs !== feed.secs;
    return {
      source: 'feed', secs: feed.secs, alarmType: feed.alarmType || 'timer',
      mode: feed.mode || sleepModeFor(feed.secs), boardSecs: differs ? board.secs : null,
    };
  }
  if (board) {
    const secs = Number.isFinite(board.secs) ? board.secs : null;
    return {
      source: 'board', secs, alarmType: board.alarmType || 'timer',
      mode: secs === null ? null : sleepModeFor(secs), boardSecs: null,
    };
  }
  const secs = Math.max(0, Math.floor(Number(localSecs)) || 0);
  return { source: 'local', secs, alarmType: 'timer', mode: sleepModeFor(secs), boardSecs: null };
}

/**
 * A sleep length the way a tile has room for it: "45 s", "15 min", "1 h", "1.5 h".
 *
 * Shorter than util.js#fmtInterval on purpose — that one is prose ("sleeping a total of
 * 15 minutes"), and this sits in a single line beside the mode and the alarm.
 */
export function fmtSleepShort(secs) {
  const s = Math.max(0, Math.floor(Number(secs)) || 0);
  if (s < 60) return `${s} s`;
  if (s < 3600) {
    const m = s / 60;
    return `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
  }
  const h = s / 3600;
  return `${Number.isInteger(h) ? h : Number(h.toFixed(1))} h`;
}

/**
 * The schedule in one line — "Sleeps 15 min · timer · deep sleep".
 *
 * `0` is a legal `sleep_time` meaning "do not sleep on the timer" (docs/marquee-sleep.md),
 * so it is said as that rather than as "Sleeps 0 s". A pin alarm has no interval at all.
 */
export function scheduleLine(s) {
  if (!s) return '';
  if (s.alarmType === 'pin') return 'Sleeps until the button is pressed · pin';
  if (!Number.isFinite(s.secs)) return `Sleeps · ${s.alarmType || 'timer'}`;
  if (s.secs === 0) return 'Timer sleep off';
  return `Sleeps ${fmtSleepShort(s.secs)} · ${s.alarmType || 'timer'} · ${s.mode || sleepModeFor(s.secs)} sleep`;
}
