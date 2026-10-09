/**
 * The "Date & time" prop's formats, and how they are rendered.
 *
 * The TIME comes from Adafruit IO (`/api/v2/time/millis`, see device/iotime.js); the
 * FORMATTING happens here, in the browser. IO's own `/integrations/time/strftime` would
 * do both, but a successful authenticated response from it carries
 * `Access-Control-Allow-Origin: https://io.adafruit.com`, so no browser on any other
 * origin can read it — the editor on localhost and on Pages included. The bare /time
 * endpoints are unauthenticated and answer `*`.
 *
 * The formats are still written as strftime strings, the vocabulary CircuitPython users
 * know from the IO docs, and rendered with English names as C-locale strftime would.
 * strftime() below implements exactly the directives the presets use and refuses the
 * rest, so a preset can't quietly gain one this file renders as itself.
 *
 * Presets only, on purpose. A layout sized around "12:00 PM" that suddenly reads
 * "Wednesday, September 30" overflows the panel. Every format below has an `example` of
 * roughly its real width, which is what the element shows before the first read.
 *
 * Pure — no DOM, no Konva, no fetch — so `node --test` can reach it, the same reason
 * samples.js and canvasimport.js are kept that way. Intl is part of the language.
 */

export const TIME_PRESETS = [
  { id: 'time',    label: 'Time',              fmt: '%l:%M %p',              example: '12:00 PM' },
  { id: 'time24',  label: 'Time (24h)',        fmt: '%H:%M',                 example: '12:00' },
  { id: 'timesec', label: 'Time with seconds', fmt: '%I:%M:%S %p',           example: '12:00:00 PM' },
  { id: 'date',    label: 'Date',              fmt: '%b %e, %Y',             example: 'Dec 6, 2019' },
  { id: 'iso',     label: 'ISO date',          fmt: '%Y-%m-%d',              example: '2019-12-06' },
  { id: 'weekday', label: 'Weekday',           fmt: '%A',                    example: 'Friday' },
  { id: 'datetime', label: 'Date + time',      fmt: '%a %b %e, %l:%M %p',    example: 'Fri Dec 6, 12:00 AM' },
  { id: 'updated', label: 'Last Updated (time)', fmt: 'Last Updated: %l:%M %p', example: 'Last Updated: 12:00 PM' },
  { id: 'updatedfull', label: 'Last Updated (date + time)', fmt: 'Last Updated: %Y-%m-%d %H:%M',
    example: 'Last Updated: 2019-12-06 12:00' },
];

export const DEFAULT_PRESET = TIME_PRESETS[0];

/**
 * The preset a format belongs to — or the default when it belongs to none. A hand-edited
 * or imported document can carry any string at all in `timeFmt`, and since there is no
 * free-form format, the only safe reading of an unknown one is the default.
 */
export function presetForFmt(fmt) {
  return TIME_PRESETS.find((p) => p.fmt === fmt) || DEFAULT_PRESET;
}

/** What the element shows before IO has answered: never empty, see addLabel's em dash. */
export function placeholderText(fmt) {
  return presetForFmt(fmt).example;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const pad2 = (v) => String(v).padStart(2, '0');

/** Is `tz` a zone this browser can render? '' (Auto) always is. */
export function isValidTz(tz) {
  if (!tz) return true;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** The zone "Auto" means: this browser's own. */
export function browserTz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** Every zone this browser can render, sorted; UTC is always included. */
export function supportedTimezones() {
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { /* older engine: Auto + UTC only */ }
  return [...new Set([...zones, 'UTC'])].sort();
}

/**
 * The wall-clock fields of instant `ms` in zone `tz` ('' = this browser's), or null when
 * the zone is unknown. One formatToParts call, numeric only: names come from the English
 * tables above, so the output doesn't change with the browser's language.
 */
function wallClock(ms, tz) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || undefined, hourCycle: 'h23', weekday: 'long',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(new Date(ms));
  } catch { return null; }
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    year: Number(get('year')), month: Number(get('month')), day: Number(get('day')),
    // Some engines spell midnight "24" under h23.
    hour: Number(get('hour')) % 24, minute: Number(get('minute')), second: Number(get('second')),
    weekday: get('weekday'),
  };
}

