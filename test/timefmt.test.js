/**
 * The "Date & time" prop — public/js/core/timefmt.js.
 *
 * Offline: every preset rendered at fixed instants in several zones, every directive
 * strftime() implements, and every widget property through the normalizer that both
 * addDatetime() and serialize() run, so a save and a load can't disagree.
 * test/iotime.live.test.js asks IO itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIME_PRESETS, DEFAULT_PRESET, presetForFmt, placeholderText, normalizeDatetimeAttrs,
  strftime, STRFTIME_DIRECTIVES, isValidTz, browserTz, supportedTimezones, ioMillisUrl,
} from '../public/js/core/timefmt.js';
import { stripSamples, sameDesign } from '../public/js/core/samples.js';
import { KNOWN_ETYPES } from '../public/js/core/canvasimport.js';

const HOST = 'io.adafruit.com';

test('every preset is complete and unique', () => {
  const ids = new Set(), fmts = new Set();
  for (const p of TIME_PRESETS) {
    assert.ok(p.id && p.label && p.fmt && p.example, JSON.stringify(p));
    assert.ok(p.fmt.includes('%'), `${p.id}: a format with no directive is a constant`);
    ids.add(p.id); fmts.add(p.fmt);
  }
  assert.equal(ids.size, TIME_PRESETS.length, 'preset ids are unique');
  assert.equal(fmts.size, TIME_PRESETS.length, 'preset formats are unique');
  assert.equal(DEFAULT_PRESET.id, 'time');
});

test('two Last Updated presets: time, and ISO date + time', () => {
  const time = TIME_PRESETS.find((x) => x.id === 'updated');
  const full = TIME_PRESETS.find((x) => x.id === 'updatedfull');
  assert.equal(time.label, 'Last Updated (time)');
  assert.equal(full.label, 'Last Updated (date + time)');
  for (const p of [time, full]) {
    assert.ok(p.fmt.startsWith('Last Updated: '));
    assert.ok(p.example.startsWith('Last Updated: '));
  }
  assert.match(full.example, /^Last Updated: \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('every preset round-trips through presetForFmt and has a placeholder', () => {
  for (const p of TIME_PRESETS) {
    assert.equal(presetForFmt(p.fmt), p, p.id);
    assert.equal(placeholderText(p.fmt), p.example, p.id);
    assert.ok(placeholderText(p.fmt).length > 0, p.id);
  }
});

// Friday 6 Dec 2019, midnight UTC — a Thursday evening in New York, Friday morning in Tokyo.
const MIDNIGHT = Date.UTC(2019, 11, 6, 0, 0, 0);
// Friday 2 Oct 2026, 21:05:07 UTC — PM, single-digit hour on the 12h clock.
const EVENING = Date.UTC(2026, 9, 2, 21, 5, 7);

const EXPECT = {
  [MIDNIGHT]: {
    UTC: { time: '12:00 AM', time24: '00:00', timesec: '12:00:00 AM', date: 'Dec 6, 2019',
      iso: '2019-12-06', weekday: 'Friday', datetime: 'Fri Dec 6, 12:00 AM',
      updated: 'Last Updated: 12:00 AM', updatedfull: 'Last Updated: 2019-12-06 00:00' },
    'America/New_York': { time: '7:00 PM', time24: '19:00', timesec: '07:00:00 PM',
      date: 'Dec 5, 2019', iso: '2019-12-05', weekday: 'Thursday',
      datetime: 'Thu Dec 5, 7:00 PM', updated: 'Last Updated: 7:00 PM',
      updatedfull: 'Last Updated: 2019-12-05 19:00' },
    'Asia/Tokyo': { time: '9:00 AM', time24: '09:00', timesec: '09:00:00 AM',
      date: 'Dec 6, 2019', iso: '2019-12-06', weekday: 'Friday',
      datetime: 'Fri Dec 6, 9:00 AM', updated: 'Last Updated: 9:00 AM',
      updatedfull: 'Last Updated: 2019-12-06 09:00' },
  },
  [EVENING]: {
    UTC: { time: '9:05 PM', time24: '21:05', timesec: '09:05:07 PM', date: 'Oct 2, 2026',
      iso: '2026-10-02', weekday: 'Friday', datetime: 'Fri Oct 2, 9:05 PM',
      updated: 'Last Updated: 9:05 PM', updatedfull: 'Last Updated: 2026-10-02 21:05' },
    'Asia/Kolkata': { time: '2:35 AM', time24: '02:35', timesec: '02:35:07 AM',
      date: 'Oct 3, 2026', iso: '2026-10-03', weekday: 'Saturday',
      datetime: 'Sat Oct 3, 2:35 AM', updated: 'Last Updated: 2:35 AM',
      updatedfull: 'Last Updated: 2026-10-03 02:35' },
  },
};

test('every preset renders correctly at fixed instants in several zones', () => {
  for (const [ms, zones] of Object.entries(EXPECT)) {
    for (const [tz, want] of Object.entries(zones)) {
      for (const p of TIME_PRESETS) {
        assert.equal(strftime(Number(ms), p.fmt, tz), want[p.id], `${p.id} at ${ms} in ${tz}`);
      }
    }
  }
});

test('every preset uses only directives strftime implements', () => {
  for (const p of TIME_PRESETS) {
    for (const [, k] of p.fmt.matchAll(/%(.)/g)) assert.ok(STRFTIME_DIRECTIVES.includes(k), `${p.id}: %${k}`);
    assert.notEqual(strftime(EVENING, p.fmt, 'UTC'), null, p.id);
  }
});

test('every implemented directive, one at a time', () => {
  const want = { Y: '2026', m: '10', d: '02', e: '2', H: '21', I: '09', l: '9', M: '05', S: '07',
    p: 'PM', A: 'Friday', a: 'Fri', B: 'October', b: 'Oct', '%': '%' };
  assert.deepEqual(Object.keys(want).sort(), [...STRFTIME_DIRECTIVES].sort());
  for (const [k, v] of Object.entries(want)) assert.equal(strftime(EVENING, `%${k}`, 'UTC'), v, `%${k}`);
  // Noon and midnight on the 12h clock.
  assert.equal(strftime(Date.UTC(2026, 0, 1, 12), '%l %p', 'UTC'), '12 PM');
  assert.equal(strftime(Date.UTC(2026, 0, 1, 0), '%I %p %H', 'UTC'), '12 AM 00');
});

test('auto ("") renders in the browser zone', () => {
  assert.equal(strftime(EVENING, '%Y-%m-%d %H:%M', ''), strftime(EVENING, '%Y-%m-%d %H:%M', browserTz()));
});

test('unknown directives, unknown zones and bad instants are null, never a guess', () => {
  assert.equal(strftime(EVENING, '%Q', 'UTC'), null);
  assert.equal(strftime(EVENING, '%H', 'Not/AZone'), null);
  assert.equal(strftime(NaN, '%H', 'UTC'), null);
  assert.equal(strftime(undefined, '%H', 'UTC'), null);
});

test('a missing or non-string format is null, not the text "undefined"', () => {
  assert.equal(strftime(EVENING, undefined, 'UTC'), null);
  assert.equal(strftime(EVENING, null, 'UTC'), null);
  assert.equal(strftime(EVENING, 42, 'UTC'), null);
});

test('zones: validity and the list', () => {
  assert.equal(isValidTz(''), true);
  assert.equal(isValidTz('Asia/Tokyo'), true);
  assert.equal(isValidTz('Not/AZone'), false);
  const zones = supportedTimezones();
  assert.ok(zones.includes('UTC') && zones.includes('America/New_York'));
  assert.deepEqual(zones, [...zones].sort());
  assert.ok(zones.every(isValidTz));
});

test('the time comes from the open /time/millis endpoint', () => {
  assert.equal(ioMillisUrl('io.adafruit.com'), 'https://io.adafruit.com/api/v2/time/millis');
});

test('an unknown format normalizes to the default preset — there is no custom format', () => {
  for (const fmt of [undefined, null, '', '%A %d', 'hello', 42])
    assert.equal(normalizeDatetimeAttrs({ timeFmt: fmt }).timeFmt, DEFAULT_PRESET.fmt, String(fmt));
});

test('defaults from an empty object', () => {
  assert.deepEqual(normalizeDatetimeAttrs({}), {
    timeFmt: DEFAULT_PRESET.fmt, timeTz: '', timeValue: null, fill: undefined,
    fontSize: 20, fontFamily: 'monospace', fontUrl: '', align: 'left', width: undefined,
  });
  assert.deepEqual(normalizeDatetimeAttrs(), normalizeDatetimeAttrs({}));
});

test('every widget property survives a save/load round trip', () => {
  const variants = [];
  for (const p of TIME_PRESETS)
    for (const timeTz of ['', 'UTC', 'America/New_York'])
      for (const fontFamily of ['monospace', 'sans-serif', 'serif'])
        for (const align of ['left', 'center', 'right'])
          for (const width of [undefined, 120])
            variants.push({ timeFmt: p.fmt, timeTz, fontFamily, align, width,
              timeValue: p.example, fill: '#000000', fontSize: 14 });
  for (const v of variants) {
    const saved = normalizeDatetimeAttrs(v);
    // JSON is the wire format to localStorage and IO; undefined keys vanish in it.
    const loaded = normalizeDatetimeAttrs(JSON.parse(JSON.stringify(saved)));
    assert.deepEqual(loaded, saved, JSON.stringify(v));
    for (const k of Object.keys(v)) assert.deepEqual(saved[k], v[k], `${k} in ${JSON.stringify(v)}`);
  }
});

test('timeValue: unread stays null, never "" or 0', () => {
  assert.equal(normalizeDatetimeAttrs({ timeValue: null }).timeValue, null);
  assert.equal(normalizeDatetimeAttrs({ timeValue: '' }).timeValue, null);
  assert.equal(normalizeDatetimeAttrs({ timeValue: 0 }).timeValue, '0');
});

test('bad style values fall back rather than reaching Konva', () => {
  const a = normalizeDatetimeAttrs({ fontSize: 2, fontFamily: '  ', fontUrl: 7, align: 'justify', width: 3, timeTz: 7 });
  assert.equal(a.fontSize, 20);
  assert.equal(a.fontFamily, 'monospace');
  assert.equal(a.fontUrl, '');
  assert.equal(a.align, 'left');
  // Any family name is allowed: a bitmap font's id, or a web font's family with its URL.
  const web = normalizeDatetimeAttrs({ fontFamily: 'Press Start 2P', fontUrl: ' https://x.y/f.woff2 ' });
  assert.equal(web.fontFamily, 'Press Start 2P');
  assert.equal(web.fontUrl, 'https://x.y/f.woff2');
  assert.equal(normalizeDatetimeAttrs({ fontFamily: 'tom-thumb' }).fontFamily, 'tom-thumb');
  assert.equal(a.width, undefined);
  assert.equal(a.timeTz, '');
  assert.equal(normalizeDatetimeAttrs({ fontSize: 33.6, width: 99.4 }).fontSize, 34);
  assert.equal(normalizeDatetimeAttrs({ fontSize: 33.6, width: 99.4 }).width, 99);
});

test('a new time is a reading, not an edit; a new format or zone is an edit', () => {
  const doc = (el) => ({ version: 1, display: {}, elements: [{ etype: 'datetime', x: 0, y: 0, ...el }] });
  const base = normalizeDatetimeAttrs({ timeFmt: '%H:%M', timeTz: 'UTC' });
  assert.equal(sameDesign(doc({ ...base, timeValue: '10:00' }), doc({ ...base, timeValue: '10:05' })), true);
  assert.equal(sameDesign(doc(base), doc({ ...base, timeTz: 'Asia/Tokyo' })), false);
  assert.equal(sameDesign(doc(base), doc({ ...base, timeFmt: '%A' })), false);
  assert.equal('timeValue' in stripSamples({ etype: 'datetime', ...base, timeValue: 'x' }), false);
});

test('a datetime in an imported canvas.json is loaded, not skipped', () => {
  assert.ok(KNOWN_ETYPES.has('datetime'));
});
