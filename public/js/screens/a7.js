/**
 * A7 — Act II: build the scene.
 *
 * The editor chrome: the toolbox, the preview controls, the zoom bar and the
 * refresh interval. The canvas itself is stage.js, the inspector is
 * selection.js, and the push action is device.js — this module is only the
 * wiring between them and the screen.
 */

import { initAlbumBuilder, openAlbumBuilder } from '../albums/builder.js';
import { editorOpts, drawGrid, applyZoom, fitZoom, zoom, showDitherPreview, hideDitherPreview, ditherPreviewOn, syncDitherPreviewBtn } from '../canvas/stage.js';
import { select, refreshProps, duplicateSelected } from '../canvas/selection.js';
import {
  addLabel, addDivider, addLineChart, addGauge, addIndicator, addBattery, addDatetime,
  loadImageFile, applyTemplate,
} from '../canvas/elements.js';
import { display } from '../canvas/palette.js';
import { refreshFeedElements, openFeedPicker } from '../device/feeds.js';
import { refreshInterval, sleepModeFor } from '../core/config.js';
import { getState, subscribe } from '../core/state.js';
import { $, $$, show, fmtInterval, toast } from '../core/util.js';

/**
 * Options offered by "Wake and redraw", in seconds. Must match the option values
 * in index.html — anything not in here renders as "Custom — Ns".
 *
 * A minute at a time through the light-sleep range, then coarsening once the
 * intervals are long enough that a minute stops being the difference. The
 * sub-minute steps are gone: they were the only options that could not survive a
 * take, since a panel refresh alone runs to two minutes on some drivers, so a
 * 15-second cycle described a board that would still be redrawing when its own
 * alarm came due. There is no longer an escape hatch for one either — the Settings
 * modal that held the numeric field has no entry point — so "Custom" is now purely
 * how a value inherited from an older build gets named.
 */
const INTERVAL_OPTIONS = [60, 120, 180, 240, 300, 600, 900, 1800, 2700, 3600];

/**
 * What the push actually does: two feed writes the board collects on its own
 * schedule. Nothing here ever hears back, and the cue says so rather than implying
 * a handshake.
 *
 * No "It's showtime —" any more. In the old push block that opening earned its
 * place: the caption sat above a button at the foot of a settings rail and had to
 * announce what the block was. In the action bar the button is a foot away on the
 * same line and says PUSH TO DISPLAY on its face, so the flourish was the sentence
 * repeating the row it sits in.
 */
const PUSH_CUE = 'The dashboard and the sleep window go to Adafruit IO, and the board collects them on its next wake.';

/**
 * The same block while the display is ASLEEP — reached by editing the dashboard
 * from Act III, or by any edit made mid-cycle.
 *
 * A sleeping panel has nothing listening, so "Push to display" would offer
 * something the hardware cannot do right now. The button becomes the queue, and
 * the cue says which wake the edit lands on.
 */
const SLEEP_CUE = 'The display is sleeping — this edit goes to Adafruit IO, and the board collects it on its next wake.';

const PUSH_LABEL = 'Push to display';
const QUEUE_LABEL = 'Queue for the next take';

/**
 * The button carries four blueprint corner <i>s, so its label lives on a text
 * node — assigning textContent would delete them.
 */
