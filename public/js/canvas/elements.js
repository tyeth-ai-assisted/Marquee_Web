/**
 * Canvas elements in the editor: every prop the toolbox can drop, plus the shared
 * wiring that makes one behave like an element (drag, snap, transform-bake, select).
 *
 * The elements themselves are built by lib/scene.js. Widgets are Konva Groups that
 * rebuild their children from attrs, so resize, recolor, feed refresh and save/load
 * all flow through one code path (rebuildWidget).
 */

import { Konva } from './konva.js';
import { display, logicalDims, PALETTES, hexToRGB, neutralShades } from './palette.js';
import {
  layer, tr, snap, zoom, suspendDitherPreview, scheduleDitherRefresh, syncDisplayBackground,
} from './stage.js';
import { select, refreshProps } from './selection.js';
import { onFontsReady } from './icons.js';
import { toast, clamp } from '../core/util.js';
import * as scene from '../lib/scene.js';
import {
  isWidget, feedValueAttr, isFeedLinked, isDatetime, linkedLabelText, datetimeText, TEXT_PAD_MAX,
} from '../lib/scene.js';

// The element model is lib/scene.js, shared with other hosts; re-exported so editor
// code has one place to import it from.
export {
  WIDGET_TYPES, isWidget, FEED_ETYPES, feedValueAttr, isFeedLinked, isDatetime, linkedLabelText,
  datetimeText, TEXT_PAD_MAX, seriesDash, CHART_FONT_MIN, CHART_FONT_MAX, gaugeValue, gaugeFraction,
  INDICATOR_OPS, compareValues, indicatorValueKnown, batteryFraction,
} from '../lib/scene.js';

let counter = 0;
export const nextId = () => 'el' + (++counter);
export const resetCounter = () => { counter = 0; };

/**
 * Smallest authored width per widget, used when baking a transform back into
 * attrs and by the inspector's size inputs. Anything unlisted floors at 40.
 */
export const MIN_WIDGET_W = { indicator: 6, battery: 20, feedimage: 8 };

/**
 * The widgets whose HEIGHT is authored too, with its floor. Every other widget derives
 * its height from its width (a gauge is round, a lamp is square), so the transform bake
 * only writes `h` for the etypes listed here.
 */
export const MIN_WIDGET_H = { linechart: 30, feedimage: 8 };

export function elementColor(n) { return isWidget(n) ? n.getAttr('ink') : n.fill(); }

export function setElementColor(n, c) {
  if (isWidget(n)) { n.setAttr('ink', c); rebuildWidget(n); }
  else n.fill(c);
}

// ---------- sample data -----------------------------------------------------

function randTempSeries() {
  const pts = [];
  let v = 60 + Math.random() * 20;
  for (let i = 0; i < 12; i++) {
    v = Math.min(95, Math.max(40, v + (Math.random() - 0.5) * 9));
    pts.push(Math.round(v));
  }
  return pts;
}
function randTemp() { return Math.round(45 + Math.random() * 45); }

// ---------- widget dispatch -------------------------------------------------

export function rebuildWidget(n) {
  // A feed image picks its placeholder colours against the page. It is handed the live
  // descriptor on every rebuild, because clone() (Duplicate) deep-copies plain-object
  // attrs and would otherwise leave the copy reading a snapshot of the page.
  if (n.getAttr('etype') === 'feedimage') n.setAttr('display', display);
  if (!scene.rebuildWidget(Konva, n)) return;
  if (tr.nodes().includes(n)) tr.forceUpdate();
}

// ---------- applying a feed read --------------------------------------------

/**
 * The single funnel from "a fresh read arrived" to "the element shows it". Split
 * out because refreshFeedElements used to call rebuildWidget() unconditionally,
 * which only works for Groups — a plain Konva.Text has no children to rebuild, so
 * adding the label to FEED_ETYPES without this would have thrown.
 */
export function applyFeedValue(n, raw) {
  n.setAttr(feedValueAttr(n), raw);
  if (n.getAttr('etype') === 'label') n.text(linkedLabelText(n));
  else rebuildWidget(n);
}

// ---------- label + divider -------------------------------------------------

