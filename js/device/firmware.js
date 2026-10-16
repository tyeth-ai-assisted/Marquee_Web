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

import {
  FIRMWARE_BASE, fetchManifest as fetchManifestFrom, fetchReleaseFirmware as fetchReleaseFirmwareFrom,
} from '../lib/firmware.js';

export { FIRMWARE_BASE, RELEASES_URL, MANIFEST_SCHEMA, describeFirmwareError } from '../lib/firmware.js';

/** The base URL, with the dev override applied. Always ends in a slash. */
export function firmwareBase() {
  try {
    const o = globalThis.localStorage?.getItem('marquee.firmwareBase');
    if (o) return o.endsWith('/') ? o : `${o}/`;
  } catch { /* storage disabled */ }
  return FIRMWARE_BASE;
}

/** The manifest, from the override base when one is set (lib/firmware.js fetchManifest). */
export async function fetchManifest({ signal } = {}) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { ok: false, error: 'offline', message: 'This computer is offline.' };
  }
  return fetchManifestFrom({ base: firmwareBase(), signal });
}

/** A board's image, from the override base when one is set (lib/firmware.js fetchReleaseFirmware). */
export function fetchReleaseFirmware(options = {}) {
  return fetchReleaseFirmwareFrom({ ...options, base: firmwareBase() });
}
