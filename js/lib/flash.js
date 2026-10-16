/**
 * Firmware images and the esptool-js write — everything about flashing a board except
 * opening its port. See device/flash.js for the browser half and the full story of what
 * gets written (merged-flash.bin, in the pieces PlatformIO writes) and why.
 *
 * esptool-js and the serial port are passed in, so each host brings its own copy and asks
 * for the port its own way; nothing here touches the page.
 */

export const FIRMWARE_ARTIFACT = 'merged-flash.bin';

/**
 * The three boards the firmware is built for, keyed as the CI matrix names them.
 *
 * `chip` is compared against what esptool reads out of the ROM before anything is written —
 * a MagTag image on a Feather would brick the Feather, and the chip is the one thing the two
 * disagree on that we can check. `bootloaderOffset` is where the 0xE9 image header has to be;
 * `flashSize` bounds the file. The partition table is at 0x8000 on every layout.
 *
 * `allowErase` is whether "erase the whole chip first" may be offered. Off for the X4 Pro:
 * its factory panel calibration lives in the NVS partition, which a normal write leaves alone
 * (see imageToWrite) and an erase would not.
 */
export const BOARDS = {
  magtag: {
    board: 'magtag', label: 'MagTag', chip: 'ESP32-S2', bootloaderOffset: 0x1000, flashSize: 4 << 20, allowErase: true,
  },
  adafruit_feather_esp32s3: {
    board: 'adafruit_feather_esp32s3', label: 'Feather ESP32-S3', chip: 'ESP32-S3', bootloaderOffset: 0x0, flashSize: 4 << 20, allowErase: true,
  },
  x4pro: {
    board: 'x4pro', label: 'Xteink X4 Pro', chip: 'ESP32-S3', bootloaderOffset: 0x0, flashSize: 16 << 20, allowErase: false,
  },
};

/** Preset keys that name a whole product. Every other preset is a panel wired to a Feather. */
const PRESET_BOARD = { magtag: 'magtag', x4pro: 'x4pro' };

/**
 * Which firmware build a device needs, or null for a panel set up by hand.
 *
 * Keyed off the panel preset, because that is what tells us the host board: the preset carries
 * the Feather's SPI pins for every bare panel, so anything that is not a MagTag or an X4 Pro is
 * a Feather ESP32-S3. Reads `flow.selectedPanel` off the record — the same field cfg.js reads.
 */
export function firmwareFor(device) {
  return boardForPreset(device?.flow?.selectedPanel);
}

/** The same answer for a panel preset key. */
export function boardForPreset(preset) {
  if (!preset) return null;
  const key = PRESET_BOARD[preset] || 'adafruit_feather_esp32s3';
  return { ...BOARDS[key], artifactName: FIRMWARE_ARTIFACT };
}

const ESP_IMAGE_MAGIC = 0xe9;
/** The two bytes every ESP-IDF partition table starts with, at 0x8000 on every layout here. */
const PARTITION_TABLE_OFFSET = 0x8000;
const PARTITION_MAGIC = [0xaa, 0x50];
/** A merged image is at least bootloader + table + boot_app0 + an app; a bare app is smaller. */
const MIN_MERGED_BYTES = 256 * 1024;
/** ESP-IDF partition table: 32-byte entries, at most 95 of them (0xC00 bytes) before the md5 row. */
const PARTITION_ENTRY_BYTES = 32;
const PARTITION_TABLE_MAX_ENTRIES = 95;
const PARTITION_TYPE_DATA = 0x01;

/**
 * The partition table, read out of the merged image itself. Entry layout: magic(2) type(1)
 * subtype(1) offset(4 LE) size(4 LE) label(16) flags(4). Iteration stops at the first entry
 * without the magic — that is the md5 row or the 0xFF fill.
 */
export function readPartitions(bytes) {
  const out = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < PARTITION_TABLE_MAX_ENTRIES; i++) {
    const at = PARTITION_TABLE_OFFSET + i * PARTITION_ENTRY_BYTES;
    if (at + PARTITION_ENTRY_BYTES > bytes.length) break;
    if (bytes[at] !== PARTITION_MAGIC[0] || bytes[at + 1] !== PARTITION_MAGIC[1]) break;
    const label = new TextDecoder().decode(bytes.subarray(at + 12, at + 28)).replace(/\0.*$/, '');
    out.push({
      type: bytes[at + 2], subtype: bytes[at + 3], offset: view.getUint32(at + 4, true), size: view.getUint32(at + 8, true), label,
    });
  }
  return out;
}

/** The partition table entry that starts at `offset`, or null. */
export function findPartitionAt(bytes, offset) {
  return readPartitions(bytes).find((p) => p.offset === offset) || null;
}