export function addLabel(attrs = {}) {
  const { w, h } = logicalDims();
  return place(scene.createLabel(Konva, attrs, display, {
    x: Math.round(w / 2 - 30), y: Math.round(h / 2 - 10),
    draggable: true, name: 'element', id: nextId(),
  }));
}

export function addDivider(attrs = {}) {
  const { w, h } = logicalDims();
  return place(scene.createDivider(Konva, attrs, display, {
    x: Math.round(w * 0.1), y: Math.round(h / 2), width: Math.round(w * 0.8),
    draggable: true, name: 'element', id: nextId(),
  }));
}

// ---------- date & time -----------------------------------------------------
//
// A text block whose content is rendered by the Adafruit IO Time API — the preset's
// strftime string, in the chosen zone. A plain Konva.Text like the label, so resize,
// scale, colour and the dither preview all treat it as one.
//
// Its text is DERIVED, like a linked label's: it is re-read by refreshFeedElements()
// before every push and every live take, which is the only time it changes. The board
// draws a bitmap, so the panel does not tick between pushes.

/** The funnel from "IO answered" to "the element shows it". */
export function applyTimeValue(n, s) {
  n.setAttr('timeValue', s);
  n.text(datetimeText(n));
}

export function addDatetime(attrs = {}) {
  const { w, h } = logicalDims();
  return place(scene.createDatetime(Konva, attrs, display, {
    x: Math.round(w / 2 - 50), y: Math.round(h / 2 - 10),
    draggable: true, name: 'element', id: nextId(),
  }));
}

// ---------- line chart ------------------------------------------------------
//
// Plots one or more Adafruit IO feeds over a history window. The option set
// mirrors the IO dashboard's chart block, so a layout authored here reads the same
// as the dashboard it came from.
//
// Series data lives in the `series` attr, keyed by feed key, and is refetched by
// refreshChartElements() (feeds.js). It is DOWNSAMPLED before it lands there —
// canvas.json is the wire format to the device and is republished on every push,
// so storing 640 raw points per feed would bloat it for pixels that don't exist.

/** How many chart history windows the inspector offers, in hours. */
export const CHART_RANGES = [
  { hours: 1, label: '1 hour' },
  { hours: 4, label: '4 hours' },
  { hours: 8, label: '8 hours' },
  { hours: 24, label: '24 hours' },
  { hours: 24 * 7, label: '7 days' },
  { hours: 24 * 30, label: '30 days' },
];

// IO's own ceiling on a raw (unaggregated) chart pull lives with the bindings it governs.
export { CHART_RAW_MAX } from '../lib/bindings.js';

export function addLineChart(attrs = {}) {
  const { w, h } = logicalDims();
  // A fresh unbound chart gets sample data, so it shows a shape instead of an empty frame.
  return place(scene.createLineChart(Konva, { ...attrs, data: attrs.data ?? randTempSeries() }, display, {
    x: Math.round(w / 2 - 60), y: Math.round(h / 2 - 30),
    draggable: true, name: 'element', id: nextId(),
  }));
}

// ---------- gauge -----------------------------------------------------------
//
// A donut ring driven by one Adafruit IO feed, matching the IO dashboard's gauge
// block: a fixed [min, max] range, a ring whose thickness the user sets, the value
// and a caption inside it, and an optional icon.
//
// Colour carries the alarm state, and the three cases are NOT interchangeable:
// `warnColor` for a value at or past a warning threshold, `alarmColor` for a value
// outside [min, max] entirely. IO's rule is that out-of-bounds always recolours
// even when no warning values are set, so the bounds check comes first.

export function addGauge(attrs = {}) {
  const { w, h } = logicalDims();
  // An unbound gauge gets a sample reading; a bound one waits for its feed.
  const gaugeValue = attrs.gaugeValue ?? attrs.value ?? (attrs.feedKey ? null : randTemp());
  return place(scene.createGauge(Konva, { ...attrs, gaugeValue }, display, {
    x: Math.round(w / 2 - 45), y: Math.round(h / 2 - 45),
    draggable: true, name: 'element', id: nextId(),
  }));
}

// ---------- indicator: on/off lamp driven by an Adafruit IO feed -------------

