/**
 * The display descriptor: the panel form, its persistence, and the presets that
 * fill it. The firmware-facing assembly of these fields is device/cfg.js.
 *
 * These fields physically live inside A5's advanced disclosure, but they are
 * read from A7 and A8 too — which is why every screen stays mounted. Nothing
 * here caches an element reference across a screen change, and nothing here
 * assumes A5 is visible.
 */

import { display, logicalDims, landscapeAtZero, ditherLabel, ditherChipLabel } from '../canvas/palette.js';
import { fitZoom, updateDims, suspendDitherPreview, scheduleDitherRefresh } from '../canvas/stage.js';
import { remapColorsToPalette } from '../canvas/elements.js';
import { refreshProps } from '../canvas/selection.js';
import { DISPLAY_PRESETS, PRESET_KEYS } from '../device/presets.js';
import { getState, setState } from './state.js';
import { patchActive } from '../device/devices.js';
import { syncCfg } from '../device/cfg.js';
import { $, $$, val, segValue, setSegValue, show, toast, fmtInterval } from './util.js';

const DISPLAY_CONFIG_KEY = 'marquee.displayConfig';

/**
 * Every input whose value is part of the descriptor or the render settings. The
 * pins and identity are NOT in canvas.json, so this list is the only thing that
 * carries a re-pin through to persistence and to the broker.
 */
const CONFIG_FIELDS = [
  'marqueeName', 'preset', 'resW', 'resH', 'rotSel', 'dtype',
  'pmName', 'pmDriver', 'pmPanel', 'pmColstart',
  'pinBusy', 'pinDc', 'pinRst', 'pinCs', 'pinSramCs', 'pinMosi', 'pinSck', 'spiBus',
  'diffusion', 'orderedMap',
];

const DITHER_HINTS = {
  FloydSteinberg: 'Error diffusion — best for photos and gradients. Tune diffusion to taste between "too contrasty" (lower) and "too snowy" (higher).',
  ordered: 'Structured Bayer pattern. Not ideal for photos — it tends to lose edge detail — but gives a clean look for flat artwork and diagrams. Smaller maps give a coarser texture.',
  none: 'No dithering — each pixel snaps to the nearest palette colour. Good for logos, high-contrast line art and bold flat graphics.',
};

/** The sleep timer, in seconds. The design calls this the refresh interval. */
export function refreshInterval() {
  return Math.max(0, parseInt($('sleepDuration')?.value, 10) || 0);
}

/** Sleep mode derives from the interval — see device/schedule.js, which owns the
 *  threshold and the payload so the A1 tiles can build one without importing the editor.
 *  Re-exported here because the editor has always read them from this module. */
export { DEEP_SLEEP_THRESHOLD_SECS, sleepModeFor } from '../device/schedule.js';

// ---------- resolution / orientation ----------------------------------------

export function setResolution(w, h) {
  display.width = w;
  display.height = h;
  if ($('resW')) $('resW').value = w;
  if ($('resH')) $('resH').value = h;
  // Drop any dither overlay before re-fitting: it's a bitmap of the previous
  // dimensions and would be stretched to the new aspect ratio.
  suspendDitherPreview();
  fitZoom();
  refreshProps();
  scheduleDitherRefresh();
}

/** Landscape when the panel is wider than tall AS ORIENTED. */
function currentOrientation() {
  const { w, h } = logicalDims();
  return w >= h ? 'landscape' : 'portrait';
}

/**
 * Orientation is a view onto rotation, not a separate field — which keeps a
 * portrait-native framebuffer (the quad-color panel) honest: its "landscape" is
 * rotation 270, not rotation 0.
 *
 * Two of the four rotations are landscape and two are portrait, so "flip" is
 * ambiguous unless we remember which one we came from. Blindly adding 90° each
 * time makes the control non-reversible: landscape → portrait → landscape would
 * land on 180° instead of back at 0°, quietly turning the panel upside down and
 * making it look like the user had diverged from their preset.
 */