/**
 * The pieces that go on the chip, each at its own address: the whole image minus the data
 * partitions the image leaves blank.
 *
 * A merged image is the flash laid out end to end with 0xFF where nothing was placed, and a
 * write erases every sector it covers, so writing the file straight through would erase the
 * blank stretches too. The one that matters is `nvs` — the X4 Pro's factory panel calibration
 * is in it — so every DATA partition whose bytes in the file are all 0xFF is left out, and the
 * rest is written contiguously: the same pieces `pio run -t upload` writes. App partitions are
 * never skipped (an app that happens to hold an all-0xFF sector has to land), and neither is
 * anything the table does not name (the bootloader and the table itself).
 *
 *   -> { segments: [{ data, address }], skipped: [{ address, length, label }], written }
 */
export function imageToWrite(fw) {
  const bytes = fw?.bytes;
  if (!bytes?.length) return { segments: [], skipped: [], written: 0 };
  const skipped = [];
  for (const p of readPartitions(bytes)) {
    if (p.type !== PARTITION_TYPE_DATA || p.offset >= bytes.length) continue;
    const end = Math.min(p.offset + p.size, bytes.length);
    let blank = true;
    for (let i = p.offset; i < end; i++) if (bytes[i] !== 0xff) { blank = false; break; }
    if (blank) skipped.push({ address: p.offset, length: end - p.offset, label: p.label });
  }
  skipped.sort((a, b) => a.address - b.address);
  const segments = [];
  let at = 0;
  for (const gap of skipped) {
    if (gap.address > at) segments.push({ data: bytes.subarray(at, gap.address), address: at });
    at = gap.address + gap.length;
  }
  if (at < bytes.length) segments.push({ data: bytes.subarray(at), address: at });
  return { segments, skipped, written: segments.reduce((n, s) => n + s.data.length, 0) };
}

/**
 * The flash size the bootloader header claims, in bytes, or 0 when there is no header or the
 * size nibble is not one esptool writes. Byte 3's high nibble: 0 → 1 MB, 1 → 2 MB, 2 → 4 MB,
 * 3 → 8 MB, 4 → 16 MB … 7 → 128 MB. merge-bin's `--flash-size` and PlatformIO's upload both
 * stamp it, so a released image always carries its board's size.
 */
export function headerFlashSize(bytes, bootloaderOffset) {
  if (bytes.length <= bootloaderOffset + 3 || bytes[bootloaderOffset] !== ESP_IMAGE_MAGIC) return 0;
  const nibble = bytes[bootloaderOffset + 3] >> 4;
  return nibble <= 7 ? (1 << 20) << nibble : 0;
}

/**
 * Is this file the merged image for this board? Run before any port dialog, so a wrong file
 * never costs the user a connect.
 *
 * The partition-table check is the load-bearing one: `firmware.bin` ALSO starts with 0xE9, and
 * writing it at 0x0 would "succeed" and leave a board with no bootloader. Only the merged image
 * has a table at 0x8000. The MagTag gets one more: its image starts with padding, so an 0xE9 at
 * byte 0 means a Feather or X4 build was picked. The two ESP32-S3 boards are told apart by the
 * flash size in the bootloader header, which merge-bin stamps: a 4 MB Feather image written
 * to a 16 MB X4 Pro (or the reverse) would pass every other check and not boot.
 */
export function validateFirmware(fw, expect) {
  const problems = [];
  const warnings = [];
  const b = fw?.bytes;
  if (!b) return { ok: false, problems: ['No file loaded.'], warnings };

  if (b.length < MIN_MERGED_BYTES) {
    problems.push(`Too small to be a merged image (${b.length} bytes) — was this firmware.bin or partitions.bin instead of ${FIRMWARE_ARTIFACT}?`);
  }
  if (expect && b.length > expect.flashSize) {
    problems.push(`Larger than the ${expect.label}'s ${expect.flashSize >> 20} MB flash.`);
  }
  if (b.length > PARTITION_TABLE_OFFSET + 2
    && !(b[PARTITION_TABLE_OFFSET] === PARTITION_MAGIC[0] && b[PARTITION_TABLE_OFFSET + 1] === PARTITION_MAGIC[1])) {
    problems.push(`No partition table at 0x8000 — this is not ${FIRMWARE_ARTIFACT}.`);
  }
  if (expect) {
    if (b[expect.bootloaderOffset] !== ESP_IMAGE_MAGIC) {
      problems.push(`No bootloader at 0x${expect.bootloaderOffset.toString(16)}, where the ${expect.label} image keeps it.`);
    }
    if (expect.board === 'magtag' && b[0] === ESP_IMAGE_MAGIC) {
      problems.push('This looks like a Feather or X4 Pro image, not the MagTag build.');
    }
    const headerSize = headerFlashSize(b, expect.bootloaderOffset);
    if (headerSize && headerSize !== expect.flashSize) {
      problems.push(`Built for a ${headerSize >> 20} MB chip; the ${expect.label} has ${expect.flashSize >> 20} MB — this is another board's image.`);
    }
  } else if (b[0] !== ESP_IMAGE_MAGIC && b[0x1000] !== ESP_IMAGE_MAGIC) {
    problems.push('No ESP image header at 0x0 or 0x1000.');
  } else {
    warnings.push('Panel set up by hand — the chip will not be checked against the image.');
  }
  if (fw.name && fw.name !== FIRMWARE_ARTIFACT) {
    warnings.push(`Expected a file named ${FIRMWARE_ARTIFACT}; got ${fw.name}.`);
  }
  return { ok: problems.length === 0, problems, warnings };
}