export function addIndicator(attrs = {}) {
  const { w, h } = logicalDims();
  return place(scene.createIndicator(Konva, attrs, display, {
    x: Math.round(w / 2 - 8), y: Math.round(h / 2 - 8),
    draggable: true, name: 'element', id: nextId(),
  }));
}

// ---------- battery level gauge ---------------------------------------------
//
// The feed's last value drives the bar length (assumed numeric, 0-100). A list
// of conditions is evaluated top to bottom against the SAME value; the first
// that holds supplies the fill shade, otherwise `defaultShade` is used.
//
// Shades are neutrals only (see neutralShades). A grey ramp reads correctly on
// every panel type, where a red/yellow one would exist on quadcolor and nowhere
// else.

export function addBattery(attrs = {}) {
  const { w, h } = logicalDims();
  return place(scene.createBattery(Konva, attrs, display, {
    x: Math.round(w / 2 - 24), y: Math.round(h / 2 - 12),
    draggable: true, name: 'element', id: nextId(),
  }));
}

// ---------- image -----------------------------------------------------------
//
// An image whose picture is embedded in the document. Nothing in the editor places one
// any more: every new picture goes on an Adafruit IO feed (#36, see feed image below).
// Documents from before that still hold them, so they still load, draw and render, and
// the inspector offers to move each one onto a feed.

export function addImage(imageObj, attrs = {}) {
  return place(scene.createImage(Konva, imageObj, attrs, display, {
    draggable: true, name: 'element', id: nextId(),
  }));
}

/** Make a built element an editor element: wired for drag/select and on the canvas. */
function place(node) {
  wireNode(node);
  layer.add(node);
  return node;
}

// ---------- feed image ------------------------------------------------------
//
// Every picture placed on the canvas lives on an Adafruit IO feed (#36). The element
// is built by lib/scene.js; what is the editor's here is DECODING: the feed's value
// becomes an <img> in `imageObj`, and `src` keeps the data URL it came from so an
// unchanged value is not decoded twice. Neither is saved, since serializeElement()
// writes the feed reference instead.

/**
 * Where a decode in flight for each node can be awaited. A caller photographing the
 * canvas straight after a load must not capture the frame before its picture arrives.
 */
const feedImageLoads = new WeakMap();

/** Resolves once the picture `setFeedImageSrc()` last started decoding is in. */
export function feedImageSettled(g) {
  return feedImageLoads.get(g) || Promise.resolve(true);
}

/**
 * Decode a data URL into an <img>, or null when the browser cannot. parseFeedImage() only
 * checks the signature, so a truncated file passes it and fails here. Callers that are
 * about to change the canvas on the strength of a picture decode it FIRST.
 */