const lastRotationFor = { landscape: null, portrait: null };

function setOrientation(want) {
  const from = currentOrientation();
  if (from === want) return;
  lastRotationFor[from] = display.rotation;
  display.rotation = lastRotationFor[want] ?? (display.rotation + 90) % 360;
  if ($('rotSel')) $('rotSel').value = String(display.rotation);
  afterGeometryChange();
}

function afterGeometryChange() {
  suspendDitherPreview();  // rotation swaps w/h — the old bitmap no longer fits
  fitZoom();
  refreshProps();
  scheduleDitherRefresh();
  syncDerivedUI();
}

// ---------- presets ---------------------------------------------------------

/** A preset's `colstart` as the form spells it: the empty string when it has none. */
function colstartField(p) {
  return p.colstart === undefined || p.colstart === null ? '' : String(p.colstart);
}

/**
 * True while the form still holds exactly what this preset fills in.
 *
 * `colstart` is optional in the catalog — most panels have no column offset to
 * state — so its absence has to compare equal to the empty field applyDisplayPreset
 * leaves behind, not to the string "undefined".
 */
export function presetMatchesForm(p) {
  const g = (id) => ($(id)?.value || '');
  return g('preset') === p.preset && g('rotSel') === String(p.rotation)
    && g('dtype') === p.mode && g('pmName') === p.name && g('pmDriver') === p.driver
    && g('pmPanel') === p.panel && g('pmColstart') === colstartField(p)
    && g('pinBusy') === p.pins.busy && g('pinDc') === p.pins.dc
    && g('pinRst') === p.pins.rst && g('pinCs') === p.pins.cs && g('pinSramCs') === p.pins.sramCs
    && g('pinMosi') === p.pins.mosi && g('pinSck') === p.pins.sck && g('spiBus') === String(p.pins.bus);
}

/** The preset key the form currently matches exactly, or null. */
export function matchingPresetKey() {
  return PRESET_KEYS.find((k) => presetMatchesForm(DISPLAY_PRESETS[k])) || null;
}

/**
 * Non-empty overrides mean the user has diverged from the chosen preset, which
 * is what makes "Reset to preset" live.
 */
export function hasOverrides() {
  const key = getState().selectedPanel;
  return !!key && !presetMatchesForm(DISPLAY_PRESETS[key]);
}

export function applyDisplayPreset(key, { silent = false } = {}) {
  const p = DISPLAY_PRESETS[key];
  if (!p) return;

  $('preset').value = p.preset;
  show($('customRes'), false);
  const [w, h] = p.preset.split('x').map(Number);

  $('rotSel').value = p.rotation;
  display.rotation = +p.rotation;
  $('dtype').value = p.mode;
  display.type = p.mode;

  $('pmName').value = p.name;
  $('pmDriver').value = p.driver;
  $('pmPanel').value = p.panel;
  display.panel = p.panel;
  // Blanked, not zeroed, for a preset with no offset — see colstartField().
  $('pmColstart').value = colstartField(p);

  $('pinBusy').value = p.pins.busy;
  $('pinDc').value = p.pins.dc;
  $('pinRst').value = p.pins.rst;
  $('pinCs').value = p.pins.cs;
  $('pinSramCs').value = p.pins.sramCs;
  $('pinMosi').value = p.pins.mosi;
  $('pinSck').value = p.pins.sck;
  $('spiBus').value = p.pins.bus;

  // Re-apply to the editor the same way the individual change handlers do.
  setResolution(w, h);
  remapColorsToPalette();
  updateDims();
  refreshProps();
  // A preset fills fields programmatically, so no input event fires — persist
  // and re-derive explicitly.
  saveConfig();
  syncDerivedUI();
  if (!silent) toast(`Loaded the ${p.label} preset`);
}

// ---------- persistence -----------------------------------------------------

