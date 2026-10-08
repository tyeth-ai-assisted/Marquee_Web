/**
 * The canvas document: serialize / deserialize, autosave, and the signature that
 * answers "has the design changed since the device last drew it?".
 *
 * The layout JSON is the internal source of truth. On every edit we serialize
 * the canvas, show it live under the panel, and persist it to localStorage.
 * Konva fires 'draw' on the content layer after every add, remove,
 * move, transform and attr edit, so one debounced listener captures them all; we
 * de-dupe on the serialized string so pure view changes (zoom, selection,
 * transformer handles) never trigger a write.
 *
 * TWO DESTINATIONS, one authority. localStorage per device is the store and is
 * written first; {group}.canvas-state on Adafruit IO is the copy another machine
 * can open — see
 * canvasfeed.js, which is on a much longer leash than the 400ms debounce here.
 */

import { display, MODE_LABELS } from '../canvas/palette.js';
import { layer, fitZoom, hideDitherPreview } from '../canvas/stage.js';
import { select } from '../canvas/selection.js';
import {
  addLabel, addDivider, addLineChart, addGauge, addIndicator, addBattery, addImage, addDatetime,
  addFeedImage, addCarousel, feedImageSettled, remapColorsToPalette,
} from '../canvas/elements.js';
import { normalizeDatetimeAttrs } from './timefmt.js';
import { applyDisplayToForm, setResolution, applyDither } from './config.js';
import { activeDeviceId, saveCanvas } from '../device/devices.js';
import { scheduleCanvasStatePublish } from '../device/canvasfeed.js';
import { validateCanvasDoc, compareDisplay, fitDoc } from './canvasimport.js';
import {
  $, copyFromButton, toast, escapeHtml, openModal, closeModal, wireModal, segValue, setSegValue, show,
} from './util.js';

