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

import { buildMarqueeConfig as assembleConfig, pinToInt } from '../lib/cfg.js';

// The file's shape and assembly are lib/cfg.js; this module reads the live stores into it.
export { CFG_VERSION, CFG_FILENAME, pinToInt } from '../lib/cfg.js';

/**
 * Has a panel been picked? The panel half of the file stays null until A4 has run, so a
 * record mid-setup does not ship the MagTag defaults the form happens to hold.
 */
function panelChosen() {
  return !!getState().selectedPanel || !!activeDevice()?.displayConfig;
}

/** The Settings form, in lib/cfg.js's panel shape. */
function panelFromForm() {
  return {
    driver: val('pmDriver') || 'SSD1680',
    panel: val('pmPanel') || '',
    width: Number($('resW')?.value) || 0,
    height: Number($('resH')?.value) || 0,
    rotation: Number($('rotSel')?.value) || 0,
    mode: val('dtype') || 'mono',
    colstart: Number.parseInt(val('pmColstart'), 10),
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
  return assembleConfig({
    name: ioGroupKey(),
    panel: panelChosen() ? panelFromForm() : null,
    network,
    adafruitIo: { username: val('ioUser'), key: $('ioKey')?.value || '' },
  });
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
