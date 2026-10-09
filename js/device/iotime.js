/**
 * The Adafruit IO Time API — the time behind every "Date & time" prop.
 *
 * Reads `/api/v2/time/millis`, which is unauthenticated and CORS-open. The richer
 * `/integrations/time/*` endpoints (strftime, the zone list, the IP-guessed zone) would
 * have been the natural fit, but their successful responses are pinned to the
 * io.adafruit.com origin and a browser anywhere else drops them — see core/timefmt.js,
 * which does the formatting instead.
 *
 * Imports nothing that touches the DOM, so the live test can drive it from node.
 */

import { ioHost } from '../core/api.js';
import { strftime, browserTz, supportedTimezones, ioMillisUrl } from '../core/timefmt.js';

/**
 * IO's current time, epoch milliseconds. Resolves to a number, or null on any failure —
 * never throws, and null is "unknown": the same contract as readFeedValue(), so a failed
 * read leaves every element as it was.
 */
export async function readIoMillis() {
  console.log(`[io] read    time/millis @ ${ioHost()}`);
  try {
    const res = await fetch(ioMillisUrl(ioHost()));
    if (!res.ok) return null;
    const ms = Number((await res.text()).trim());
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  } catch { return null; }
}

/** One prop's text: IO's time in `fmt` and `tz`, or null when either half fails. */
export async function readIoTime({ fmt, tz = '' } = {}) {
  const ms = await readIoMillis();
  return ms === null ? null : strftime(ms, fmt, tz);
}

let zonesCache = null;

/**
 * `{ timezone, zones }` — what "Auto" resolves to (this browser's zone) and every zone it
 * can render. Synchronous and request-free: the browser is the authority on what it can
 * format, now that the formatting happens here.
 */
export function listTimezones() {
  if (!zonesCache) zonesCache = { timezone: browserTz(), zones: supportedTimezones() };
  return zonesCache;
}
