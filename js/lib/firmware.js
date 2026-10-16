/**
 * The latest firmware release: its manifest, and a board's merged image from it, size- and
 * sha256-checked. See device/firmware.js for where releases live and why (the `firmware`
 * branch of Adafruit_Marquee, read through raw.githubusercontent.com for its CORS header).
 *
 * `base` is the root to read from, defaulting to that branch; the editor passes its
 * developer override. Ends in a slash.
 */

export const FIRMWARE_BASE = 'https://raw.githubusercontent.com/adafruit/Adafruit_Marquee/firmware/';
export const RELEASES_URL = 'https://github.com/adafruit/Adafruit_Marquee/releases';
export const MANIFEST_SCHEMA = 1;

const isAbort = (err) => err?.name === 'AbortError';

/**
 * The latest release's manifest.
 *
 * `cache: 'no-store'` because raw.githubusercontent.com caches for five minutes and the browser
 * must not add a layer of its own on top. Stale at worst means the previous release, whose
 * binaries still exist at their tag-scoped paths, so nothing breaks — the user sees the older
 * version for a few minutes.
 */
export async function fetchManifest({ base = FIRMWARE_BASE, signal } = {}) {
  let res;
  try {
    res = await fetch(`${base}manifest.json`, { cache: 'no-store', signal });
  } catch (err) {
    if (isAbort(err)) return { ok: false, error: 'aborted', message: 'Cancelled.' };
    return { ok: false, error: 'offline', message: err?.message || String(err) };
  }
  if (res.status === 404) return { ok: false, error: 'not-found', message: 'No firmware release has been published yet.' };
  if (!res.ok) return { ok: false, error: 'bad-manifest', message: `The release listing answered ${res.status}.` };

  let manifest;
  try {
    manifest = await res.json();
  } catch (err) {
    return { ok: false, error: 'bad-manifest', message: `The release listing is not JSON: ${err?.message || err}` };
  }
  if (!manifest || manifest.schema !== MANIFEST_SCHEMA || typeof manifest.tag !== 'string'
    || !manifest.boards || typeof manifest.boards !== 'object') {
    return { ok: false, error: 'bad-manifest', message: 'The release listing is not in a shape this editor understands.' };
  }
  if (typeof manifest.version !== 'string' || !manifest.version) manifest.version = manifest.tag.replace(/^v/, '');
  return { ok: true, manifest };
}

const HEX = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Download one board's merged image from the manifest, verify it, and return it in the shape
 * flash.js's loadFirmware() promises: `{ name, size, bytes }` plus the release metadata.
 *
 *   manifest    from fetchManifest()
 *   board       CI env name — 'magtag', 'adafruit_feather_esp32s3', 'x4pro'
 *   signal      AbortSignal; aborting stops the network, and the caller must ignore the result
 *   onProgress  ({ received, total }) — `total` is the manifest's byte count, not
 *               Content-Length: if the CDN ever compresses in transit, Content-Length is the
 *               encoded size and the reader yields decoded bytes, so a bar would overshoot.
 */
export async function fetchReleaseFirmware({ base = FIRMWARE_BASE, manifest, board, signal, onProgress } = {}) {
  const entry = manifest?.boards?.[board];
  if (!entry || typeof entry.bin !== 'string') {
    return { ok: false, error: 'no-board', message: `The ${manifest?.tag ?? 'latest'} release has no build for "${board}".` };
  }
  if (!globalThis.crypto?.subtle) {
    return { ok: false, error: 'insecure', message: 'Checking the download needs a secure page — https or localhost.' };
  }

  let res;
  try {
    res = await fetch(base + entry.bin, { signal });
  } catch (err) {
    if (isAbort(err)) return { ok: false, error: 'aborted', message: 'Cancelled.' };
    return { ok: false, error: 'offline', message: err?.message || String(err) };
  }
  if (res.status === 404) return { ok: false, error: 'bin-not-found', message: `${entry.bin} is not on the firmware branch yet.` };
  if (!res.ok) return { ok: false, error: 'offline', message: `The firmware download answered ${res.status}.` };

  const total = Number(entry.size) || Number(res.headers.get('content-length')) || 0;
  const chunks = [];
  let received = 0;
  try {
    if (res.body?.getReader) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        onProgress?.({ received, total });
      }
    } else {
      const buf = new Uint8Array(await res.arrayBuffer());
      chunks.push(buf);
      received = buf.length;
      onProgress?.({ received, total });
    }
  } catch (err) {
    if (isAbort(err)) return { ok: false, error: 'aborted', message: 'Cancelled.' };
    return { ok: false, error: 'offline', message: `The download stopped partway: ${err?.message || err}` };
  }

  const bytes = new Uint8Array(received);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.length; }

  if (Number.isFinite(Number(entry.size)) && Number(entry.size) > 0 && received !== Number(entry.size)) {
    return { ok: false, error: 'sha-mismatch', message: `Got ${received} bytes, the release lists ${entry.size}.` };
  }
  const sha256 = HEX(await crypto.subtle.digest('SHA-256', bytes));
  if (typeof entry.sha256 === 'string' && entry.sha256.toLowerCase() !== sha256) {
    return { ok: false, error: 'sha-mismatch', message: 'The download did not match the checksum in the release listing.' };
  }

  return {
    ok: true,
    name: entry.bin.split('/').pop() || 'merged-flash.bin',
    size: received,
    bytes,
    source: 'release',
    version: manifest.version,
    tag: manifest.tag,
    prerelease: !!manifest.prerelease,
    chip: entry.chip ?? null,
    sha256,
  };
}

/** The one sentence A6-A shows for a failed result. */
export function describeFirmwareError(res) {
  switch (res?.error) {
    case 'offline': return 'Could not reach GitHub — check the network, then Retry.';
    case 'not-found': return 'No firmware release has been published yet.';
    case 'bad-manifest': return `The release listing could not be read (${res.message}). Retry.`;
    case 'no-board': return res.message || 'The release has no build for this board.';
    case 'bin-not-found': return 'The release listing points at a file that is not there yet — Retry in a minute.';
    case 'sha-mismatch': return 'The download did not match its checksum and was not used — Retry.';
    case 'insecure': return res.message;
    case 'aborted': return '';
    default: return res?.message || 'Fetching the firmware failed.';
  }
}
