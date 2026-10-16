/**
 * cfg-marquee.json from plain values — public/js/lib/cfg.js.
 *
 * panelFromPreset() is how a host with no Settings form (Adafruit IO) fills in the panel
 * half, so a catalog entry has to come out exactly as docs/cfg-marquee.md's worked example
 * describes the board it names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMarqueeConfig, panelFromPreset, pinToInt, CFG_VERSION } from '../public/js/lib/cfg.js';
import { PRESET_KEYS } from '../public/js/lib/presets.js';

test('the MagTag preset makes the worked example in docs/cfg-marquee.md', () => {
  const cfg = buildMarqueeConfig({
    name: 'kitchen-board',
    panel: panelFromPreset('magtag'),
    network: { wifi_ssid: 'Transit', wifi_password: 'BigWindows' },
    adafruitIo: { username: 'brentrubell', key: 'aio_XXXXXXXXXXXXXXXXXXXXXXXXXXXX' },
  });
  assert.deepEqual(cfg, {
    cfg_version: CFG_VERSION,
    name: 'kitchen-board',
    display: { driver: 'SSD1680', panel: 'magtag', width: 128, height: 296, rotation: 0, mode: 'grayscale4' },
    interface: {
      type: 'spi_epd', spi_bus: 0,
      pins: { cs: 8, dc: 7, reset: 6, busy: 5, sram_cs: -1, mosi: -1, sclk: -1 },
    },
    network: { wifi_ssid: 'Transit', wifi_password: 'BigWindows' },
    adafruit_io: { username: 'brentrubell', key: 'aio_XXXXXXXXXXXXXXXXXXXXXXXXXXXX' },
  });
});

test('every preset makes a complete panel, rotation as a number of degrees', () => {
  for (const key of PRESET_KEYS) {
    const panel = panelFromPreset(key);
    assert.ok(panel.width > 0 && panel.height > 0, key);
    assert.ok([0, 90, 180, 270].includes(panel.rotation), key);
    assert.ok(Object.values(panel.pins).every(Number.isInteger), key);
  }
  assert.equal(panelFromPreset('nope'), null);
});

test('gray4 is spelled grayscale4 for the firmware, and a column offset rides along', () => {
  const display = (panel) => buildMarqueeConfig({ panel }).display;
  const base = panelFromPreset('magtag');
  assert.equal(display({ ...base, mode: 'gray4' }).mode, 'grayscale4');
  assert.equal(display({ ...base, colstart: -8 }).colstart, -8);
  assert.equal('colstart' in display({ ...base, colstart: 0 }), false);
});

test('no panel yet: display and interface stay null, and nothing is undefined', () => {
  const cfg = buildMarqueeConfig();
  assert.equal(cfg.display, null);
  assert.equal(cfg.interface, null);
  assert.deepEqual(cfg.network, { wifi_ssid: '', wifi_password: '' });
  assert.deepEqual(cfg.adafruit_io, { username: '', key: '' });
});

test('pins: D-prefixed or bare numbers, anything else is not wired', () => {
  assert.deepEqual(['D8', '8', 'd8', '-1', '', 'A3', null].map(pinToInt), [8, 8, 8, -1, -1, -1, -1]);
});
