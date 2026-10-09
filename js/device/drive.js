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

import { CFG_FILENAME } from './cfg.js';

/** The volume label the firmware's FAT partition carries. */
export const DRIVE_VOLUME = 'MARQUEE';

/** Can this browser open a directory for writing? */
export function dirPickerSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

/**
 * Pick the drive and write the file.
 *
 *   text             the file contents, exactly as cfgJson() renders them
 *   fileName         defaults to cfg-marquee.json
 *   onLog            (line) => void
 *   confirmMismatch  async (name) => boolean — asked when the chosen folder is not called
 *                    MARQUEE. Absent means "refuse".
 *
 * Must be called from a click handler with no await in between: showDirectoryPicker() needs
 * the user activation still to be live.
 */
export async function writeConfigToDrive(text, { fileName = CFG_FILENAME, onLog, confirmMismatch } = {}) {
  if (!dirPickerSupported()) {
    return { ok: false, error: 'unsupported', message: 'This browser cannot write to a drive directly.' };
  }

  let dir;
  try {
    // `id` lets the browser remember this picker's last directory separately from any other.
    dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'marquee-drive' });
  } catch (err) {
    return { ok: false, ...classify(err) };
  }

  const volume = dir.name || '';
  if (volume.toUpperCase() !== DRIVE_VOLUME) {
    const proceed = confirmMismatch ? await confirmMismatch(volume) : false;
    if (!proceed) {
      onLog?.(`Chose "${volume}", not ${DRIVE_VOLUME} — nothing written.`);
      return { ok: false, error: 'wrong-volume', message: `That folder is "${volume}", not ${DRIVE_VOLUME}.` };
    }
    onLog?.(`Writing to "${volume}" — not the ${DRIVE_VOLUME} volume, at your say-so.`);
  }

  const bytes = new TextEncoder().encode(text).length;
  let file;
  try {
    file = await dir.getFileHandle(fileName, { create: true });
    // createWritable() stages to a swap file and swaps on close(), which is what makes a
    // half-written config impossible even if the cable goes mid-write.
    const w = await file.createWritable({ keepExistingData: false });
    await w.write(text);
    await w.close();
  } catch (err) {
    onLog?.(`Could not write ${fileName}: ${err?.message || err}`);
    return { ok: false, ...classify(err) };
  }

  try {
    const back = await (await file.getFile()).text();
    if (back !== text) {
      onLog?.(`${fileName} read back differently from what was written.`);
      return { ok: false, error: 'verify-failed', message: `${fileName} did not read back as written — eject the drive and try again.` };
    }
  } catch (err) {
    return { ok: false, error: 'verify-failed', message: `Wrote ${fileName} but could not read it back: ${err?.message || err}` };
  }

  onLog?.(`Wrote ${fileName} (${bytes} bytes) to ${volume}.`);
  return { ok: true, volume, bytes };
}

function classify(err) {
  const name = err?.name || '';
  const msg = err?.message || String(err ?? '');
  if (name === 'AbortError') return { error: 'cancelled', message: 'No drive chosen.' };
  if (name === 'SecurityError' || name === 'NotAllowedError') {
    return { error: 'denied', message: 'The browser was not allowed to write there — the drive may be read-only. Eject it, unplug the board, plug it back in and try again.' };
  }
  return { error: 'write-failed', message: msg || 'Writing to the drive failed.' };
}

/** The one sentence A6-A shows for a failed result. */
export function describeDriveError(res) {
  switch (res?.error) {
    case 'unsupported': return 'This browser cannot write to a drive directly — download the file and copy it over instead.';
    case 'cancelled': return 'No drive chosen.';
    case 'wrong-volume': return res.message || `That folder is not ${DRIVE_VOLUME}.`;
    case 'denied': return res.message;
    case 'verify-failed': return res.message;
    case 'write-failed': return `Could not write to the drive: ${res.message}`;
    default: return res?.message || 'Writing the config failed.';
  }
}