export function decodeImage(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/**
 * Which binding a frame is on, as a counter. Bumped by bindFeedImage() on every bind and
 * captured by the asynchronous paths (a feed read, a decode) when they start. A result
 * that comes back under a different generation belongs to a binding that no longer
 * exists and is dropped: a frame rebound from feed A to feed B while A's read was in
 * flight must never end up showing A's picture.
 */
export function feedImageGen(g) { return g.getAttr('feedGen') || 0; }

/** Point a frame at a feed, invalidating whatever was in flight for it. */
export function bindFeedImage(g, feedKey, feedName) {
  g.setAttr('feedKey', feedKey || '');
  g.setAttr('feedName', feedName || '');
  g.setAttr('feedGen', feedImageGen(g) + 1);
}

/** Put a decoded picture into the frame, synchronously. */
export function applyFeedImage(g, img, dataUrl) {
  g.setAttr('imageObj', img);
  g.setAttr('natW', img.width);
  g.setAttr('natH', img.height);
  g.setAttr('src', dataUrl);
  rebuildWidget(g);
}

/**
 * Show the "no picture" placeholder: the feed is empty, or holds something that is not
 * a picture. Not used for a failed READ, which keeps the previous picture like every
 * other binding does.
 */
export function clearFeedImage(g) {
  if (!g.getAttr('imageObj') && !g.getAttr('src')) return;
  g.setAttr('imageObj', null);
  g.setAttr('natW', null);
  g.setAttr('natH', null);
  g.setAttr('src', null);
  rebuildWidget(g);
}

/**
 * Decode a data URL into the frame. Resolves true once the picture is showing, false
 * when it could not be decoded or no longer belongs. In that case the previous picture
 * is LEFT IN PLACE, matching refreshFeedElements' rule that a failed read never blanks
 * an element.
 *
 * Only the newest call per node lands, and a superseded call resolves with the NEWEST
 * call's outcome rather than its own. The caller is a take about to photograph the
 * canvas, so "done" has to mean the frame shows the latest picture, not that this
 * particular decode finished.
 */
export function setFeedImageSrc(g, dataUrl) {
  const gen = feedImageGen(g);
  const p = decodeImage(dataUrl).then((img) => {
    if (feedImageLoads.get(g) !== p) return feedImageLoads.get(g) || false;
    if (!img || feedImageGen(g) !== gen || !g.getLayer()) return false;
    applyFeedImage(g, img, dataUrl);
    return true;
  });
  feedImageLoads.set(g, p);
  return p;
}

/**
 * A feed image frame. `attrs.imageObj` (with `attrs.src`, its data URL) shows a picture
 * already in hand at once; otherwise the frame shows the placeholder until the feed is read.
 */
export function addFeedImage(attrs = {}) {
  const g = place(scene.createFeedImage(Konva, attrs, display, {
    draggable: true, name: 'element', id: nextId(),
  }));
  if (attrs.imageObj && attrs.src) g.setAttr('src', attrs.src);
  return g;
}

/**
 * Turn an image from before #36 (one whose picture is embedded in the document) into a
 * feed image in place: same spot, same box, same stacking. Used once its picture has been
 * uploaded to a feed, or the user has picked a feed for it instead. The frame is the box
 * the user had already sized, so nothing on the canvas moves.
 */
export function imageToFeedImage(node, attrs = {}) {
  const g = addFeedImage({
    x: node.x(), y: node.y(), w: Math.round(node.width()), h: Math.round(node.height()),
    // Its own dither, if it had one, comes with it.
    dither: node.getAttr('dither'), diffusion: node.getAttr('diffusion'),
    ...attrs,
  });
  g.zIndex(node.zIndex());
  node.destroy();
  return g;
}

// ---------- shared element wiring -------------------------------------------

let activeAnchor = null;

export function wireNode(node) {
  // A live dither overlay would hide the drag entirely (it's a static bitmap
  // painted over the stage), so drop it for the gesture and re-run it after.
  node.on('dragstart', suspendDitherPreview);
  node.on('dragmove', () => {
    node.position({ x: snap(node.x()), y: snap(node.y()) }); // live snap while dragging
  });
  node.on('dragend', () => {
    node.position({ x: snap(node.x()), y: snap(node.y()) });
    refreshProps();
    scheduleDitherRefresh();
  });
  node.on('transformstart', () => { activeAnchor = tr.getActiveAnchor(); suspendDitherPreview(); });
  node.on('transformend', () => {
    // Bake scale into geometry so exports stay pixel-true.
    if (node.getAttr('etype') === 'divider') {
      node.width(Math.max(1, Math.round(node.width() * node.scaleX())));
      node.height(Math.max(1, Math.round(node.height() * node.scaleY())));
    } else if (isWidget(node)) {
      // A lamp is legitimately tiny, so the 40px floor that suits a chart or
      // gauge would stop it shrinking at all. Declared per-etype rather than
      // inline so adding a widget doesn't mean editing a ternary.
      const minW = MIN_WIDGET_W[node.getAttr('etype')] ?? 40;
      node.setAttr('w', Math.max(minW, Math.round(node.getAttr('w') * node.scaleX())));
      const minH = MIN_WIDGET_H[node.getAttr('etype')];
      if (minH !== undefined)
        node.setAttr('h', Math.max(minH, Math.round(node.getAttr('h') * node.scaleY())));
      rebuildWidget(node);
    } else if (node.getAttr('etype') === 'image') {
      node.width(Math.max(1, Math.round(node.width() * node.scaleX())));
      node.height(Math.max(1, Math.round(node.height() * node.scaleY())));
    } else if (activeAnchor === 'middle-left' || activeAnchor === 'middle-right') {
      // Side drag: resize the text box, text re-wraps, type size unchanged.
      node.width(Math.max(8, Math.round(node.width() * node.scaleX())));
    } else {
      // Corner drag: scale the type itself (box width scales along if fixed).
      const boxed = node.attrs.width !== undefined;
      node.fontSize(Math.max(4, Math.round(node.fontSize() * node.scaleY())));
      // The box's padding scales with the type, or a big label ends up cramped.
      node.padding(clamp(Math.round(node.padding() * node.scaleY()), 0, TEXT_PAD_MAX));
      if (boxed) node.width(Math.max(8, Math.round(node.width() * node.scaleX())));
    }
    node.scale({ x: 1, y: 1 });
    node.position({ x: snap(node.x()), y: snap(node.y()) });
    refreshProps();
    scheduleDitherRefresh();
  });
  node.on('click tap', (e) => { e.cancelBubble = true; select(node); });
  if (node.getAttr('etype') === 'label') {
    node.on('dblclick dbltap', () => editLabel(node));
  } else if (isDatetime(node)) {
    // Not editLabel: the text is IO's, and the next read would overwrite an edit.
    node.on('dblclick dbltap', () => toast('The time comes from Adafruit IO — pick a type in the inspector'));
  }
}

/**
 * Inline rename: overlay a textarea on top of the label, matched to its
 * on-screen size and typography. Enter commits, Esc cancels, blur commits.
 */
export function editLabel(node) {
  // A linked label's text is derived from the feed, so editing it here would be
  // silently reverted by the next refresh. Refuse rather than accept an edit that
  // won't survive — and say where the text comes from, since the inspector's
  // read-only Text box is the other half of this rule.
  if (isFeedLinked(node)) {
    toast(`Text comes from "${node.getAttr('feedName') || node.getAttr('feedKey')}" — unlink it to edit`);
    return;
  }
  select(null);
  node.hide();
  const holder = document.getElementById('stage-holder');
  const ta = document.createElement('textarea');
  holder.appendChild(ta);
  const pos = node.absolutePosition(); // already in on-screen (zoomed) pixels
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim();
  Object.assign(ta.style, {
    position: 'absolute',
    left: pos.x + 'px',
    top: pos.y + 'px',
    width: (node.width() + 4) * zoom + 'px',
    height: (node.height() + 6) * zoom + 'px',
    minHeight: '0',
    fontSize: node.fontSize() * zoom + 'px',
    fontFamily: node.fontFamily(),
    lineHeight: String(node.lineHeight()),
    textAlign: node.align(),
    color: node.fill(),
    // Konva's padding is inside width(), so mirroring it here keeps the caret on the
    // glyphs it is replacing, and the box colour keeps light text legible.
    padding: node.padding() * zoom + 'px',
    boxSizing: 'border-box',
    background: node.getAttr('background') || 'transparent',
    border: `1px dashed ${accent}`,
    margin: '0',
    overflow: 'hidden',
    resize: 'none',
    outline: 'none',
    whiteSpace: 'pre',
    zIndex: '10',
  });
  ta.value = node.text();
  ta.focus();
  ta.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit && ta.value.trim() !== '') node.text(ta.value);
    ta.remove();
    node.show();
    select(node);
  };
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') finish(false);
  });
  ta.addEventListener('blur', () => finish(true));
}