/**
 * The descriptor form as a plain object — the whole of what persistence stores.
 *
 * Exported separately from saveConfig() because the descriptor is per-device now:
 * devices.js snapshots it into the outgoing device's record on a switch, and never
 * touches the single localStorage key that saveConfig() writes.
 *
 * Note `marqueeName` rides in CONFIG_FIELDS rather than in the settings blob, which
 * makes it the odd one out: it is the A1 tile title and the seed for A5b's group key,
 * so it is the most user-visible per-device field in the app, living in the store you
 * would look in last.
 */
export function snapshotConfig() {
  const data = { dmode: segValue('ditherSeg') || 'FloydSteinberg' };
  CONFIG_FIELDS.forEach((id) => { if ($(id)) data[id] = $(id).value; });
  return data;
}

/**
 * Persist the descriptor — to the active device's record first, and to the legacy
 * single key after.
 *
 * The record is the one that matters: the descriptor is per-device, and it carries
 * `marqueeName`, which is what A1 titles a tile with and what the chrome crumb reads.
 * Without this write the record only picked the descriptor up on a device SWITCH, so a
 * board stayed "Untitled display" on the list until you had opened another one and come
 * back — the name was correct everywhere except the screen you would look at first.
 *
 * DISPLAY_CONFIG_KEY is still written so a downgrade finds a bench setup where it left
 * it, and so devices.js#migrate() has something to read on a profile that has never run
 * this build.
 */
function saveConfig() {
  const data = snapshotConfig();
  patchActive({ displayConfig: data });
  // The descriptor just changed, so the file the board will read has too. cfg.js
  // rebuilds it from these same fields; this is the call that keeps rec.cfg current
  // through A4's preset click and every re-pin in Settings.
  syncCfg();
  try { localStorage.setItem(DISPLAY_CONFIG_KEY, JSON.stringify(data)); } catch { /* storage disabled/full */ }
}

/**
 * Push the `display` object back out to the form. Used after deserialize(),
 * which loads a document carrying its own display block.
 */
export function applyDisplayToForm() {
  if ($('dtype')) $('dtype').value = display.type;
  if ($('rotSel')) $('rotSel').value = String(display.rotation);
  if ($('pmPanel') && typeof display.panel === 'string' && display.panel) $('pmPanel').value = display.panel;
  if ($('diffusion')) $('diffusion').value = display.diffusion;
  if ($('orderedMap')) $('orderedMap').value = String(display.orderedMap);
  setSegValue('ditherSeg', display.dither);
  const label = $('diffusionLabel');
  if (label) label.textContent = display.diffusion + '%';
  // A loaded document's resolution rarely matches a named option.
  if ($('preset')) $('preset').value = 'custom';
  show($('customRes'), true);
  syncDitherControls();
  syncDerivedUI();
}

/**
 * Setting an input's .value doesn't fire its change handler, so after filling
 * the fields we rebuild the `display` object and refresh the canvas the same way
 * the individual handlers do.
 */
function applyRestoredConfig() {
  show($('customRes'), $('preset').value === 'custom');
  // resW/resH always track the true resolution (setResolution keeps them in sync).
  display.width = +$('resW').value || display.width;
  display.height = +$('resH').value || display.height;
  display.rotation = +$('rotSel').value || 0;
  display.panel = $('pmPanel')?.value || '';
  display.type = $('dtype').value;
  display.dither = segValue('ditherSeg') || 'FloydSteinberg';
  display.diffusion = +$('diffusion').value;
  display.orderedMap = +$('orderedMap').value;
  $('diffusionLabel').textContent = display.diffusion + '%';
  syncDitherControls();
  remapColorsToPalette();
  fitZoom();
  updateDims();
  refreshProps();
  syncDerivedUI();
}

