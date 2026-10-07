/**
 * The sleep schedule — public/js/device/schedule.js.
 *
 * The payload a push and an A1 tile both publish to {group}.sleep, reading it back, the
 * board's own word on what it armed, and which of those an A1 tile shows. See
 * docs/marquee-sleep.md for the contract these pin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEEP_SLEEP_THRESHOLD_SECS, sleepModeFor, sleepPayloadFor, parseSleepPayload, reportedSleep,
  pickSleepSchedule, fmtSleepShort, scheduleLine,
} from '../public/js/device/schedule.js';

test('sleep mode flips to deep at the threshold, and only there', () => {
  assert.equal(DEEP_SLEEP_THRESHOLD_SECS, 300);
  assert.equal(sleepModeFor(0), 'light');
  assert.equal(sleepModeFor(299), 'light');
  assert.equal(sleepModeFor(300), 'deep');
  assert.equal(sleepModeFor(3600), 'deep');
});

test('the payload is the three documented fields, with the mode derived', () => {
  assert.deepEqual(sleepPayloadFor(900), { alarm_type: 'timer', sleep_mode: 'deep', sleep_time: 900 });
  assert.deepEqual(sleepPayloadFor(120), { alarm_type: 'timer', sleep_mode: 'light', sleep_time: 120 });
  // Whatever arrives from a form field comes out an integer, never negative or NaN.
  assert.deepEqual(sleepPayloadFor('600'), { alarm_type: 'timer', sleep_mode: 'deep', sleep_time: 600 });
  assert.equal(sleepPayloadFor(-5).sleep_time, 0);
  assert.equal(sleepPayloadFor('junk').sleep_time, 0);
});

test('a published payload reads back as the schedule it was', () => {
  for (const secs of [0, 60, 300, 900, 3600]) {
    const p = parseSleepPayload(JSON.stringify(sleepPayloadFor(secs)));
    assert.deepEqual(p, { secs, alarmType: 'timer', mode: sleepModeFor(secs) });
  }
});

test('an unreadable or partial sleep value is "nothing published", not an error', () => {
  for (const v of [null, undefined, '', '   ', 'not json', '42', '"timer"', 'null', '[]',
    '{}', '{"sleep_time": "soon"}', '{"sleep_time": -1}', '{"alarm_type": "timer"}']) {
    assert.equal(parseSleepPayload(v), null, String(v));
  }
});

test('a hand-written payload gets a derived mode and a default alarm', () => {
  assert.deepEqual(parseSleepPayload('{"sleep_time": 600}'), { secs: 600, alarmType: 'timer', mode: 'deep' });
  assert.deepEqual(parseSleepPayload('{"sleep_time": 600, "sleep_mode": "hibernate"}'),
    { secs: 600, alarmType: 'timer', mode: 'deep' });
  // A mode written explicitly is reported as written, even if it disagrees with the table.
  assert.equal(parseSleepPayload('{"sleep_time": 600, "sleep_mode": "light"}').mode, 'light');
});

const datum = (value, createdAt) => ({ id: String(createdAt), value, createdAt });

test('the board report is its own word or nothing — no fallback interval', () => {
  const data = [
    datum('{"state": "awake"}', 5000),
    datum('{"state": "sleeping"}', 4000),                                   // no sleep_time
    datum('{"state": "sleeping", "sleep_time": 120, "alarm_type": "timer"}', 3000),
  ];
  assert.deepEqual(reportedSleep(data), { secs: 120, alarmType: 'timer', at: 3000 });
  assert.equal(reportedSleep([datum('awake', 1), datum('{"state":"sleeping"}', 2)]), null);
  assert.equal(reportedSleep(null), null);
  assert.equal(reportedSleep([]), null);
});

test('a pin alarm counts without an interval', () => {
  assert.deepEqual(reportedSleep([datum('{"state": "sleeping", "alarm_type": "pin"}', 7)]),
    { secs: null, alarmType: 'pin', at: 7 });
});

test('the published schedule outranks the board and the local setting', () => {
  const feed = { secs: 900, alarmType: 'timer', mode: 'deep', at: 1000 };
  const board = { secs: 300, alarmType: 'timer', at: 500 };
  const s = pickSleepSchedule({ feed, board, localSecs: 60 });
  assert.equal(s.source, 'feed');
  assert.equal(s.secs, 900);
  // The report predates the publish, so differing is expected and not flagged.
  assert.equal(s.boardSecs, null);
});

test('a board that slept on something else AFTER the publish is flagged', () => {
  const feed = { secs: 900, alarmType: 'timer', mode: 'deep', at: 1000 };
  assert.equal(pickSleepSchedule({ feed, board: { secs: 300, alarmType: 'timer', at: 2000 } }).boardSecs, 300);
  // Agreeing, or a pin alarm with nothing to compare, is not a diff.
  assert.equal(pickSleepSchedule({ feed, board: { secs: 900, alarmType: 'timer', at: 2000 } }).boardSecs, null);
  assert.equal(pickSleepSchedule({ feed, board: { secs: null, alarmType: 'pin', at: 2000 } }).boardSecs, null);
});

test('with nothing published, the board report, then the local setting', () => {
  const b = pickSleepSchedule({ board: { secs: 120, alarmType: 'timer', at: 1 }, localSecs: 600 });
  assert.deepEqual(b, { source: 'board', secs: 120, alarmType: 'timer', mode: 'light', boardSecs: null });
  const l = pickSleepSchedule({ localSecs: '600' });
  assert.deepEqual(l, { source: 'local', secs: 600, alarmType: 'timer', mode: 'deep', boardSecs: null });
  assert.equal(pickSleepSchedule({}).secs, 0);
});

test('short durations', () => {
  assert.equal(fmtSleepShort(45), '45 s');
  assert.equal(fmtSleepShort(60), '1 min');
  assert.equal(fmtSleepShort(90), '1.5 min');
  assert.equal(fmtSleepShort(900), '15 min');
  assert.equal(fmtSleepShort(3600), '1 h');
  assert.equal(fmtSleepShort(5400), '1.5 h');
});

test('the line a tile shows', () => {
  assert.equal(scheduleLine(pickSleepSchedule({ localSecs: 900 })), 'Sleeps 15 min · timer · deep sleep');
  assert.equal(scheduleLine(pickSleepSchedule({ localSecs: 120 })), 'Sleeps 2 min · timer · light sleep');
  assert.equal(scheduleLine(pickSleepSchedule({ localSecs: 0 })), 'Timer sleep off');
  assert.equal(scheduleLine(pickSleepSchedule({ board: { secs: null, alarmType: 'pin', at: 1 } })),
    'Sleeps until the button is pressed · pin');
  assert.equal(scheduleLine(null), '');
});