export function serialize() {
  return {
    version: 1,
    display: { ...display },
    elements: layer.find('.element').map((n) => {
      const etype = n.getAttr('etype');
      const base = { etype, x: n.x(), y: n.y() };
      if (etype === 'label') {
        Object.assign(base, {
          fill: n.fill(), text: n.text(), fontSize: n.fontSize(),
          fontFamily: n.fontFamily(), align: n.align(),
        });
        if (n.attrs.width !== undefined) base.width = Math.round(n.width());
        // A linked label remembers where its text came from, how it wraps the value,
        // and the sample itself — the last of these is what makes a new reading part
        // of the pushed document rather than a live-only detail.
        if (n.getAttr('feedKey')) {
          base.feedKey = n.getAttr('feedKey');
          base.feedName = n.getAttr('feedName') || '';
          base.feedPrefix = n.getAttr('feedPrefix') || '';
          base.feedSuffix = n.getAttr('feedSuffix') || '';
          base.feedDecimals = n.getAttr('feedDecimals') ?? null;
          base.feedValue = n.getAttr('feedValue') ?? null;
        }
      } else if (etype === 'datetime') {
        // Through the same normalizer the factory uses, so a save and a load agree on
        // every field. `text` is not saved: it is derived from timeValue (or the preset's
        // example), and the factory recomputes it. `width` is left off when auto-sized.
        const a = normalizeDatetimeAttrs({
          timeFmt: n.getAttr('timeFmt'), timeTz: n.getAttr('timeTz'), timeValue: n.getAttr('timeValue'),
          fill: n.fill(), fontSize: n.fontSize(), fontFamily: n.fontFamily(), align: n.align(),
          width: n.attrs.width !== undefined ? n.width() : undefined,
        });
        if (a.width === undefined) delete a.width;
        Object.assign(base, a);
      } else if (etype === 'divider') {
        Object.assign(base, { fill: n.fill(), width: n.width(), height: n.height() });
      } else if (etype === 'image') {
        Object.assign(base, {
          src: n.getAttr('src'), w: Math.round(n.width()), h: Math.round(n.height()),
          natW: n.getAttr('natW'), natH: n.getAttr('natH'),
        });
      } else if (etype === 'carousel') {
        Object.assign(base, {w:n.getAttr('w'),h:n.getAttr('h'),fit:n.getAttr('fit'),items:n.getAttr('items'),albumName:n.getAttr('albumName'),interval:n.getAttr('interval'),order:n.getAttr('order'),seed:n.getAttr('seed'),paused:n.getAttr('paused'),showCaption:n.getAttr('showCaption'),slideIndex:n.getAttr('slideIndex'),shownAt:n.getAttr('shownAt'),src:n.getAttr('src'),natW:n.getAttr('natW'),natH:n.getAttr('natH')});
      } else if (etype === 'feedimage') {
        // The frame and the fit are the design; the picture (src and its natural size)
        // is the last reading, saved for the same reason a label's feedValue is — so a
        // new frame on the feed is part of the pushed document. `imageObj` is the
        // decoded <img> and never leaves the browser; the data URL is enough to get it back.
        Object.assign(base, {
          w: n.getAttr('w'), h: n.getAttr('h'), fit: n.getAttr('fit') || 'contain',
          feedKey: n.getAttr('feedKey') || '', feedName: n.getAttr('feedName') || '',
          src: n.getAttr('src') ?? null,
          natW: n.getAttr('natW') ?? null, natH: n.getAttr('natH') ?? null,
        });
      } else if (etype === 'indicator') {
        // Explicit branch: the generic widget shape below is {ink,title,w}+value,
        // which would drop the feed binding, the condition and the on/off colors.
        // The sampled `value` is included deliberately — it is what makes a state
        // change part of the pushed document rather than a live-only detail.
        Object.assign(base, {
          w: n.getAttr('w'), ink: n.getAttr('ink'),
          onColor: n.getAttr('onColor'), offColor: n.getAttr('offColor'),
          op: n.getAttr('op'), cmp: n.getAttr('cmp'),
          feedKey: n.getAttr('feedKey') || '', feedName: n.getAttr('feedName') || '',
          value: n.getAttr('value') ?? null,
        });
      } else if (etype === 'battery') {
        // Same reasoning as the indicator: the generic widget shape would drop the
        // feed binding, every condition and the default shade. `conds` is copied
        // rather than passed by reference so the saved doc can't alias live attrs.
        Object.assign(base, {
          w: n.getAttr('w'), ink: n.getAttr('ink'),
          showPct: !!n.getAttr('showPct'),
          conds: (n.getAttr('conds') || []).map((c) => ({ op: c.op, cmp: c.cmp, color: c.color })),
          defaultShade: n.getAttr('defaultShade'),
          feedKey: n.getAttr('feedKey') || '', feedName: n.getAttr('feedName') || '',
          feedValue: n.getAttr('feedValue') ?? null,
        });
      } else if (etype === 'gauge') {
        // Explicit, for the reason given on the indicator: the generic widget shape
        // is {ink,title,w}, which would drop the binding, the range, the thresholds
        // and the icon. The bounds and warning values are saved as the RAW authored
        // strings — '' means "not set" and must not round-trip as 0.
        Object.assign(base, {
          w: n.getAttr('w'), ink: n.getAttr('ink'), title: n.getAttr('title') || '',
          min: n.getAttr('min'), max: n.getAttr('max'),
          ringWidth: n.getAttr('ringWidth'),
          gaugeLabel: n.getAttr('gaugeLabel') || '',
          lowWarn: n.getAttr('lowWarn') ?? '', highWarn: n.getAttr('highWarn') ?? '',
          decimals: n.getAttr('decimals'),
          showIcon: !!n.getAttr('showIcon'), icon: n.getAttr('icon'),
          warnColor: n.getAttr('warnColor'), alarmColor: n.getAttr('alarmColor'),
          feedKey: n.getAttr('feedKey') || '', feedName: n.getAttr('feedName') || '',
          gaugeValue: n.getAttr('gaugeValue') ?? null,
        });
      } else if (etype === 'linechart') {
        // `feeds` and `series` are copied rather than passed by reference so the
        // saved doc can't alias live attrs — same as the battery's `conds`.
        Object.assign(base, {
          w: n.getAttr('w'), h: n.getAttr('h'), ink: n.getAttr('ink'),
          title: n.getAttr('title') || '',
          feeds: (n.getAttr('feeds') || []).map((f) => ({ key: f.key, name: f.name, color: f.color })),
          series: Object.fromEntries(Object.entries(n.getAttr('series') || {})
            .map(([k, pts]) => [k, (pts || []).map((p) => ({ t: p.t, v: p.v }))])),
          hours: n.getAttr('hours'),
          xLabel: n.getAttr('xLabel') || '', yLabel: n.getAttr('yLabel') || '',
          yMin: n.getAttr('yMin') ?? '', yMax: n.getAttr('yMax') ?? '',
          yScale: n.getAttr('yScale'), decimals: n.getAttr('decimals'),
          rawOnly: !!n.getAttr('rawOnly'), stepped: !!n.getAttr('stepped'),
          gridLines: !!n.getAttr('gridLines'), keyLegend: !!n.getAttr('keyLegend'),
          axisFontSize: n.getAttr('axisFontSize'), axisFontFamily: n.getAttr('axisFontFamily'),
        });
        // The legacy sample series is only reachable when no feeds are bound (see
        // chartSeries), so it is only worth saving in that case — carrying it
        // alongside real data would be dead weight in every write to the device.
        if (!(n.getAttr('feeds') || []).length) base.data = n.getAttr('data');
      } else {
        Object.assign(base, { ink: n.getAttr('ink'), title: n.getAttr('title'), w: n.getAttr('w') });
        base.value = n.getAttr('value');
      }
      return base;
    }),
  };
}