/**
 * Install a descriptor snapshot into the form and rebuild everything derived from it.
 *
 * The load half of a device switch. `null` means "this device has no descriptor of its
 * own yet" — a fresh draft — and leaves the form as it stands, which is the MagTag seed
 * in palette.js plus whatever A4's preset click has already applied.
 *
 * ORDERING, and it is load-bearing: this must run BEFORE the incoming canvas is
 * deserialized. applyRestoredConfig() ends in remapColorsToPalette(), which rewrites
 * every element's fill against the CURRENT palette — run it after the deserialize and
 * the incoming artwork gets remapped against the outgoing board's colour space.
 */
/** Panel ids this editor used to write, and what the firmware's EPD factory calls them
 *  now. Applied on load so a record saved under the old name does not hand the board a
 *  panel it rejects (ERR_EPD_PANEL_UNSUPPORTED). */
const PANEL_RENAMES = { 'adafruit-magtag': 'magtag', 'magtag-2025': 'magtag' };

export function loadConfig(data) {
  if (!data || typeof data !== 'object') { applyRestoredConfig(); return; }
  CONFIG_FIELDS.forEach((id) => {
    if ($(id) && typeof data[id] === 'string') $(id).value = data[id];
  });
  if (PANEL_RENAMES[$('pmPanel')?.value]) $('pmPanel').value = PANEL_RENAMES[$('pmPanel').value];
  if (typeof data.dmode === 'string') setSegValue('ditherSeg', data.dmode);
  applyRestoredConfig();
}

function restoreConfig() {
  let data = {};
  try { data = JSON.parse(localStorage.getItem(DISPLAY_CONFIG_KEY) || '{}') || {}; } catch { /* corrupt/blocked */ }
  loadConfig(data);
}

/**
 * Adopt a set of dither settings — an imported document's — without touching the rest
 * of the descriptor. Not applyDisplayToForm(), which also forces the resolution preset
 * to "custom" and would read as the user having diverged from their panel.
 */
export function applyDither({ dither, diffusion, orderedMap }) {
  if (dither) display.dither = dither;
  if (Number.isFinite(diffusion)) display.diffusion = diffusion;
  if (Number.isFinite(orderedMap)) display.orderedMap = orderedMap;
  setSegValue('ditherSeg', display.dither);
  if ($('diffusion')) $('diffusion').value = display.diffusion;
  if ($('orderedMap')) $('orderedMap').value = String(display.orderedMap);
  if ($('diffusionLabel')) $('diffusionLabel').textContent = display.diffusion + '%';
  syncDitherControls();
  saveConfig();
  scheduleDitherRefresh();
}

// ---------- derived UI ------------------------------------------------------

function syncDitherControls() {
  const m = display.dither;
  show($('diffusionRow'), m === 'FloydSteinberg');
  show($('orderedRow'), m === 'ordered');
  const hint = $('ditherHint');
  if (hint) hint.textContent = DITHER_HINTS[m] || '';
  syncDitherChip();
}

/**
 * The trigger states the setting at rest, so it has to follow every control
 * inside the popover — including the slider, which changes the label without
 * changing the algorithm.
 */
function syncDitherChip() {
  const el = $('ditherChipValue');
  if (el) el.textContent = ditherChipLabel();
}

/** The orientation control, the preset chips and the dimension readouts. */
export function syncDerivedUI() {
  setSegValue('orientSeg', currentOrientation());

  $$('#presetRow .preset-chip').forEach((chip) => {
    chip.dataset.active = String(presetMatchesForm(DISPLAY_PRESETS[chip.dataset.preset]));
  });

  const reset = $('resetToPreset');
  if (reset) reset.disabled = !hasOverrides();

  updateDims();
}

// ---------- boot ------------------------------------------------------------