// ---------- font gate --------------------------------------------------------

/**
 * Re-draw text once the faces have actually loaded. @font-face loading is lazy and Konva
 * measures and paints text on the canvas, so anything built after a cold load was laid
 * out in the browser's substitute face — and the dither preview would then cache that as
 * if it were the artwork. Widgets rebuild; a text element is made to measure again.
 *
 * Called once from boot.
 */
export function initFonts() {
  onFontsReady(() => {
    layer.find('.element').forEach((n) => {
      if (isWidget(n)) rebuildWidget(n);
      else if (n.getAttr('etype') === 'label' || isDatetime(n)) {
        // Konva only re-measures on a change, and setting the same family is not one
        const family = n.fontFamily();
        n.fontFamily('');
        n.fontFamily(family);
      }
    });
    layer.draw();
  });
}

// ---------- palette remapping ------------------------------------------------

/**
 * Snap every element's colors onto the current panel palette. Called whenever
 * the color mode changes: leaving off-palette colors in place would let the
 * dither silently shift them at render time.
 */
export function remapColorsToPalette() {
  // Parameterised by the candidate set so the battery can snap to NEUTRALS only:
  // snapping its grey ramp to the full quadcolor palette could pull a mid-grey
  // onto red, which is exactly what a grey-only widget must never do.
  const nearestIn = (palHex) => {
    const pal = palHex.map(hexToRGB);
    return (hex) => {
      const c = hexToRGB(hex);
      let best = 0, bestD = Infinity;
      pal.forEach((p, i) => {
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      });
      return palHex[best];
    };
  };
  const nearest = nearestIn(PALETTES[display.type]);
  const nearestNeutral = nearestIn(neutralShades());
  // The page itself, before the elements on it — see syncDisplayBackground().
  syncDisplayBackground();
  layer.find('.element').forEach((n) => {
    if (n.getAttr('etype') === 'image') return; // dithered at render time, no single ink
    // Same for a feed image's picture. Its placeholder is drawn in palette colours picked
    // at build time, so it is rebuilt to pick up the new palette.
    if (n.getAttr('etype') === 'feedimage') { rebuildWidget(n); return; }
    // A text box's background is a second colour beside its ink; '' (none) stays none.
    if (n.getAttr('background')) n.setAttr('background', nearest(n.getAttr('background')));
    // An indicator carries THREE colors, so the single-color elementColor /
    // setElementColor pair can't express it — remap each one explicitly.
    if (n.getAttr('etype') === 'indicator') {
      n.setAttr('onColor', nearest(n.getAttr('onColor')));
      n.setAttr('offColor', nearest(n.getAttr('offColor')));
      n.setAttr('ink', nearest(n.getAttr('ink')));
      rebuildWidget(n);
      return;
    }
    // A battery carries its outline plus one shade per condition plus the
    // default, so it needs the same explicit treatment — and against the neutral
    // subset, since its whole point is a grey ramp.
    if (n.getAttr('etype') === 'battery') {
      n.setAttr('ink', nearestNeutral(n.getAttr('ink')));
      n.setAttr('defaultShade', nearestNeutral(n.getAttr('defaultShade')));
      n.setAttr('conds', (n.getAttr('conds') || [])
        .map((c) => ({ ...c, color: nearestNeutral(c.color) })));
      rebuildWidget(n);
      return;
    }
    // A gauge carries its ring ink plus the two alarm colours. Snapped against the
    // FULL palette, not the neutrals the battery uses: the entire point of a warning
    // colour is that it can be red on a tricolor or quadcolor panel.
    if (n.getAttr('etype') === 'gauge') {
      n.setAttr('ink', nearest(n.getAttr('ink')));
      n.setAttr('warnColor', nearest(n.getAttr('warnColor')));
      n.setAttr('alarmColor', nearest(n.getAttr('alarmColor')));
      rebuildWidget(n);
      return;
    }
    // A chart carries its ink plus one colour per bound feed.
    if (n.getAttr('etype') === 'linechart') {
      n.setAttr('ink', nearest(n.getAttr('ink')));
      n.setAttr('feeds', (n.getAttr('feeds') || [])
        .map((f) => ({ ...f, color: nearest(f.color) })));
      rebuildWidget(n);
      return;
    }
    setElementColor(n, nearest(elementColor(n)));
  });
}