/**
 * Load a saved document onto the canvas.
 *
 * `keepDisplay` decides who owns the panel descriptor. On an explicit file load
 * the document wins — it was authored at that size and mode, and dropping its
 * elements onto a different panel would misplace all of them. On the boot
 * restore it must NOT win: the panel the user picked in Act I lives in
 * localStorage, and letting a stale display block from canvas.json overwrite it
 * would silently revert a panel change made after the last canvas edit.
 */
export function deserialize(doc, { keepDisplay = false } = {}) {
  const loading = [];
  layer.find('.element').forEach((n) => n.destroy());
  select(null);
  if (!keepDisplay) {
    Object.assign(display, doc.display || {});
    display.dither = display.dither || 'FloydSteinberg';
    display.orderedMap = display.orderedMap || 8;
    applyDisplayToForm();
    setResolution(display.width, display.height);
  }

  const makers = {
    label: addLabel, divider: addDivider, linechart: addLineChart,
    gauge: addGauge, indicator: addIndicator, battery: addBattery, datetime: addDatetime,
  };
  (doc.elements || []).forEach((el) => {
    if (el.etype === 'image') {
      if (!el.src) return;
      // Decoding is the one part of a load that cannot be synchronous, so it is the one
      // part a caller can arrive too early for — see whenCanvasSettled(). An image that
      // fails to decode resolves anyway: the document is still as loaded as it is going
      // to get, and hanging the caller on a broken data URL helps nobody.
      loading.push(new Promise((resolve) => {
        const img = new Image();
        img.onload = () => { addImage(img, el); resolve(); };
        img.onerror = () => resolve();
        img.src = el.src;
      }));
    } else if (el.etype === 'carousel') {
      loading.push(feedImageSettled(addCarousel(el)));
    } else if (el.etype === 'feedimage') {
      // Built at once, with its frame; the saved picture decodes behind it and is
      // awaited by the same promise as a static image's, for the same reason.
      loading.push(feedImageSettled(addFeedImage(el)));
    } else {
      // Every factory reads its own attrs off the raw saved object, so the factory
      // is also the deserializer — including addGauge's `value` -> `gaugeValue`
      // migration, which nothing else could do (nothing reads doc.version).
      (makers[el.etype] || addLabel)(el);
    }
  });
  fitZoom();
  settled = Promise.all(loading);
}

