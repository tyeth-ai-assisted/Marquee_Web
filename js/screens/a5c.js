/**
 * A5C — Wi-Fi credentials.
 *
 * The network name and password the board will join. They are saved on this display's
 * record — `cfg.network`, via device/cfg.js — so they survive a reload mid-setup, prefill
 * this screen when setup is run again, and are in the config file A6-A writes without
 * A6-A having to ask.
 *
 * WHAT THE PLATE PROMISES, and what this module holds it to: the credentials go to this
 * browser's localStorage and to the board over USB. They are never published to an
 * Adafruit IO feed and never stored in the account — they are not in SETTINGS_SCOPE, so
 * the settings persistence cannot see them, and cfg.js is the only writer.
 */

import { navigate } from '../core/router.js';
import { setSetupStep, activeDeviceId, activeDevice, isFinished } from '../device/devices.js';
import { openFlash } from './a6a.js';
import { setWifiCredentials, wifiCredentials } from '../device/cfg.js';
import { $, val } from '../core/util.js';

function setMasked() {
  const input = $('a5cPass');
  const btn = $('a5cPassReveal');
  if (input) input.type = 'password';
  if (btn) { btn.textContent = 'Show'; btn.setAttribute('aria-pressed', 'false'); }
}

function syncForm() {
  const ok = !!val('a5cSsid');
  const btn = $('a5cSave');
  if (btn) btn.disabled = !ok;
}

export function initA5c({ onEnter }) {
  ['a5cSsid', 'a5cPass'].forEach((id) => $(id)?.addEventListener('input', syncForm));

  // The password is a long string being typed from memory or a router label, and a
  // masked field with no way to check it is how a board silently fails to associate.
  $('a5cPassReveal')?.addEventListener('click', (e) => {
    const input = $('a5cPass');
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    e.currentTarget.setAttribute('aria-pressed', String(!showing));
    e.currentTarget.textContent = showing ? 'Show' : 'Hide';
  });

  // A finished display came here from its A1 tile, not from A5b, so that is where Back goes.
  $('a5cBack')?.addEventListener('click', () => navigate(isFinished(activeDevice()) ? 'a1' : 'a5b'));

  $('a5cSave')?.addEventListener('click', () => {
    const ssid = val('a5cSsid');
    if (!ssid) return;
    // An open network is a real configuration, so an empty password is allowed through
    // — the button gates on the SSID alone.
    setWifiCredentials({ ssid, password: $('a5cPass')?.value || '' });
    // A finished display only needs the new file on its drive — straight to that stage,
    // with Back returning here rather than to the list.
    if (isFinished(activeDevice())) {
      openFlash({ stage: 'drive', back: 'a5c' });
      return;
    }
    const id = activeDeviceId();
    if (id) setSetupStep(id, 'a6a');
    navigate('a6a');
  });

  onEnter('a5c', () => {
    // Whatever this display already has saved, so a resumed setup — or one run again
    // from Settings — shows the network it is on rather than an empty form.
    const saved = wifiCredentials();
    if ($('a5cSsid')) $('a5cSsid').value = saved?.wifi_ssid || '';
    if ($('a5cPass')) $('a5cPass').value = saved?.wifi_password || '';
    setMasked();
    syncForm();
  });
}