// ---------- templates -------------------------------------------------------
//
// Pre-built layouts, authored against a 296×128 reference panel (a MagTag) and
// scaled from there. On a MagTag the numbers below land verbatim; on a 250×122
// FeatherWing or an 800×480 the layout scales to match.
//
// Positions and box widths scale on each axis independently, but type and
// square widgets scale on the SMALLER of the two — a font scaled on the wide
// axis alone overflows the moment a panel is proportionally shorter than the
// reference.

const REF_PANEL = { w: 296, h: 128 };

function placer() {
  const { w, h } = logicalDims();
  const sx = w / REF_PANEL.w;
  const sy = h / REF_PANEL.h;
  const st = Math.min(sx, sy);
  return {
    x: (v) => Math.round(v * sx),
    y: (v) => Math.round(v * sy),
    w: (v) => Math.max(1, Math.round(v * sx)),
    h: (v) => Math.max(1, Math.round(v * sy)),
    type: (v) => Math.max(4, Math.round(v * st)),
    size: (v) => Math.max(1, Math.round(v * st)),
  };
}

export const TEMPLATES = {
  weather: {
    label: 'Weather Station',
    build() {
      const p = placer();
      const ink = PALETTES[display.type][0];
      addLabel({
        x: p.x(8), y: p.y(8), text: 'WEATHER STATION',
        fontSize: p.type(28), fontFamily: 'monospace', align: 'left', fill: ink,
      });
      addDivider({ x: p.x(8), y: p.y(40), width: p.w(208), height: p.size(2), fill: ink });
      addLabel({
        x: p.x(10), y: p.y(50), text: '72°F',
        fontSize: p.type(33), fontFamily: 'monospace', align: 'left', fill: ink,
      });
      addLineChart({
        x: p.x(120), y: p.y(60), w: p.w(169), h: p.h(58), ink, title: 'Temp',
        data: [64, 63, 60, 64, 67, 71, 72, 75, 80, 80, 82, 78],
      });
      addLabel({
        x: p.x(10), y: p.y(90), text: '40%RH',
        fontSize: p.type(33), fontFamily: 'monospace', align: 'left', fill: ink,
      });
    },
  },
  aqi: {
    label: 'AQI Monitor',
    build() {
      const p = placer();
      const ink = PALETTES[display.type][0];
      addLabel({
        x: p.x(80), y: p.y(10), text: 'Air Quality',
        fontSize: p.type(23), fontFamily: 'monospace', align: 'left', fill: ink,
      });
      addDivider({ x: p.x(10), y: p.y(40), width: p.w(270), height: p.size(1), fill: ink });
      // The battery's seeded condition and default shade are addBattery's own
      // defaults (ink for both), so they are left implicit rather than restated.
      addBattery({ x: p.x(250), y: p.y(0), w: p.size(20), ink, showPct: true });
      addLineChart({
        x: p.x(10), y: p.y(90), w: p.w(141), h: p.h(31), ink, title: 'PM2.5',
        data: [73, 76, 72, 74, 72, 73, 69, 69, 69, 68, 66, 64],
      });
      addLabel({
        x: p.x(110), y: p.y(50), text: 'Good',
        fontSize: p.type(30), fontFamily: 'monospace', align: 'left', fill: ink,
      });
    },
  },
  quote: {
    label: 'Big quote',
    build() {
      const p = placer();
      const ink = PALETTES[display.type][0];
      // Konva word-wraps to the box width, so the quote is one label rather than
      // hand-broken lines — it re-flows correctly when the type scales down onto
      // a narrower panel instead of running off the edge.
      addLabel({
        x: p.x(10), y: p.y(14),
        text: '“A hacker to me is someone creative who does wonderful things”',
        fontSize: p.type(18), fontFamily: 'monospace',
        width: p.w(276), align: 'left', fill: ink,
      });
      addDivider({ x: p.x(10), y: p.y(84), width: p.w(70), height: p.size(2), fill: ink });
      addLabel({
        x: p.x(10), y: p.y(94), text: 'Tim Berners-Lee',
        fontSize: p.type(14), fontFamily: 'monospace', align: 'left', fill: ink,
      });
    },
  },
};

/** Replace the canvas with a template layout. Confirms first if work exists. */
export function applyTemplate(key) {
  const template = TEMPLATES[key];
  if (!template) return;
  const existing = layer.find('.element');
  if (existing.length
    && !confirm(`Replace the current layout with "${template.label}"?\n\nThe ${existing.length} element(s) on the canvas will be removed.`)) return;
  existing.forEach((n) => n.destroy());
  select(null);
  suspendDitherPreview();
  template.build();
  layer.draw();
  scheduleDitherRefresh();
  toast(`Loaded the ${template.label} template`);
}
