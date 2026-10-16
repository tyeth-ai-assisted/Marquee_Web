/**
 * Writing firmware to a board over WebSerial — the esptool-js path behind A6-A.
 *
 * Browser-side end to end: `js/vendor/esptool-js.js` is the upstream bundle (esptool-js
 * 0.6.1, Apache-2.0, pako inlined) loaded with a dynamic import() the first time someone
 * clicks Connect, so the 218 KB never ships to a user who only edits. No server is involved,
 * which is what lets the whole flow work from a static host.
 *
 * WHAT GETS WRITTEN. One file, `merged-flash.bin`. The Adafruit_Marquee CI produces it with
 * `esptool merge-bin --format raw`: bootloader, partition table, boot_app0 and the app laid out
 * at their real offsets with 0xFF in the gaps, so a single write at 0 is the whole flash image.
 * The MagTag's bootloader sits at 0x1000, so its image starts with 0x1000 bytes of padding; the
 * two ESP32-S3 boards start with the bootloader itself.
 *
 * It is written the way `pio run -t upload` writes its four pieces, not as one blob. A write
 * erases every sector it covers, so writing the raw file straight through would also erase
 * the blank stretches in it — and one of those is `nvs` at 0x9000, where the Xteink X4 Pro's
 * factory panel calibration lives. imageToWrite() reads the image's own partition table and
 * leaves out every data partition whose bytes in the file are all 0xFF; what remains —
 * bootloader, partition table, boot_app0 (which points the OTA choice back at `ota_0`) and
 * the app — is written at its own address. Every board gets this, so the write matches what
 * PlatformIO does on all of them.
 *
 * The X4 Pro used to get the app alone at 0x10000, Xteink style, so that the chip's own
 * bootloader and table survived. That left whatever partition table and OTA data the chip
 * already had, and the firmware needs THIS table (its `ffat` partition is where the MARQUEE
 * drive lives) with `ota_0` selected — an OEM table or a chip that had OTA'd to `ota_1` came
 * up wrong. All that is left of the exception is the board table's `allowErase: false`: a
 * full erase would take the calibration, so A6-A hides the option and flashDevice() refuses it.
 *
 * WHERE IT COMES FROM. The latest release, by default: firmware.js fetches the manifest CI
 * commits to the `firmware` branch of Adafruit_Marquee and downloads the board's merged image
 * from it, sha256-checked. (Not the Release page's assets — GitHub's asset CDN sends no CORS
 * header, so a browser cannot read them; see firmware.js.) A file the user picked is the
 * fallback, for a CI artifact, an older release, or a panel set up by hand. loadFirmware() is
 * where the two meet: both return the same shape, and nothing downstream knows which it was.
 *
 * WHAT IS NOT HERE. The config file. The firmware reads `cfg-marquee.json` from the FAT
 * volume it exposes over USB, not from anything written over serial, so that step lives in
 * drive.js and this module never sees a credential. Nothing it logs can leak one.
 *
 * THE CONTRACT
 *
 *   flashDevice({ firmware, expect, eraseAll, onLog, onProgress })
 *     -> Promise<{ ok: true, chip, chipDesc, address, written, pieces } | { ok: false, error, message, chip? }>
 *
 * Resolves rather than throws, for the reason provision.js does: the caller has to tell "no
 * port chosen" from "wrong chip" from "write failed halfway", because each wants a different
 * sentence on screen, and a thrown Error flattens all three into one catch block.
 * describeFlashError() holds those sentences.
 *
 * `onProgress({ phase: 'erase' | 'write', state, pct })` — state is one of
 * idle | skipped | busy | active | done. `busy` exists because a full-chip erase reports no
 * progress at all: esptool-js sends one command and waits up to the chip-erase timeout, so the
 * honest thing to show is "erasing…" and not a number.
 */

import { fetchManifest, fetchReleaseFirmware } from './firmware.js';
import { flashPreflight, writeImage, classifyFlashError } from '../lib/flash.js';

// The image checks and the write itself are lib/flash.js, re-exported for the screens.
export {
  FIRMWARE_ARTIFACT, firmwareFor, validateFirmware, imageToWrite, readPartitions, findPartitionAt,
  headerFlashSize, describeFlashError,
} from '../lib/flash.js';

/** Is this browser capable of talking to a serial port at all? */
export function serialSupported() {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

/**
 * Get the bytes of a firmware image from wherever it lives.
 *
 * The source seam. Two kinds:
 *
 *   { kind: 'release', board, manifest?, signal?, onProgress? }
 *       the latest published release, from the firmware branch (firmware.js). The manifest is
 *       fetched here when the caller has not already got one. Failures carry firmware.js's
 *       error codes so the screen can pick its sentence and its button.
 *   { kind: 'file', file }
 *       a File the user chose.
 *
 * Both resolve to `{ ok, name, size, bytes, source }` — validateFirmware() and flashDevice()
 * take that and never learn which it was.
 */
export async function loadFirmware(source) {
  try {
    if (source?.kind === 'release') {
      let { manifest } = source;
      if (!manifest) {
        const m = await fetchManifest({ signal: source.signal });
        if (!m.ok) return m;
        manifest = m.manifest;
      }
      return fetchReleaseFirmware({ manifest, board: source.board, signal: source.signal, onProgress: source.onProgress });
    }
    if (source?.kind === 'file' && source.file) {
      const buf = await source.file.arrayBuffer();
      return { ok: true, name: source.file.name, size: buf.byteLength, bytes: new Uint8Array(buf), source: 'file' };
    }
    return { ok: false, error: 'load-failed', message: `Unsupported firmware source: ${source?.kind ?? 'none'}` };
  } catch (err) {
    return { ok: false, error: 'load-failed', message: err?.message || String(err) };
  }
}

let esptoolModule = null;

/** The bundle, once. Cached as the promise so two clicks do not load it twice. */
function loadEsptool() {
  if (!esptoolModule) {
    esptoolModule = import('../vendor/esptool-js.js').catch((err) => {
      esptoolModule = null;
      throw err;
    });
  }
  return esptoolModule;
}

/**
 * Pick a port, then hand it to lib/flash.js's writeImage() with the vendored esptool-js.
 * Options and result are writeImage()'s; see there.
 */
export async function flashDevice({
  firmware, expect = null, eraseAll = false, baud = 460800, onLog, onProgress,
} = {}) {
  if (!serialSupported()) return { ok: false, error: 'unsupported' };
  const problem = flashPreflight({ firmware, expect, eraseAll });
  if (problem) return problem;

  let esptool;
  try {
    esptool = await loadEsptool();
  } catch (err) {
    return { ok: false, error: 'load-failed', message: err?.message || String(err) };
  }

  // A cancelled picker is the one outcome that is not an error.
  let port;
  try {
    port = await navigator.serial.requestPort();
  } catch (err) {
    return { ok: false, ...classifyFlashError(err, 'pick') };
  }

  return writeImage({ esptool, port, firmware, expect, eraseAll, baud, onLog, onProgress });
}
