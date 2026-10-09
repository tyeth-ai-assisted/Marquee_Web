/**
 * A4 — pick the device.
 *
 * Product cards, not a dropdown of driver chips. Choosing a card applies the whole
 * preset — resolution, rotation, colour mode, driver, panel id and every SPI pin — so
 * nothing downstream has to ask about hardware again.
 *
 * Cards come from FEATURED_KEYS. The catalog in presets.js is longer and every entry
 * in it still works; these are the ones this flow can take someone through end to end.
 * A device migrated from an older build pointed at one of the others keeps running,
 * because nothing reads the featured list at runtime.
 *
 * The card copy comes from cardLabel/cardMeta where a preset defines them, because the
 * name on the box and the panel this descriptor drives are not always the same string —
 * the tri-color card names its host board's PSRAM, which no panel descriptor knows
 * about.
 *
 * The photo is the preset's product shot (presets.js `photo`, a file under
 * public/img/panels/). A preset without one falls back to the grey placeholder.
 */

import { FEATURED_KEYS, searchPresets, presetCardLabel, presetCardMeta, presetCardPhoto } from '../device/presets.js';
import { applyDisplayPreset } from '../core/config.js';
import { getState, setState } from '../core/state.js';
import { navigate } from '../core/router.js';
import { activeDeviceId, patchActive, setSetupStep } from '../device/devices.js';
import { $, escapeHtml, escapeAttr, show, toast } from '../core/util.js';

function cardHTML(key, selected) {
  const photo = presetCardPhoto(key);
  // The <img> is decorative: the card's name and spec already say what it is.
  const photoHTML = photo
    ? `<span class="photo"><img src="${escapeAttr(photo)}" alt="" loading="lazy" decoding="async"></span>`
    : '<span class="photo">PHOTO</span>';
  return `<button type="button" class="panel-card card" data-preset="${escapeAttr(key)}" data-selected="${selected}">
    ${photoHTML}
    <span class="body">
      <span class="name">${escapeHtml(presetCardLabel(key))}</span>
      <span class="spec">${escapeHtml(presetCardMeta(key))}</span>
      ${selected ? '<span class="tag tag-accent">Selected</span>' : ''}
    </span>
  </button>`;
}

function renderGrid() {
  const q = $('panelSearch').value || '';
  const keys = searchPresets(q, FEATURED_KEYS);
  const sel = getState().selectedPanel;
  $('panelGrid').innerHTML = keys.map((k) => cardHTML(k, k === sel)).join('');
  show($('panelEmpty'), keys.length === 0);
  $('a4Next').disabled = !sel;
}

export function initA4({ onEnter }) {
  $('panelSearch').addEventListener('input', renderGrid);

  $('panelGrid').addEventListener('click', (e) => {
    const card = e.target.closest('.panel-card');
    if (!card) return;
    const key = card.dataset.preset;
    setState({ selectedPanel: key });
    // Onto the record as well as into flow state, so A1 can put the hardware line on
    // this device's tile without activating it — and so an abandoned draft that DID
    // get this far is recognisable as one worth keeping.
    patchActive({ flow: { ...getState(), selectedPanel: key } });
    // Apply silently — the card going "Selected" already says what happened, and a
    // toast on every card click would be noise while comparing panels.
    applyDisplayPreset(key, { silent: true });
    renderGrid();
  });

  $('a4Back').addEventListener('click', () => navigate('a1'));

  $('a4Next').addEventListener('click', () => {
    if (!getState().selectedPanel) { toast('Choose a device first'); return; }
    const id = activeDeviceId();
    if (id) setSetupStep(id, 'a5b');
    navigate('a5b');
  });

  onEnter('a4', renderGrid);
}
