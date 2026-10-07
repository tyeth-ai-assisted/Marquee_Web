/**
 * The per-display live-updates switch — devices.js#livePaused / #patchSettings.
 *
 * The flag lives on the record, not in the settings form, so it can be flipped from an A1
 * tile for a display that is not the one open. These pin that it defaults to live, that a
 * patch reaches only the record it names, and that flushing the active record's form
 * fields does not wipe it.
 *
 * devices.js reads the settings form through document.getElementById and persists to
 * localStorage, so both are stubbed — as in cfg.test.js — with just enough to load it
 * under plain node. The form is empty, which is the case that matters for flushActive().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = { getElementById: () => null, addEventListener() {} };
const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

const devices = await import('../public/js/device/devices.js');

function freshDisplay() {
  const rec = devices.createDraft();
  devices.promoteDraft(rec.id);
  return devices.getDevice(rec.id);
}

test('a display is live until someone pauses it', () => {
  devices.initDevices();
  const rec = freshDisplay();
  assert.equal(devices.livePaused(rec), false);
  assert.equal(devices.livePaused(null), false);
  assert.equal(devices.livePaused({ settings: {} }), false);
  // Only a real `true` pauses: anything else a hand-edited record carries is live.
  assert.equal(devices.livePaused({ settings: { livePaused: 'true' } }), false);
});

test('pausing one display leaves the others alone, and resumes', () => {
  devices.initDevices();
  const a = freshDisplay();
  const b = freshDisplay();
  devices.patchSettings(a.id, { livePaused: true });
  assert.equal(devices.livePaused(devices.getDevice(a.id)), true);
  assert.equal(devices.livePaused(devices.getDevice(b.id)), false);
  devices.patchSettings(a.id, { livePaused: false });
  assert.equal(devices.livePaused(devices.getDevice(a.id)), false);
  assert.equal(devices.patchSettings('nope', { livePaused: true }), null);
});

test('the switch survives a reload of the store', () => {
  devices.initDevices();
  const rec = freshDisplay();
  devices.patchSettings(rec.id, { livePaused: true });
  devices.initDevices();
  assert.equal(devices.livePaused(devices.getDevice(rec.id)), true);
});

test('a patch keeps the settings it does not name', () => {
  devices.initDevices();
  const rec = freshDisplay();
  devices.patchSettings(rec.id, { sleepDuration: '900' });
  devices.patchSettings(rec.id, { livePaused: true });
  const s = devices.getDevice(rec.id).settings;
  assert.equal(s.sleepDuration, '900');
  assert.equal(s.livePaused, true);
});

test('flushing the active record does not drop the switch', () => {
  devices.initDevices();
  const rec = freshDisplay();
  devices.setActive(rec.id);
  devices.patchSettings(rec.id, { livePaused: true });
  // The form is empty, so flushActive() reads no fields — exactly the case where a rebuild
  // of `settings` from the form alone would lose a field that has no form home.
  devices.flushActive();
  assert.equal(devices.livePaused(devices.getDevice(rec.id)), true);
});