function setPushLabel(text) {
  const btn = $('sendBmpSleep');
  if (!btn) return;
  const node = [...btn.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
  if (node) node.textContent = text;
  else btn.insertBefore(document.createTextNode(text), btn.firstChild);
}

/**
 * The push block reads the device: awake it pushes, asleep it queues. Cue and
 * label are set together so the sentence above the button always describes the
 * button — exported because device.js restores the label after a push.
 */
export function syncPushBlock() {
  const asleep = getState().deviceState === 'asleep';
  const cue = $('pushCue');
  if (cue) cue.textContent = asleep ? SLEEP_CUE : PUSH_CUE;
  setPushLabel(asleep ? QUEUE_LABEL : PUSH_LABEL);
}

/**
 * The inspector's interval select and the hidden #sleepDuration field are two views
 * of one value (the sleep timer). The select drives the field so every existing
 * consumer — the published sleep window, the modelled cycle — keeps reading it from
 * the same place. The select is now the only view a user can reach.
 *
 * Exported because a device switch replaces the field's value wholesale, with no input
 * event to notice it — main.js pulls the chip and the select back into agreement as
 * part of the rehydrate sequence.
 */
export function syncIntervalFromField() {
  const secs = refreshInterval();
  const sel = $('wakeInterval');
  if (!sel) return;
  sel.value = INTERVAL_OPTIONS.includes(secs) ? String(secs) : 'custom';
  if (sel.value === 'custom') {
    // Name the value rather than leaving a bare "Custom…" that hides what the
    // device is actually doing — and name the sleep mode with it, the way the
    // fixed options in index.html do. Without this a custom interval would be the
    // one setting that hides which side of the five-minute line it falls on.
    const opt = sel.querySelector('option[value="custom"]');
    const mode = sleepModeFor(secs);
    if (opt) opt.textContent = `Custom — ${fmtInterval(secs)} · ${mode} sleep`;
  }
  syncSleepChip();
}

/**
 * The cadence as a phrase rather than a duration — "every minute", not "1 minute".
 *
 * fmtInterval() is the right thing everywhere it is already used, where the number
 * IS the subject ("sleeping a total of 5 minutes"). Here the subject is the rhythm,
 * and "every 1 minute" and "every 1 hour" are the two places a bare count reads as
 * a translation. Both are exactly the singular cases, which is why they are the
 * only two named.
 */
function intervalPhrase(secs) {
  if (secs === 60) return 'every minute';
  if (secs === 3600) return 'every hour';
  return `every ${fmtInterval(secs)}`;
}

/**
 * The chip's resting text: what the board will do, in one line, without opening
 * anything. Read from the interval select rather than from state, because it is the
 * control the popover edits and this has to be true the instant it changes.
 *
 * The wake source is always the timer — the editor publishes `alarm_type: "timer"`
 * unconditionally (device.js#currentSleepPayload) — so the chip names it as a fixed
 * word and the cadence is the whole variable part.
 */
function syncSleepChip() {
  const el = $('sleepChipValue');
  if (!el) return;
  el.textContent = `Timer · ${intervalPhrase(refreshInterval())}`;
}

// ---------- rotation ----------------------------------------------------------

/**
 * The inspector's rotation select is a view onto #rotSel, the descriptor field.
 * It is read from `display` rather than kept in step by events, because a preset
 * load and a device switch both set #rotSel programmatically and fire nothing —
 * both reach this screen through onEnter, which is where this runs.
 */
function syncSceneRot() {
  const sel = $('sceneRot');
  if (sel) sel.value = String(display.rotation);
}

/**
 * The editor never reads cfg-marquee.json back off the board, so it cannot know
 * whether the file agrees. Changing rotation here only changes the shape of the
 * bitmap we send — the board still applies the rotation in its own file on top —
 * so the confirm names the exact value the file has to carry.
 */
function onSceneRotChange(e) {
  const deg = +e.target.value;
  if (!confirm(`Rotate the canvas to ${deg}°?\n\n`
    + 'The board draws using the rotation in its own cfg-marquee.json, not this setting. '
    + `Check the file on the MARQUEE drive has "rotation": ${deg} under "display", `
    + 'or the dashboard will land sideways or upside down.\n\n'
    + 'Elements keep their positions, so some may end up off the canvas.')) {
    syncSceneRot();
    return;
  }
  // Through #rotSel, so config.js does the rest exactly as it does for the Settings
  // field: re-fit the canvas, persist to the device record, and rebuild rec.cfg.
  const rot = $('rotSel');
  rot.value = String(deg);
  rot.dispatchEvent(new Event('change', { bubbles: true }));
}

// ---------- the popovers ------------------------------------------------------

/**
 * Two of them on this screen — sleep in the action bar, dither under the canvas —
 * and they are the same object: a chip that states a setting, and a panel that
 * edits it.
 *
 * A popover, not a modal: the canvas behind it stays live and the page does not
 * lock. So it closes on the two gestures that mean "I am done here" — a click
 * outside it and Escape — and hands focus back to the chip on the way out, or a
 * keyboard user is dropped at the top of the document every time they set an
 * interval.
 */
function popover(popId, chipId) {
  const isOpen = () => !$(popId)?.classList.contains('hidden');

  function set(open, { restoreFocus = true } = {}) {
    const pop = $(popId);
    const chip = $(chipId);
    if (!pop || !chip) return;
    const was = isOpen();
    show(pop, open);
    chip.setAttribute('aria-expanded', String(open));
    // The first VISIBLE control, not simply the first: focusing a display:none
    // element is a silent no-op that would leave the panel opened onto nothing for
    // a keyboard user.
    if (open) {
      [...pop.querySelectorAll('select, input, button')].find((el) => el.offsetParent)?.focus();
    // Only when the popover was actually open: calling this on a stray outside click
    // would steal focus from whatever the user just clicked on the canvas.
    } else if (was && restoreFocus) chip.focus();
  }

  return { chipId, popId, isOpen, set };
}

const POPOVERS = [popover('sleepPop', 'sleepChip'), popover('ditherPop', 'ditherChip')];

/**
 * Opening one closes the other. They sit at opposite ends of the screen and both
 * hang over the canvas, so two at once is two panels covering the artwork the
 * dither panel exists to let you look at.
 */
function togglePopover(target) {
  const open = !target.isOpen();
  POPOVERS.forEach((p) => { if (p !== target && p.isOpen()) p.set(false, { restoreFocus: false }); });
  target.set(open);
}

function closeAllPopovers(opts) {
  POPOVERS.forEach((p) => { if (p.isOpen()) p.set(false, opts); });
}

export function initA7({ onEnter }) {
  initAlbumBuilder();
  $('addAlbumBtn').addEventListener('click', () => openAlbumBuilder());
  // ---- toolbox ----
  $('addLabel').addEventListener('click', () => select(addLabel()));
  $('addDivider').addEventListener('click', () => select(addDivider()));
  $('addChart').addEventListener('click', () => select(addLineChart()));
  $('addGaugeBtn').addEventListener('click', () => select(addGauge()));
  $('addIndicatorBtn').addEventListener('click', () => select(addIndicator()));
  $('addBatteryBtn').addEventListener('click', () => select(addBattery()));
  // Dropped showing its preset's example, then read straight away so the canvas shows
  // what IO will render. A failed read leaves the example and says why.
  $('addDatetimeBtn').addEventListener('click', async () => {
    const node = addDatetime();
    select(node);
    const ok = await refreshFeedElements([node]);
    refreshProps();
    if (!ok) toast('Could not read the time from Adafruit IO');
  });
  $('duplicateBtn').addEventListener('click', duplicateSelected);
  $('addImageBtn').addEventListener('click', () => $('imgInput').click());
  // A picture from a feed. The picker is the whole flow: it checks the feed's value is
  // an image, drops the frame, and decodes the first reading into it.
  $('addFeedImageBtn').addEventListener('click', () => openFeedPicker(null, { mode: 'image' }));
  $('imgInput').addEventListener('change', (e) => {
    loadImageFile(e.target.files[0]);
    e.target.value = '';
  });

  $$('[data-template]').forEach((btn) =>
    btn.addEventListener('click', () => applyTemplate(btn.dataset.template)));

  // ---- preview controls ----
  $('btnDitherPreview').addEventListener('click', () => {
    // A toggle: the first click renders the dithered overlay through the
    // authoritative pipeline, the second clears it. It persists across edits.
    if (ditherPreviewOn) hideDitherPreview();
    else showDitherPreview();
  });
  $('gridToggle').addEventListener('change', (e) => { editorOpts.grid = e.target.checked; drawGrid(); });
  $('snapToggle').addEventListener('change', (e) => { editorOpts.snap = e.target.checked; });
  $('gridSize').addEventListener('change', (e) => { editorOpts.gridSize = +e.target.value; drawGrid(); });

  // ---- zoom ----
  $('zoomIn').addEventListener('click', () => applyZoom(zoom * 1.25));
  $('zoomOut').addEventListener('click', () => applyZoom(zoom / 1.25));
  $('zoomFit').addEventListener('click', fitZoom);
  window.addEventListener('resize', () => {
    if (document.querySelector('#a7[data-active="true"]')) fitZoom();
  });

  // ---- refresh interval ----
  // No 'custom' guard: that option is `hidden` in index.html, so it is a readout
  // syncIntervalFromField() writes and never a value this event can carry.
  $('wakeInterval').addEventListener('change', (e) => {
    const field = $('sleepDuration');
    field.value = e.target.value;
    // Dispatch so config.js persists it and any live cycle re-registers.
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  $('sleepDuration').addEventListener('input', syncIntervalFromField);

  // ---- rotation ----
  $('sceneRot').addEventListener('change', onSceneRotChange);

  // ---- the popovers ----
  POPOVERS.forEach((p) => $(p.chipId).addEventListener('click', () => togglePopover(p)));

  // Pointerdown rather than click, so the popover is already gone by the time a
  // press lands on the canvas — closing on click would let the same gesture both
  // dismiss the panel and start a drag under it.
  document.addEventListener('pointerdown', (e) => {
    POPOVERS.forEach((p) => {
      if (!p.isOpen()) return;
      if (e.target.closest(`#${p.popId}, #${p.chipId}`)) return;
      p.set(false, { restoreFocus: false });
    });
  });

  // Nothing to guard against here: the shared modal handler in util.js only fires
  // when a modal is actually open, and the editor's own key handler drops out on
  // any focused field — which is where focus is whenever one of these is up.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') POPOVERS.forEach((p) => { if (p.isOpen()) p.set(false); });
  });

  syncIntervalFromField();
  syncDitherPreviewBtn();
  syncPushBlock();
  syncSleepChip();
  syncSceneRot();

  // The board can fall asleep while this screen is still open — a cycle started
  // here never leaves it — so the push block follows the device rather than only
  // being read on entry.
  subscribe((_st, patch) => {
    if ('deviceState' in patch) syncPushBlock();
  });

  onEnter('a7', () => {
    // The canvas ground has no size until this screen is visible, so the first
    // real fit has to happen here rather than at boot.
    fitZoom();
    refreshProps();
    // Leaving the screen with a panel up hides it with #a7, but does not close
    // it — so coming back would land on an open popover nobody asked for.
    closeAllPopovers({ restoreFocus: false });
    syncIntervalFromField();
    syncPushBlock();
    syncSceneRot();
  });
}
