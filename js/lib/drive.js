/**
 * Writing cfg-marquee.json into the board's MARQUEE drive, once the caller has a directory
 * handle for it (File System Access API). See device/drive.js for the whole story. Picking
 * the directory needs a user gesture and the page, so that half is the caller's.
 *
 * NEVER LOGS THE FILE. It carries the Wi-Fi password and the Adafruit IO key; every line this
 * module emits names the file and a byte count and nothing else.
 */

import { CFG_FILENAME } from './cfg.js';

/** The volume label the firmware's FAT partition carries. */
export const DRIVE_VOLUME = 'MARQUEE';

/**
 * Write `text` as `fileName` into `dir` and read it back. A folder not named MARQUEE is only
 * written if `confirmMismatch(volume)` resolves true.
 *
 *   -> { ok: true, volume, bytes } | { ok: false, error, message }
 */
export async function writeConfigFile(dir, text, { fileName = CFG_FILENAME, onLog, confirmMismatch } = {}) {
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
    return { ok: false, ...classifyDriveError(err) };
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

export function classifyDriveError(err) {
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
