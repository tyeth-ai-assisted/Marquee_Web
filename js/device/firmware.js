/**
 * Fetching the latest firmware release for a board — the network half of A6-A's flash stage.
 *
 * WHERE THE FIRMWARE LIVES, and why it is not the GitHub Release page. A browser can only read
 * a cross-origin download when the server sends Access-Control-Allow-Origin, and GitHub's
 * release-asset CDN (release-assets.githubusercontent.com) does not — the request succeeds on
 * the wire and Chrome throws the bytes away. raw.githubusercontent.com does send the header,
 * for any file committed to any branch. So Adafruit_Marquee's CI, on every published release,
 * commits the built binaries to an orphan `firmware` branch:
 *
 *   manifest.json                              the LATEST release (overwritten each publish)
 *   <tag>/manifest.json                        the same, kept per tag
 *   <tag>/marquee-<env>/merged-flash.bin       what this module downloads
 *   <tag>/marquee-<env>/{bootloader,partitions,boot_app0,firmware}.bin, build.json
 *
 * The Release page gets zips of the same directories for people; this module never touches it.
 *
 * THE MANIFEST (schema 1):
 *
 *   { "schema": 1, "tag": "v1.0.0-alpha", "version": "1.0.0-alpha", "prerelease": true,
 *     "published_at": "...", "commit": "...",
 *     "boards": { "magtag": { "bin": "v1.0.0-alpha/marquee-magtag/merged-flash.bin",
 *                             "size": 1265344, "sha256": "...", "chip": "ESP32-S2",
 *                             "bootloader_offset": "0x1000" }, ... } }
 *
 * Board keys are the CI env names, the same ones flash.js's board table uses. `chip` here is
 * informational — flash.js's table stays the authority for the chip check before a write.
 *
 * WHAT IS VERIFIED. The download is compared against the manifest's byte count and SHA-256
 * before it is handed on; a short or altered body is refused, never flashed. After that it
 * goes through the same validateFirmware() checks a file from disk does.
 *
 * Resolves tagged results and never throws, like flash.js and drive.js: the screen has to tell
 * "no release yet" from "offline" from "checksum mismatch", because each wants a different
 * sentence and a different button.
 *
 * DEV KNOB: `localStorage['marquee.firmwareBase']`, when set, replaces FIRMWARE_BASE — how the
 * flow is smoke-tested against a local fixture without publishing a release. Anyone who can set
 * localStorage on this origin already owns the page, so it is not a new surface.
 */

export const FIRMWARE_BASE = 'https://raw.githubusercontent.com/adafruit/Adafruit_Marquee/firmware/';
export const RELEASES_URL = 'https://github.com/adafruit/Adafruit_Marquee/releases';
export const MANIFEST_SCHEMA = 1;

/** The base URL, with the dev override applied. Always ends in a slash. */
export function firmwareBase() {
  try {
    const o = globalThis.localStorage?.getItem('marquee.firmwareBase');
    if (o) return o.endsWith('/') ? o : `${o}/`;
  } catch { /* storage disabled */ }
  return FIRMWARE_BASE;
}

const isAbort = (err) => err?.name === 'AbortError';

/**
 * The latest release's manifest.
 *
 * `cache: 'no-store'` because raw.githubusercontent.com caches for five minutes and the browser
 * must not add a layer of its own on top. Stale at worst means the previous release, whose
 * binaries still exist at their tag-scoped paths, so nothing breaks — the user sees the older
 * version for a few minutes.
 */
export async function fetchManifest({ signal } = {}) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { ok: false, error: 'offline', message: 'This computer is offline.' };
  }
  let res;
  try {
    res = await fetch(`${firmwareBase()}manifest.json`, { cache: 'no-store', signal });
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
export async function fetchReleaseFirmware({ manifest, board, signal, onProgress } = {}) {
  const entry = manifest?.boards?.[board];
  if (!entry || typeof entry.bin !== 'string') {
    return { ok: false, error: 'no-board', message: `The ${manifest?.tag ?? 'latest'} release has no build for "${board}".` };
  }
  if (!globalThis.crypto?.subtle) {
    return { ok: false, error: 'insecure', message: 'Checking the download needs a secure page — https or localhost.' };
  }

  let res;
  try {
    res = await fetch(firmwareBase() + entry.bin, { signal });
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