// ---------- the write path ---------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * esptool-js's terminal, adapted to a line log.
 *
 * It calls write() with fragments — "Connecting...", then a "." or "_" per retry, then
 * "\n\r" — and writeLine() with whole lines. Fragments are held until a line break so the log
 * does not fill with one-word lines, and the retry spinners are dropped outright.
 */
function makeTerminal(onLog) {
  let partial = '';
  const emit = (s) => {
    const line = s.replace(/\r/g, '').trim();
    if (line && !/^[._]+$/.test(line)) onLog?.(line);
  };
  return {
    clean() {},
    write(s) {
      partial += String(s);
      if (/[\n\r]/.test(partial)) {
        const parts = partial.split(/[\n\r]+/);
        partial = parts.pop();
        parts.forEach(emit);
      }
    },
    writeLine(s) {
      emit(partial + String(s));
      partial = '';
    },
    flush() {
      if (partial.trim()) emit(partial);
      partial = '';
    },
  };
}

/**
 * Release the port without letting it fail the flash.
 *
 * After a hard reset the board re-enumerates as its TinyUSB self and the port we hold is gone:
 * close() rejects, and esptool-js's waitForUnlock() has no ceiling. The write already finished
 * by then, so this is raced against a timer and any error is swallowed.
 */
async function disconnectQuietly(transport) {
  if (!transport) return;
  try {
    await Promise.race([transport.disconnect(), sleep(2000)]);
  } catch { /* port already gone — that is the expected way out */ }
}

/**
 * Sort a thrown error into one of the outcomes describeFlashError() knows.
 *
 * By name and message, never instanceof: the bundle does not export its ESPError class, and
 * the interesting ones are DOMExceptions from Web Serial anyway.
 */
export function classifyFlashError(err, phase) {
  const name = err?.name || '';
  const msg = err?.message || String(err ?? '');
  if (name === 'NotFoundError') return { error: 'cancelled', message: msg };
  if (name === 'NetworkError' || name === 'InvalidStateError' || /failed to open/i.test(msg)) {
    return { error: 'port-busy', message: msg };
  }
  if (/unexpected chip magic/i.test(msg)) return { error: 'unknown-chip', message: msg };
  if (phase === 'connect' && /failed to connect|wrong boot mode|timeout|no sync|timed out/i.test(msg)) {
    return { error: 'no-sync', message: msg };
  }
  if (phase === 'write') return { error: 'write-failed', message: msg };
  if (phase === 'connect') return { error: 'no-sync', message: msg };
  return { error: 'load-failed', message: msg };
}

/** The one sentence A6-A shows for a failed result. */
export function describeFlashError(res) {
  switch (res?.error) {
    case 'unsupported': return 'This browser cannot talk to a serial port.';
    case 'cancelled': return 'No port chosen.';
    case 'port-busy': return 'The port is in use — close the Arduino serial monitor, screen, Mu or Thonny, then try again.';
    case 'no-sync': return 'The board did not answer. Put it in bootloader mode — hold BOOT, tap RESET, release BOOT — then Connect again.';
    case 'unknown-chip': return 'That is not a chip this firmware supports.';
    case 'chip-mismatch': return res.message || 'The board is not the chip this firmware was built for.';
    case 'erase-unsafe': return res.message || 'A full erase is not possible on this board — its factory panel calibration lives in flash outside the image, and an erase would wipe it.';
    case 'write-failed': return 'Writing stopped partway — the board is not bootable. Power-cycle it, re-enter bootloader mode and flash again.';
    case 'load-failed': return res?.message ? `Could not start the flasher: ${res.message}` : 'Could not load the flasher module.';
    default: return res?.message || 'Flashing failed.';
  }
}

/**
 * The checks that need no board: refused before anyone is asked to pick a port. Null when
 * the write can go ahead, else a result describeFlashError() knows.
 */