export function initConfig() {
  // Preset chips inside the advanced disclosure.
  const row = $('presetRow');
  if (row) {
    row.innerHTML = PRESET_KEYS.map((k) =>
      `<button type="button" class="btn btn-sm preset-chip" data-preset="${k}" data-active="false">${DISPLAY_PRESETS[k].label}</button>`
    ).join('');
    row.addEventListener('click', (e) => {
      const chip = e.target.closest('.preset-chip');
      if (!chip) return;
      setState({ selectedPanel: chip.dataset.preset });
      applyDisplayPreset(chip.dataset.preset);
    });
  }

  $('resetToPreset')?.addEventListener('click', () => {
    const key = getState().selectedPanel;
    if (!key) return;
    applyDisplayPreset(key, { silent: true });
    toast(`Reset to the ${DISPLAY_PRESETS[key].label} preset`);
  });

  // Resolution.
  $('preset')?.addEventListener('change', (e) => {
    if (e.target.value === 'custom') { show($('customRes'), true); return; }
    show($('customRes'), false);
    const [w, h] = e.target.value.split('x').map(Number);
    setResolution(w, h);
    syncDerivedUI();
  });
  ['resW', 'resH'].forEach((id) => $(id)?.addEventListener('change', () => {
    $('preset').value = 'custom';
    setResolution(+$('resW').value || 8, +$('resH').value || 8);
    syncDerivedUI();
  }));

  // Rotation and orientation are two views on the same value.
  $('rotSel')?.addEventListener('change', (e) => {
    display.rotation = +e.target.value;
    // An explicit rotation supersedes whatever the orientation toggle last
    // remembered, or a later flip would drag the panel back to a rotation the
    // user has since rejected.
    lastRotationFor.landscape = null;
    lastRotationFor.portrait = null;
    afterGeometryChange();
  });
  $('orientSeg')?.addEventListener('change', (e) => setOrientation(e.target.value));

  // Color mode. Existing elements are snapped onto the new palette immediately:
  // leaving off-palette colors would let the dither shift them silently later.
  $('dtype')?.addEventListener('change', (e) => {
    display.type = e.target.value;
    remapColorsToPalette();
    updateDims();
    refreshProps();
    scheduleDitherRefresh();
    syncDerivedUI();
  });

  // Dither. Every control here feeds the render pipeline, so a live preview goes
  // stale the moment one changes — re-run it in place rather than making the
  // user toggle the button twice. The overlay keeps showing the previous dither
  // until the new one lands; no flash back to the undithered stage, since the
  // geometry isn't what changed.
  $('ditherSeg')?.addEventListener('change', () => {
    display.dither = segValue('ditherSeg') || 'FloydSteinberg';
    // syncDitherControls() carries the trigger's label with it; the readout beside
    // it names geometry only, so nothing here touches updateDims().
    syncDitherControls();
    scheduleDitherRefresh();
  });
  $('diffusion')?.addEventListener('input', (e) => {
    display.diffusion = +e.target.value;
    $('diffusionLabel').textContent = e.target.value + '%';
    syncDitherChip();
    scheduleDitherRefresh(350);  // the slider fires continuously — let it settle
  });
  $('orderedMap')?.addEventListener('change', (e) => {
    display.orderedMap = +e.target.value;
    syncDitherChip();
    scheduleDitherRefresh();
  });

  restoreConfig();

  // The panel id decides what rotation 0 looks like (palette.js
  // LANDSCAPE_AT_ZERO_PANELS), so retyping it can turn the canvas on its side.
  $('pmPanel')?.addEventListener('change', () => {
    const was = landscapeAtZero();
    display.panel = val('pmPanel');
    if (landscapeAtZero() !== was) { afterGeometryChange(); updateDims(); }
  });

  // One persistence hook across every descriptor field.
  [...CONFIG_FIELDS, 'ditherSeg'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    const onEdit = () => { saveConfig(); syncDerivedUI(); };
    el.addEventListener('input', onEdit);
    el.addEventListener('change', onEdit);
  });

  syncDerivedUI();
}

/** Human summary of the current refresh interval, for the A8 sleep bar. */
export function refreshIntervalLabel() {
  return fmtInterval(refreshInterval());
}

/** Re-exported so screens can render the dither state without importing palette. */
export { ditherLabel };