/**
 * Resolves once the LAST deserialize() has finished putting its images on the canvas.
 *
 * Everything else a document contains is built synchronously, so for most of the app
 * "the canvas is loaded" is simply the line after the call. Anything that photographs
 * the canvas straight after loading one — activate.js rendering the panel image on a
 * device switch — has to wait for the images, or it captures the scene with holes in it.
 */
let settled = Promise.resolve();
export function whenCanvasSettled() { return settled; }

// ---------- autosave --------------------------------------------------------

let lastCanvasJson = null;
let canvasSaveTimer = null;

function setSaveStatus(state, text) {
  const el = $('canvasSaveStatus');
  if (!el) return;
  el.dataset.state = state;
  el.textContent = text;
}

/** Listeners fired whenever the document content actually changes. */
const changeListeners = new Set();
export function onDocChange(fn) { changeListeners.add(fn); }

export function saveCanvasNow() {
  const doc = serialize();
  const text = JSON.stringify(doc, null, 2);
  const view = $('canvasJson');
  if (view) view.textContent = text;          // keep the on-screen view current
  if (text === lastCanvasJson) return;        // no content change -> no write
  lastCanvasJson = text;
  setSaveStatus('saving', 'saving…');
  // localStorage is the store. A device with no id yet (before initDevices has
  // minted one) simply isn't written — there is nowhere to put it.
  const id = activeDeviceId();
  if (id) saveCanvas(id, doc);
  setSaveStatus('saved', 'saved');
  // Up to {group}.canvas-state, on a much longer leash than either of the two writes
  // above — see canvasfeed.js for the cadence and for what reads it back down.
  scheduleCanvasStatePublish(doc);
  changeListeners.forEach((fn) => fn(doc));
}

export function scheduleCanvasSave() {
  clearTimeout(canvasSaveTimer);
  canvasSaveTimer = setTimeout(saveCanvasNow, 400);
}

export function cancelCanvasSave() {
  clearTimeout(canvasSaveTimer);
  canvasSaveTimer = null;
}

/** Drop the de-dupe baseline, so the next save writes unconditionally. */
export function invalidateCanvasBaseline() { lastCanvasJson = null; }

/**
 * The current pretty-printed layout — falls back to serializing on demand in
 * case a save hasn't run yet (e.g. immediately after load).
 */
export function currentCanvasJson() {
  return lastCanvasJson || JSON.stringify(serialize(), null, 2);
}

// ---------- import ----------------------------------------------------------
//
// The validation and the fit are canvasimport.js; this is the dialog and the load.
// The active display always wins — the same rule as hydrateFromCanvasFeed() — so the
// dialog only asks how to place the artwork on it, and whether to take its dithering.

/** The validated document and its comparison, held while the dialog is open. */
let pendingImport = null;

const dims = (d) => (d ? `${d.w}×${d.h}` : '—');

function describeDither(d) {
  if (!d.dither) return '—';
  if (d.dither === 'none') return 'none';
  if (d.dither === 'ordered') return `ordered o${d.orderedMap ?? '?'}`;
  return `Floyd–Steinberg ${d.diffusion ?? '?'}%`;
}