export function flashPreflight({ firmware, expect = null, eraseAll = false } = {}) {
  if (!firmware?.bytes) return { ok: false, error: 'load-failed', message: 'No firmware loaded.' };
  if (!imageToWrite(firmware).written) return { ok: false, error: 'load-failed', message: 'Nothing to write.' };
  if (eraseAll && expect?.allowErase === false) return { ok: false, error: 'erase-unsafe' };
  return null;
}

/**
 * Connect, check the chip, write the image, reset.
 *
 *   esptool    the esptool-js module ({ Transport, ESPLoader }); each host brings its own
 *   port       a Web Serial port the caller has already been granted
 *   firmware   { name, size, bytes } from loadFirmware(), already validated
 *   expect     boardForPreset() / firmwareFor(), or null to skip the chip check
 *   eraseAll   full-chip erase before the write. OFF by default and opt-in on screen: the
 *              firmware never formats its FAT partition, so an erase takes the MARQUEE drive
 *              with it. Refused outright for a board with `allowErase: false` (the X4 Pro):
 *              its factory panel calibration is in NVS, which imageToWrite() steps around and
 *              an erase would not.
 *   baud       the rate after the stub is running. 460800 rather than 921600 — nominal over
 *              native USB, but the change-baud handshake is where a flaky link shows itself.
 *
 *   -> Promise<{ ok: true, chip, chipDesc, address, written, pieces } | { ok: false, error, message, chip? }>
 */
export async function writeImage({
  esptool, port, firmware, expect = null, eraseAll = false, baud = 460800, onLog, onProgress,
} = {}) {
  const problem = flashPreflight({ firmware, expect, eraseAll });
  if (problem) return problem;
  const { segments, written } = imageToWrite(firmware);
  const address = segments[0].address;
  // For the overall percentage: bytes in the pieces before each one.
  const sizes = segments.map((s) => s.data.length);
  const before = sizes.map((_, i) => sizes.slice(0, i).reduce((a, b) => a + b, 0));

  const terminal = makeTerminal(onLog);
  const transport = new esptool.Transport(port, false);
  const loader = new esptool.ESPLoader({ transport, baudrate: baud, romBaudrate: 115200, terminal });

  let chip = null;
  let phase = 'connect';
  try {
    onLog?.(`Connecting… (${firmware.name}, ${written} bytes in ${segments.length} pieces)`);
    const chipDesc = await loader.main();
    terminal.flush();
    chip = loader.chip?.CHIP_NAME || chipDesc;

    if (expect && chip !== expect.chip) {
      return {
        ok: false,
        error: 'chip-mismatch',
        chip,
        message: `Found an ${chip}, but the ${expect.label} firmware needs an ${expect.chip}. Pick the artifact for this board.`,
      };
    }

    phase = 'write';
    onProgress?.({ phase: 'erase', state: eraseAll ? 'busy' : 'skipped', pct: 0 });
    onProgress?.({ phase: 'write', state: 'idle', pct: 0 });
    if (eraseAll) onLog?.('Erasing the whole chip first — this takes a while and reports nothing until it is done.');

    let first = true;
    await loader.writeFlash({
      fileArray: segments,
      flashSize: 'keep',
      flashMode: 'keep',
      flashFreq: 'keep',
      eraseAll,
      compress: true,
      // `done` and `total` are for ONE piece and count COMPRESSED bytes, so they are only good
      // for a ratio; weight that by the piece's real size for the overall figure.
      reportProgress(index, done, total) {
        if (first) {
          first = false;
          if (eraseAll) onProgress?.({ phase: 'erase', state: 'done', pct: 100 });
        }
        const soFar = before[index] + (total ? (done / total) * sizes[index] : 0);
        const pct = (soFar / written) * 100;
        onProgress?.({ phase: 'write', state: pct >= 100 ? 'done' : 'active', pct });
      },
    });
    terminal.flush();
    onProgress?.({ phase: 'write', state: 'done', pct: 100 });
    onLog?.(`Wrote ${written} bytes in ${segments.length} pieces.`);

    // The S2 ROM talks USB-OTG CDC; the S3 ROM talks USB-Serial/JTAG. Either way the port is
    // about to vanish as the board comes up as its TinyUSB self, so a throw here is news, not
    // failure — the write is already on the chip.
    try {
      await loader.after('hard_reset', chip === 'ESP32-S2');
      onLog?.('Reset sent. If the board does not restart on its own, press RESET.');
    } catch {
      onLog?.('Reset sent; the port closed as the board restarted.');
    }
    return { ok: true, chip, chipDesc, address, written, pieces: segments.length };
  } catch (err) {
    terminal.flush();
    const out = classifyFlashError(err, phase);
    onLog?.(`Error: ${out.message}`);
    return { ok: false, chip, ...out };
  } finally {
    await disconnectQuietly(transport);
  }
}
