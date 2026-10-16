/**
 * `cfg-marquee.json`, the file the board reads at boot, assembled from plain values. See
 * docs/cfg-marquee.md for every field. The editor fills the panel half from its Settings
 * form (device/cfg.js); panelFromPreset() fills it from the catalog.
 *
 * The panel shape both produce: { driver, panel, width, height, rotation, mode, colstart?,
 * spi_bus, pins: { cs, dc, reset, busy, sram_cs, mosi, sclk } }, with `mode` in the
 * editor's spelling and pins as GPIO numbers (-1 for not wired).
 */

import { DISPLAY_PRESETS } from './presets.js';

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

/** A catalog preset as the panel half of the file, or null for an unknown key. */
export function panelFromPreset(key) {
  const p = DISPLAY_PRESETS[key];
  if (!p) return null;
  // `preset` is the unrotated framebuffer, "WIDTHxHEIGHT"
  const [width, height] = p.preset.split('x').map(Number);
  return {
    driver: p.driver,
    panel: p.panel,
    width,
    height,
    rotation: Number(p.rotation) || 0,
    mode: p.mode,
    ...(p.colstart ? { colstart: p.colstart } : {}),
    spi_bus: p.pins.bus ?? 0,
    pins: {
      cs: pinToInt(p.pins.cs),
      dc: pinToInt(p.pins.dc),
      reset: pinToInt(p.pins.rst),
      busy: pinToInt(p.pins.busy),
      sram_cs: pinToInt(p.pins.sramCs),
      mosi: pinToInt(p.pins.mosi),
      sclk: pinToInt(p.pins.sck),
    },
  };
}

/**
 * The whole file. `name` is the Adafruit IO group key: one name, four feeds, and the board
 * derives {name}.bitmap and the rest from it. `panel` is null until one is chosen, and so
 * are `display` and `interface`.
 */
export function buildMarqueeConfig({ name = '', panel = null, network, adafruitIo = {} } = {}) {
  return {
    cfg_version: CFG_VERSION,
    name,
    display: panel ? {
      driver: panel.driver,
      panel: panel.panel,
      width: panel.width,
      height: panel.height,
      // Clockwise degrees, as the form and canvas.json carry them: 0, 90, 180 or 270.
      rotation: panel.rotation,
      mode: MODE_NAMES[panel.mode] || panel.mode || 'mono',
      // Absent means "no shift", so a blank or zero offset stays out of the file entirely.
      ...(Number.isFinite(panel.colstart) && panel.colstart !== 0 ? { colstart: panel.colstart } : {}),
    } : null,
    interface: panel ? { type: 'spi_epd', spi_bus: panel.spi_bus, pins: { ...panel.pins } } : null,
    network: { ...EMPTY_NETWORK(), ...(network || {}) },
    adafruit_io: { username: adafruitIo.username || '', key: adafruitIo.key || '' },
  };
}
