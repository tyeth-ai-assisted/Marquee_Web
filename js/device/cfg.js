/**
 * The per-display `cfg-marquee.json` — the file the board reads at boot.
 *
 * One object per device record (`rec.cfg`), in EXACTLY the shape the firmware wants, so
 * the debug view on A6-A and the file the flash path writes are the same bytes. It fills
 * in as setup advances: A1-C settles the account, A4 the panel and pins, A5b the group
 * key (which is the config's `name`), A5C the network. See docs/cfg-marquee.md.
 *
 * DERIVED, NOT AUTHORED — with one exception. Every field except `network` is rebuilt
 * from the live stores each time syncCfg() runs, because those stores are already the
 * truth: the Settings-modal pin fields, `#ioGroup`, `#ioUser`/`#ioKey`. A second copy
 * that had to be kept in step by hand would drift the first time someone re-pinned a
 * panel in Settings. `network` is the exception because nothing else holds it — A5C
 * writes it straight in here and syncCfg() carries it forward.
 *
 * The live stores ARE the active device (see the module note in devices.js), so this
 * module reads the DOM and writes only to the active record. It imports nothing from
 * config.js — config.js imports THIS, to sync after every descriptor save — and nothing
 * that would drag Konva into a setup screen.
 */

import { ioGroupKey } from '../core/api.js';
import { getState } from '../core/state.js';
import { activeDevice, patchActive } from './devices.js';
import { $, val } from '../core/util.js';

export const CFG_VERSION = 2;
export const CFG_FILENAME = 'cfg-marquee.json';

/** `mode` as the firmware spells it. Only gray4 differs from the editor's name. */
const MODE_NAMES = { mono: 'mono', gray4: 'grayscale4', tricolor: 'tricolor', quadcolor: 'quadcolor' };

const EMPTY_NETWORK = () => ({ wifi_ssid: '', wifi_password: '' });

/**
 * A pin field as an integer GPIO number.
 *
 * The form spells pins the way the device's parsePin() reads them — "D8" — and the
 * config file wants the bare number. Blank and "-1" both mean "not wired" and become
 * -1, as does anything that is not a pin at all: a typo should produce a pin the board
 * refuses rather than one it silently drives.
 */
export function pinToInt(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s === '-1') return -1;
  const m = /^D?(\d+)$/i.exec(s);
  return m ? Number(m[1]) : -1;
}

/**
 * Has A4 chosen a panel for this device yet?
 *
 * Before that, the descriptor form holds whatever the PREVIOUS device left in it —
 * loadConfig(null) deliberately leaves a fresh draft's form alone — and a config that
 * printed those pins would be describing the wrong board.
 */
function panelChosen() {
  return !!getState().selectedPanel || !!activeDevice()?.displayConfig;
}

function buildDisplay() {
  const out = {
    driver: val('pmDriver') || 'SSD1680',
    panel: val('pmPanel') || '',
    width: Number($('resW')?.value) || 0,
    height: Number($('resH')?.value) || 0,
    // Clockwise degrees, as the form and canvas.json carry them: 0, 90, 180 or 270.
    rotation: Number($('rotSel')?.value) || 0,
    mode: MODE_NAMES[val('dtype')] || val('dtype') || 'mono',
  };
  // Absent means "no shift", so a blank or zero field stays out of the file entirely —
  // the same rule the Settings hint states for the descriptor.
  const colstart = Number.parseInt(val('pmColstart'), 10);
  if (Number.isFinite(colstart) && colstart !== 0) out.colstart = colstart;
  return out;
}

function buildInterface() {
  return {
    type: 'spi_epd',
    spi_bus: Number($('spiBus')?.value) || 0,
    pins: {
      cs: pinToInt(val('pinCs')),
      dc: pinToInt(val('pinDc')),
      reset: pinToInt(val('pinRst')),
      busy: pinToInt(val('pinBusy')),
      sram_cs: pinToInt(val('pinSramCs')),
      mosi: pinToInt(val('pinMosi')),
      sclk: pinToInt(val('pinSck')),
    },
  };
}

/**
 * The whole file, from the live stores.
 *
 * `network` is passed in rather than read, because it is the one block with no live
 * store — see the module note. `display` and `interface` are null until A4 has picked
 * a panel, so the debug view says "not yet" rather than showing another board's pins.
 */
export function buildMarqueeConfig({ network } = {}) {
  const chosen = panelChosen();
  return {
    cfg_version: CFG_VERSION,
    // The group key. One name, four feeds — the board derives {name}.bitmap and the
    // rest from it, exactly as api.js does on this side.
    name: ioGroupKey(),
    display: chosen ? buildDisplay() : null,
    interface: chosen ? buildInterface() : null,
    network: { ...EMPTY_NETWORK(), ...(network || {}) },
    adafruit_io: {
      username: val('ioUser'),
      key: $('ioKey')?.value || '',
    },
  };
}

/**
 * Rebuild the active record's `cfg` from the live stores.
 *
 * The one write path. Called after every descriptor save (config.js), every settings
 * save (main.js), on rehydrate (activate.js), and just before A6-A shows or writes the
 * file — so a record minted before this field existed picks it up the first time it is
 * opened, and nothing anyone reads is older than the last edit.
 */
export function syncCfg() {
  const rec = activeDevice();
  if (!rec) return null;
  const cfg = buildMarqueeConfig({ network: rec.cfg?.network });
  patchActive({ cfg });
  return cfg;
}

/** A5C's write. Lands in `cfg.network` and nowhere else; syncCfg() carries it forward. */
export function setWifiCredentials({ ssid, password }) {
  const rec = activeDevice();
  if (!rec) return null;
  const network = { wifi_ssid: String(ssid ?? '').trim(), wifi_password: String(password ?? '') };
  patchActive({ cfg: { ...(rec.cfg || buildMarqueeConfig()), network } });
  return syncCfg();
}

/** What A5C should prefill, and what A6-A has to write. Null when nothing is saved. */
export function wifiCredentials() {
  const n = activeDevice()?.cfg?.network;
  return n && (n.wifi_ssid || n.wifi_password) ? { ...n } : null;
}

/** The file as text, pretty-printed — what the debug modal shows and Download saves. */
export function cfgJson(rec = activeDevice()) {
  return JSON.stringify(rec?.cfg ?? {}, null, 2);
}
