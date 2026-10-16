/**
 * Writing cfg-marquee.json onto the board's USB drive — the second half of A6-A.
 *
 * The firmware does not take its configuration over serial. At boot it mounts the FAT
 * partition on its own flash and exposes it over USB mass storage as a volume named MARQUEE,
 * then reads `/cfg-marquee.json` off it; with no file there it halts with the drive still
 * mounted, which is exactly the state this module writes into. The browser side is the File
 * System Access API: the user picks the volume in a directory dialog, and we write the file
 * into it and read it back.
 *
 * Chromium desktop only, like Web Serial, and gated separately — the two are independent
 * capabilities, and a browser can have one without the other. Where it is missing, A6-A
 * falls back to a download the user copies over by hand.
 *
 * NEVER LOGS THE FILE. It carries the Wi-Fi password and the Adafruit IO key; every line this
 * module emits names the file and a byte count and nothing else.
 *
 * Resolves tagged results and never throws, for the same reason flash.js and provision.js do:
 * a cancelled picker, a read-only volume and a mismatched read-back each want a different
 * sentence on screen.
 */

import { writeConfigFile, classifyDriveError } from '../lib/drive.js';

export { DRIVE_VOLUME, describeDriveError } from '../lib/drive.js';

/** Can this browser open a directory for writing? */
export function dirPickerSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

/** Ask for the MARQUEE drive, then write the file into it (lib/drive.js writeConfigFile). */
export async function writeConfigToDrive(text, options = {}) {
  if (!dirPickerSupported()) {
    return { ok: false, error: 'unsupported', message: 'This browser cannot write to a drive directly.' };
  }

  let dir;
  try {
    // `id` lets the browser remember this picker's last directory separately from any other.
    dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'marquee-drive' });
  } catch (err) {
    return { ok: false, ...classifyDriveError(err) };
  }

  return writeConfigFile(dir, text, options);
}