function fillImportDialog(doc, warnings, cmp) {
  const src = doc.display;
  const n = doc.elements.length;
  $('importSummary').textContent =
    `${n} element${n === 1 ? '' : 's'} — importing replaces the current scene.`;

  const rows = [
    ['Size', dims(cmp.srcDims), dims(cmp.dstDims), cmp.sizeDiffers],
    ['Rotation', src.rotation !== undefined ? `${src.rotation}°` : '—', `${display.rotation}°`, false],
    ['Colors', src.type ? MODE_LABELS[src.type] : '—', MODE_LABELS[display.type], cmp.typeDiffers],
    ['Dither', describeDither(src), describeDither(display), cmp.ditherDiffers],
  ];
  $('importRows').innerHTML = rows.map(([k, a, b, differs]) =>
    `<tr data-differs="${differs}"><th>${k}</th><td>${escapeHtml(a)}</td><td>${escapeHtml(b)}</td></tr>`
  ).join('');

  show($('importFitRow'), cmp.sizeDiffers);
  setSegValue('importFitSeg', 'fit');
  const hint = $('importFitHint');
  if (cmp.sizeDiffers) {
    const s = Math.min(cmp.dstDims.w / cmp.srcDims.w, cmp.dstDims.h / cmp.srcDims.h);
    hint.textContent = `Fit scales everything by ${Math.round(s * 100)}% and centers it; `
      + '1:1 keeps the original positions, and anything off the edge is cropped.';
  } else if (!cmp.srcDims) {
    hint.textContent = 'The file does not say what size it was drawn at, so it is placed 1:1.';
  }
  show(hint, cmp.sizeDiffers || !cmp.srcDims);

  const typeNote = $('importTypeNote');
  typeNote.textContent = cmp.typeDiffers
    ? `Drawn for ${MODE_LABELS[src.type]}; colors will be snapped to this display's ${MODE_LABELS[display.type]}.`
    : '';
  show(typeNote, cmp.typeDiffers);

  $('importDither').checked = true;
  show($('importDitherRow'), cmp.ditherDiffers);

  const list = $('importWarnings');
  list.innerHTML = warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('');
  show(list, warnings.length > 0);
}

async function onImportFile(input) {
  const file = input.files?.[0];
  // Reset so choosing the same file again still fires 'change'.
  input.value = '';
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch {
    toast(`Could not read ${file.name}.`);
    return;
  }
  const { ok, errors, warnings, doc } = validateCanvasDoc(text);
  if (!ok) {
    toast(`${file.name} was not imported: ${errors[0]}`
      + (errors.length > 1 ? ` (and ${errors.length - 1} more)` : ''));
    return;
  }
  const cmp = compareDisplay(doc.display, display);
  pendingImport = { doc, cmp };
  fillImportDialog(doc, warnings, cmp);
  openModal('importModal', { trap: true, focus: 'importConfirm', returnFocusTo: 'canvasImportBtn' });
}

async function confirmImport() {
  const job = pendingImport;
  pendingImport = null;
  closeModal('importModal');
  if (!job) return;
  const { doc, cmp } = job;

  const fit = cmp.sizeDiffers && segValue('importFitSeg') !== '1:1';
  const takeDither = cmp.ditherDiffers && $('importDither').checked;
  const out = fit ? fitDoc(doc, cmp.srcDims, cmp.dstDims) : doc;

  // The same order as hydrateFromCanvasFeed(): the outgoing scene's autosave must not
  // land on top of this one, and a dither overlay of the old artwork must not linger.
  cancelCanvasSave();
  hideDitherPreview();
  deserialize(out, { keepDisplay: true });
  // Snap every ink onto THIS panel's palette — a tricolor red has no business on mono.
  remapColorsToPalette();
  if (takeDither) applyDither(doc.display);
  await whenCanvasSettled();
  // Written unconditionally, and through the normal path: localStorage first, then the
  // {group}.canvas-state mirror on its usual leash (canvasfeed.js).
  invalidateCanvasBaseline();
  saveCanvasNow();
  const n = doc.elements.length;
  toast(`Imported ${n} element${n === 1 ? '' : 's'}${fit ? ', fitted to this display' : ''}`);
}

function initImport() {
  wireModal('importModal', ['importClose', 'importCancel']);
  $('canvasImportBtn')?.addEventListener('click', () => $('canvasImportFile')?.click());
  $('canvasImportFile')?.addEventListener('change', (e) => onImportFile(e.currentTarget));
  $('importConfirm')?.addEventListener('click', confirmImport);
}

// ---------- boot ------------------------------------------------------------

export function initDoc() {
  layer.on('draw', scheduleCanvasSave);

  $('canvasCopyBtn')?.addEventListener('click', (e) => {
    copyFromButton(e.currentTarget, currentCanvasJson());
  });

  $('canvasExportBtn')?.addEventListener('click', () => {
    const blob = new Blob([currentCanvasJson()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'canvas.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  });

  initImport();
}