/**
 * Format instant `ms` (epoch milliseconds) with strftime string `fmt` in zone `tz`.
 * Returns null for a missing/non-string format, an unknown zone or a directive this file
 * doesn't implement — the same "unknown, keep what you had" null every reader in the
 * refresh path returns.
 *
 * %l and %e are UNPADDED here, where C pads them with a space (" 9:05", "Dec  6"): on a
 * left-aligned panel label the space reads as a stray indent.
 */
export function strftime(ms, fmt, tz = '') {
  if (!Number.isFinite(ms) || typeof fmt !== 'string') return null;
  const c = wallClock(ms, tz);
  if (!c) return null;
  const h12 = c.hour % 12 || 12;
  const map = {
    Y: String(c.year), m: pad2(c.month), d: pad2(c.day), e: String(c.day),
    H: pad2(c.hour), I: pad2(h12), l: String(h12), M: pad2(c.minute), S: pad2(c.second),
    p: c.hour < 12 ? 'AM' : 'PM',
    A: c.weekday, a: c.weekday.slice(0, 3),
    B: MONTHS[c.month - 1], b: MONTHS[c.month - 1].slice(0, 3),
    '%': '%',
  };
  let bad = false;
  const out = fmt.replace(/%(.)/g, (_, k) => {
    if (k in map) return map[k];
    bad = true;
    return '';
  });
  return bad ? null : out;
}

/** The directives strftime() implements — exported for the tests. */
export const STRFTIME_DIRECTIVES = ['Y', 'm', 'd', 'e', 'H', 'I', 'l', 'M', 'S', 'p', 'A', 'a', 'B', 'b', '%'];

/**
 * Every attr the element carries, with defaults applied and types cleaned up. Shared by
 * addDatetime() and serialize() so the two cannot disagree on what a datetime is — the
 * factory IS the deserializer here, as for every other etype (see doc.js).
 *
 * `timeValue` stays null when unread, never '' — null is "unknown", exactly as
 * readFeedValue() means it. `width` is undefined when the box auto-sizes to its text.
 */
export function normalizeDatetimeAttrs(a = {}) {
  const width = Number(a.width);
  const fontSize = Number(a.fontSize);
  return {
    timeFmt: presetForFmt(a.timeFmt).fmt,
    timeTz: typeof a.timeTz === 'string' ? a.timeTz.trim() : '',
    timeValue: a.timeValue === null || a.timeValue === undefined || a.timeValue === ''
      ? null : String(a.timeValue),
    fill: typeof a.fill === 'string' && a.fill ? a.fill : undefined,
    fontSize: Number.isFinite(fontSize) && fontSize >= 4 ? Math.round(fontSize) : 20,
    // Any family name the font menu can produce: a generic, a bitmap font's id or a web
    // font's family (pixelfont.js, webfont.js). `fontUrl` is where a web font came from.
    fontFamily: typeof a.fontFamily === 'string' && a.fontFamily.trim() ? a.fontFamily.trim() : 'monospace',
    fontUrl: typeof a.fontUrl === 'string' ? a.fontUrl.trim() : '',
    align: ['left', 'center', 'right'].includes(a.align) ? a.align : 'left',
    width: Number.isFinite(width) && width >= 8 ? Math.round(width) : undefined,
  };
}

/**
 * The IO endpoint the time comes from. Unauthenticated, so it needs no X-AIO-Key header
 * (and no CORS preflight), and it answers `Access-Control-Allow-Origin: *`.
 */
export function ioMillisUrl(host) {
  return `https://${host}/api/v2/time/millis`;
}
