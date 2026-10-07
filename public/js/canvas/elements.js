/**
 * Canvas elements: every prop the toolbox can drop, plus the shared wiring that
 * makes one behave like an element (drag, snap, transform-bake, select).
 *
 * Widgets are Konva Groups that rebuild their children from attrs, so resize,
 * recolor, feed refresh and save/load all flow through one code path
 * (rebuildWidget).
 */

import { Konva } from './konva.js';
import { display, logicalDims, PALETTES, hexToRGB, neutralShades, isHexColor, nearestColor } from './palette.js';
import {
  layer, tr, snap, zoom, suspendDitherPreview, scheduleDitherRefresh, syncDisplayBackground,
  onDisplayBackgroundPicked,
} from './stage.js';
import { select, refreshProps } from './selection.js';
import { FA_FAMILY, FA_WEIGHT, iconGlyph, DEFAULT_GAUGE_ICON, onFaReady } from './icons.js';
import {
  toast, clamp, toNum, fmtDecimals, fmtFeedText, niceTicks, niceStep, snapToStep, fmtTicks, scaleUnit,
} from '../core/util.js';
import { normalizeDatetimeAttrs, placeholderText } from '../core/timefmt.js';
import { fitRect, FEED_IMAGE_FITS } from '../core/feedimage.js';
import { IMAGE_DITHERS } from './imagedither.js';

let counter = 0;
export const nextId = () => 'el' + (++counter);
export const resetCounter = () => { counter = 0; };

/**
 * Group-based elements that rebuild their children from attrs. Membership here
 * is load-bearing, not a convenience: an etype missing from this set falls
 * through wireNode's transformend chain into the LABEL branch and throws on
 * fontSize() (a Group has no such method), and through refreshProps into the
 * DIVIDER branch.
 */
export const WIDGET_TYPES = ['linechart', 'gauge', 'indicator', 'battery', 'feedimage'];
export function isWidget(n) { return WIDGET_TYPES.includes(n.getAttr('etype')); }

/**
 * Elements that carry a feedKey and get re-read by refreshFeedElements(). This
 * used to be a bare `etype === 'indicator'` down at the call site, where a new
 * feed-bound widget silently never polls; keep new types listed here.
 *
 * `label` is in here because a linked text block is exactly as live as a lamp —
 * it used to be a one-shot snapshot that persisted its feedKey and then never
 * read it again, which looked like a binding and behaved like a screenshot.
 *
 * `linechart` is NOT here: it needs a history window rather than a last value,
 * so it has its own path (see refreshChartElements in feeds.js). Nor is `feedimage`:
 * it reads a last value like the others, but applying one means DECODING it, which is
 * asynchronous — see refreshFeedImage in feeds.js.
 */
export const FEED_ETYPES = ['label', 'indicator', 'battery', 'gauge'];

/**
 * Which attr each feed-bound element parks its last sample in. Konva's Node
 * registers a `value` getter/setter whose default is 0, so an attr literally
 * named `value` can never read back as unset: setAttr('value', null) DELETES it
 * and getAttr('value') then returns 0. Everything except the indicator (which
 * predates the discovery and only ever compares, never plots) therefore uses a
 * prefixed name so "unknown" stays distinguishable from a real reading of zero.
 */
const FEED_VALUE_ATTR = {
  indicator: 'value', battery: 'feedValue', label: 'feedValue', gauge: 'gaugeValue',
};
export const feedValueAttr = (n) => FEED_VALUE_ATTR[n.getAttr('etype')] || 'feedValue';

/** Does this element take its content from a feed right now? */
export const isFeedLinked = (n) => !!n.getAttr('feedKey');

/** Is this a "Date & time" prop, whose text IO renders (see addDatetime)? */
export const isDatetime = (n) => n.getAttr('etype') === 'datetime';

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

/**
 * Explicit dispatch. This was `if (linechart) … else buildGauge()`, which drew
 * any unrecognized widget AS A GAUGE — a silent wrong-render rather than an
 * error.
 */
const WIDGET_BUILDERS = {
  linechart: buildLineChart,
  gauge: buildGauge,
  indicator: buildIndicator,
  battery: buildBattery,
  feedimage: buildFeedImage,
};

export function rebuildWidget(n) {
  const build = WIDGET_BUILDERS[n.getAttr('etype')];
  if (!build) { console.warn('rebuildWidget: no builder for etype', n.getAttr('etype')); return; }
  build(n);
  if (tr.nodes().includes(n)) tr.forceUpdate();
}

// ---------- applying a feed read --------------------------------------------

/**
 * The text a linked label shows: the sample wrapped in its optional prefix and
 * suffix. An unknown value renders as an em dash rather than an empty label,
 * because a label that collapses to zero width is indistinguishable from one the
 * user deleted.
 */
export function linkedLabelText(n) {
  const raw = n.getAttr('feedValue');
  const body = (raw === null || raw === undefined || String(raw) === '')
    ? '—' : fmtFeedText(raw, n.getAttr('feedDecimals'));
  return `${n.getAttr('feedPrefix') || ''}${body}${n.getAttr('feedSuffix') || ''}`;
}

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

// ---------- text box: background + padding ----------------------------------
//
// The label and the datetime can sit on a filled box. Konva.Text has no background
// of its own, so rather than wrap it in a Group — which would turn every n.text(),
// n.fill() and n.fontSize() in the app into a child lookup, and every saved label
// into a migration — the box is painted by the text's own sceneFunc, under the
// glyphs. Konva.Text's native `padding` already insets the glyphs and is counted in
// width()/height(), so the box, the hit area and the transformer all agree, and an
// auto-width box follows the text as a live value changes its length.

/** The largest padding the inspector offers, in px. */
export const TEXT_PAD_MAX = 64;

function drawTextBox(ctx, shape) {
  const bg = shape.getAttr('background');
  if (bg) {
    ctx.setAttr('fillStyle', bg);
    ctx.fillRect(0, 0, shape.width(), shape.height());
  }
  shape._sceneFunc(ctx);
}

/**
 * Install the box on a text element from its saved attrs. `background` is '' for
 * none, which is the default and what every label saved before this existed loads
 * as — so an old document draws exactly as it did.
 */
function applyTextBox(node, attrs) {
  node.setAttr('background', isHexColor(attrs.background) ? attrs.background : '');
  node.padding(clamp(Math.round(toNum(attrs.padding) ?? 0), 0, TEXT_PAD_MAX));
  node.sceneFunc(drawTextBox);
}

// ---------- label + divider -------------------------------------------------

export function addLabel(attrs = {}) {
  const { w, h } = logicalDims();
  const node = new Konva.Text(Object.assign({
    x: Math.round(w / 2 - 30), y: Math.round(h / 2 - 10),
    text: 'Label', fontSize: 20, fontFamily: 'monospace',
    fill: PALETTES[display.type][0], draggable: true,
    name: 'element', id: nextId(),
  }, attrs));
  node.setAttr('etype', 'label');
  // The feed binding is set through attrs rather than the Konva.Text constructor
  // so the three names stay together and a plain addLabel() still gets them as
  // empty rather than undefined.
  node.setAttr('feedKey', attrs.feedKey ?? '');
  node.setAttr('feedName', attrs.feedName ?? '');
  node.setAttr('feedPrefix', attrs.feedPrefix ?? '');
  node.setAttr('feedSuffix', attrs.feedSuffix ?? '');
  node.setAttr('feedDecimals', attrs.feedDecimals ?? null);   // null = as sent
  node.setAttr('feedValue', attrs.feedValue ?? null);
  // A linked label's text is DERIVED, so recompute it on load rather than
  // trusting the saved string: the prefix/suffix could have been edited in the
  // same session that the value last changed.
  if (isFeedLinked(node) && node.getAttr('feedValue') !== null) node.text(linkedLabelText(node));
  applyTextBox(node, attrs);
  wireNode(node);
  layer.add(node);
  return node;
}

export function addDivider(attrs = {}) {
  const { w, h } = logicalDims();
  const node = new Konva.Rect(Object.assign({
    x: Math.round(w * 0.1), y: Math.round(h / 2),
    width: Math.round(w * 0.8), height: 2,
    fill: PALETTES[display.type][0], draggable: true,
    name: 'element', id: nextId(),
  }, attrs));
  node.setAttr('etype', 'divider');
  wireNode(node);
  layer.add(node);
  return node;
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

/** The text a datetime shows: IO's last answer, or its preset's example before one. */
export function datetimeText(n) {
  return n.getAttr('timeValue') ?? placeholderText(n.getAttr('timeFmt'));
}

/** The funnel from "IO answered" to "the element shows it". */
export function applyTimeValue(n, s) {
  n.setAttr('timeValue', s);
  n.text(datetimeText(n));
}

export function addDatetime(attrs = {}) {
  const { w, h } = logicalDims();
  const a = normalizeDatetimeAttrs(attrs);
  const node = new Konva.Text({
    x: attrs.x ?? Math.round(w / 2 - 50), y: attrs.y ?? Math.round(h / 2 - 10),
    fontSize: a.fontSize, fontFamily: a.fontFamily, align: a.align,
    fill: a.fill ?? PALETTES[display.type][0], draggable: true,
    name: 'element', id: nextId(),
  });
  // Only when authored: an unset width is what makes Konva auto-size to the text.
  if (a.width !== undefined) node.width(a.width);
  node.setAttr('etype', 'datetime');
  node.setAttr('timeFmt', a.timeFmt);
  node.setAttr('timeTz', a.timeTz);
  node.setAttr('timeValue', a.timeValue);
  node.text(datetimeText(node));
  applyTextBox(node, attrs);
  wireNode(node);
  layer.add(node);
  return node;
}

// ---------- faint ink -------------------------------------------------------
//
// A few things are drawn at part strength so they read as background: a gauge's empty
// track, a chart's grid. Only pictures are dithered (imagedither.js), and a part-strength
// ink snapped to the nearest panel colour is just paper. So each is drawn as something
// the panel can show: a real in-between shade where the palette has one (4 greys), and
// otherwise a sparse pattern of whole ink pixels.

/** `ink` at `alpha` over the page, as a hex colour. */
function blendOnPage(ink, alpha) {
  const a = hexToRGB(ink), b = hexToRGB(display.background);
  return '#' + a.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('');
}

/** The palette shade a part-strength `ink` reads as, or null when none sits between it and the page. */
function faintShade(ink, alpha) {
  const shade = nearestColor(blendOnPage(ink, alpha), PALETTES[display.type]);
  return shade !== display.background && shade !== ink ? shade : null;
}

const stipples = new Map();
/** A 2×2 tile with 1, 2 or 3 ink pixels, the nearest to `alpha` of the page covered. */
function stipple(ink, alpha) {
  const n = alpha <= 0.375 ? 1 : alpha <= 0.625 ? 2 : 3;
  const key = `${ink}|${n}`;
  if (!stipples.has(key)) {
    const c = document.createElement('canvas');
    c.width = 2; c.height = 2;
    const ctx = c.getContext('2d');
    ctx.fillStyle = ink;
    [[0, 0], [1, 1], [1, 0]].slice(0, n).forEach(([x, y]) => ctx.fillRect(x, y, 1, 1));
    stipples.set(key, c);
  }
  return stipples.get(key);
}

/**
 * Fill attrs for a shape drawn at part strength. `origin` is where the shape's own
 * coordinates start inside its group, so the pattern can be shifted onto whole panel
 * pixels when that is a half-pixel (a gauge's centre, say).
 */
function faintFill(ink, alpha, origin = { x: 0, y: 0 }) {
  const shade = faintShade(ink, alpha);
  if (shade) return { fill: shade };
  return {
    fillPatternImage: stipple(ink, alpha), fillPatternRepeat: 'repeat',
    fillPatternX: -(origin.x - Math.floor(origin.x)), fillPatternY: -(origin.y - Math.floor(origin.y)),
  };
}

/** The faint parts are relative to the page, so they are redrawn when it changes. */
onDisplayBackgroundPicked(() => {
  layer.find('.element').forEach((n) => {
    if (n.getAttr('etype') === 'gauge' || n.getAttr('etype') === 'linechart') rebuildWidget(n);
  });
});

/** Stroke attrs for a 1px line at part strength: the shade, or ink dashed one pixel in three. */
function faintStroke(ink, alpha) {
  const shade = faintShade(ink, alpha);
  return shade ? { stroke: shade } : { stroke: ink, dash: [1, 2] };
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

/** IO's own ceiling on a raw (unaggregated) chart pull. */
export const CHART_RAW_MAX = 640;

/**
 * Dash patterns, assigned by series index. Colour alone cannot separate series:
 * on a mono panel every ink collapses to black, so two feeds would draw as one
 * indistinguishable tangle. Same reasoning as the indicator's lamp stroke and the
 * battery's outline — the panel type must not be able to erase information.
 */
const SERIES_DASH = [[], [4, 2], [1, 2], [6, 2, 1, 2], [8, 3], [2, 2, 6, 2]];
export const seriesDash = (i) => SERIES_DASH[i % SERIES_DASH.length];

// The chart's text (tick numbers, X/Y captions, legend, block title) is sized and
// set per chart; these are the defaults and the range the inspector allows. 7px
// monospace is what every chart drew before the option existed, so older layouts
// are unchanged. The title stays TITLE_STEP px larger than the rest so it still
// reads as the heading.
const AXIS_FONT_DEFAULT = 7;
export const CHART_FONT_MIN = 5, CHART_FONT_MAX = 24;
const TITLE_STEP = 2;

/**
 * Every series to draw, as [{ key, name, color, dash, points: [{t, v}] }].
 *
 * The `feeds`-less fallback keeps the legacy flat `data` attr working: the bundled
 * templates author charts as bare number arrays, and they must keep rendering
 * rather than becoming empty frames the moment this widget learned about feeds.
 */
function chartSeries(g) {
  const ink = g.getAttr('ink');
  const feeds = g.getAttr('feeds') || [];
  if (!feeds.length) {
    const data = g.getAttr('data');
    if (!Array.isArray(data) || !data.length) return [];
    return [{
      key: '', name: g.getAttr('title') || '', color: ink, dash: seriesDash(0),
      points: data.map((v, i) => ({ t: i, v: Number(v) })),
    }];
  }
  const series = g.getAttr('series') || {};
  return feeds.map((f, i) => ({
    key: f.key,
    name: f.name || f.key,
    color: f.color || ink,
    dash: seriesDash(i),
    points: (series[f.key] || []).filter((p) => Number.isFinite(Number(p.v)))
      .map((p) => ({ t: p.t, v: Number(p.v) })),
  }));
}

/**
 * The y domain. An authored yMin/yMax wins; a blank one auto-detects across ALL
 * series, not per-series, or two feeds would be drawn on two invisible scales.
 *
 * Log mode needs a strictly positive floor (log10(0) is -Infinity), so it clamps
 * to the smallest positive sample rather than refusing to draw.
 */
function chartDomain(g, all) {
  const log = g.getAttr('yScale') === 'log';
  const vs = all.flatMap((s) => s.points.map((p) => p.v));
  const authoredMin = toNum(g.getAttr('yMin'));
  const authoredMax = toNum(g.getAttr('yMax'));
  let lo = authoredMin ?? (vs.length ? Math.min(...vs) : 0);
  let hi = authoredMax ?? (vs.length ? Math.max(...vs) : 1);
  // Bounds typed the wrong way round are a typo, not an instruction to invert the
  // axis — plotting them as given plots the data upside down with no clue why.
  if (lo > hi) [lo, hi] = [hi, lo];
  if (log) {
    const positives = vs.filter((v) => v > 0);
    const floor = positives.length ? Math.min(...positives) : 1;
    if (lo <= 0) lo = floor;
    if (hi <= lo) hi = lo * 10;
  }
  // A flat series (every sample identical) has a zero span, which would divide by
  // zero in the mapping and draw the line at the very top. Open the window
  // slightly instead so it lands mid-frame.
  if (hi === lo) { lo -= 1; hi += 1; }
  // An auto-detected end is rounded OUT to the tick step, so the axis starts and
  // ends on a labelled round number. Left raw, a 65.01–74.98 range has a single
  // round stop inside it (70) and the ticks fell back to printing the extremes.
  // Authored bounds are the user's and are kept exactly; log keeps its own floor.
  // The step is handed back so the ticks are laid on this same grid (see niceTicks).
  let step;
  if (!log) {
    step = niceStep(lo, hi, 3);
    if (authoredMin === null) lo = snapToStep(lo, step);
    if (authoredMax === null) hi = snapToStep(hi, step, true);
  }
  return { lo, hi, log, step };
}

/**
 * The shared x domain, in milliseconds.
 *
 * Series are placed by TIME, not by array index. Two feeds log at their own rates,
 * so one may hold 12 points where another holds 200 — spread each across the full
 * width by index and the same instant lands at two different x positions, which
 * makes a multi-feed chart actively misleading about what happened together.
 *
 * Returns null when the timestamps aren't parseable dates, which is the legacy
 * `data` path (its `t` is an array index). Index placement is correct there.
 * Only date STRINGS count, which is what IO sends: a bare number is that index,
 * and read as milliseconds it made the unbound sample chart a window a few ms
 * wide on 1 Jan 1970, labelled with the same clock time end to end.
 */
function chartTimeDomain(all) {
  const ms = [];
  for (const s of all) {
    for (const p of s.points) {
      const t = typeof p.t === 'string' ? Date.parse(p.t) : NaN;
      if (!Number.isFinite(t)) return null;
      ms.push(t);
    }
  }
  if (ms.length < 2) return null;
  const lo = Math.min(...ms), hi = Math.max(...ms);
  return hi > lo ? { lo, hi } : null;
}

/**
 * Time labels for the bottom axis when no X caption is authored, as
 * [{ frac, text }] with frac in 0..1 across the plot.
 *
 * Spaced at the vertical grid's cadence (5, else 3, else 2 — every count lands on a
 * grid line) and thinned until they fit, since a 250px panel has room for a few
 * times, not one per sample. A window of a day and a half or less reads as clock
 * times; anything longer as dates, because "14:00" repeated across a week says
 * nothing. Both come from the browser's locale, which is where the bitmap is drawn.
 */
function timeTickLabels(time, plotW, font) {
  const fmt = time.hi - time.lo <= 36 * 3600e3
    ? (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : (ms) => new Date(ms).toLocaleDateString([], { month: 'numeric', day: 'numeric' });
  for (const n of [5, 3, 2]) {
    const labels = Array.from({ length: n }, (_, i) => {
      const frac = i / (n - 1);
      return { frac, text: fmt(time.lo + frac * (time.hi - time.lo)) };
    });
    const widest = Math.max(...labels.map((l) => l.text.length)) * font * 0.62;
    // The ends are pinned inside the plot while the rest centre on their instant, so
    // the tightest pair is an end and its neighbour: one full label plus half of the
    // next has to fit in one step, with a gap to spare.
    const step = plotW / (n - 1);
    if (step >= (n > 2 ? 1.5 : 2) * widest + font) return labels;
  }
  return [];
}

function buildLineChart(g) {
  g.destroyChildren();
  const w = g.getAttr('w'), h = g.getAttr('h');
  const ink = g.getAttr('ink');
  const title = g.getAttr('title') || '';
  const decimals = g.getAttr('decimals') ?? 4;
  const showGrid = !!g.getAttr('gridLines');
  const stepped = !!g.getAttr('stepped');
  const keyLegend = !!g.getAttr('keyLegend');
  const xLabel = g.getAttr('xLabel') || '';
  const yLabel = g.getAttr('yLabel') || '';
  const requestedFont = clamp(Math.round(+g.getAttr('axisFontSize') || AXIS_FONT_DEFAULT),
                              CHART_FONT_MIN, CHART_FONT_MAX);
  const axisFamily = g.getAttr('axisFontFamily') || 'monospace';

  g.add(new Konva.Rect({ width: w, height: h, fill: '#000', opacity: 0 })); // hit area

  const all = chartSeries(g);
  const { lo, hi, log, step } = chartDomain(g, all);
  const time = chartTimeDomain(all);
  const ticks = niceTicks(lo, hi, 3, step).filter((t) => t >= lo && t <= hi);
  // Ticks print at their step's precision (65, 70, 75, not 65.00), switching to
  // exponent form for very small or very large values. See fmtTicks.
  const tickLabels = fmtTicks(ticks, Math.min(decimals, 2));
  // A legend is what tells two lines apart, so it appears as soon as there are two
  // — `keyLegend` chooses the feed KEY over the name, per the IO field, rather than
  // being what switches the legend on. A single line needs no key to itself, so it
  // only gets one when the option is explicitly set.
  const labelled = all.filter((s) => s.name || s.key);
  const showLegend = labelled.length > 1 || (keyLegend && labelled.length === 1);

  /**
   * Every text row and gutter at one axis font size. The plot box gets what is left:
   * every gutter is EARNED by something drawn in it, so a chart with no axis labels
   * and no legend keeps nearly the whole frame for data. The panels this renders to
   * are 250px wide and cannot spare fixed padding.
   */
  const layoutAt = (axisFont, withTimes = true) => {
    const titleFont = axisFont + TITLE_STEP;
    // The data along the axes (Y numbers, X times) sits a step below the captions,
    // so the captions read as the headings for them.
    const tickFont = Math.max(CHART_FONT_MIN - 1, Math.round(axisFont * 0.8));
    const yGutter = yLabel ? axisFont + 1 : 0;                     // rotated Y caption
    // Y tick numbers, drawn whether or not the grid is. Capped: a pressure feed
    // reading 1013.25 wants 7 characters, which on a 120px chart would spend a
    // quarter of the frame on labels for the data itself.
    const tickW = ticks.length
      ? Math.min(Math.round(Math.max(...tickLabels.map((l) => l.length)) * tickFont * 0.62) + 1,
                 Math.floor(w * 0.28))
      : 0;
    const left = yGutter + tickW + 1;
    const top = title ? titleFont + 3 : 1;
    const legendH = showLegend ? axisFont + 2 : 0;
    // The X axis mirrors the Y: times under the axis, as the Y has its tick numbers,
    // whenever the samples carry real timestamps (the legacy sample data doesn't),
    // and the X caption on its own row beneath them, as the Y has its own gutter.
    const plotW = Math.max(4, w - left - 1);
    const timeLabels = withTimes && time ? timeTickLabels(time, plotW, tickFont) : [];
    const timeRowH = timeLabels.length ? tickFont + 1 : 0;
    const bottom = 1 + timeRowH + (xLabel ? axisFont + 1 : 0) + legendH;
    return { axisFont, titleFont, tickFont, yGutter, tickW, left, top, legendH,
             plotW, timeLabels, timeRowH, plotH: h - top - bottom };
  };
  // The requested size is a ceiling, not a promise. The rows it asks for (title,
  // times, X caption, legend) must leave the plot a usable share of the height, or
  // the text crowds the data out and spills past the frame. So the size steps down
  // until they do. At the floor size a tiny chart can still run out, so the time
  // row goes last, as the only row nobody typed.
  const minPlotH = Math.max(12, Math.round(h * 0.3));
  let lay = layoutAt(requestedFont);
  for (let f = requestedFont - 1; lay.plotH < minPlotH && f >= CHART_FONT_MIN; f--) lay = layoutAt(f);
  if (lay.plotH < 4) lay = layoutAt(lay.axisFont, false);
  const { axisFont, titleFont, tickFont, yGutter, tickW, left, top, legendH,
          plotW, timeLabels, timeRowH } = lay;
  // Read back by the inspector, which says so when the size was cut down. Not
  // serialized: it is derived, and the next build recomputes it.
  g.setAttr('axisFontFit', axisFont);
  const plot = {
    x: left, y: top,
    w: plotW,
    h: Math.max(4, lay.plotH),
  };
  /**
   * x for one sample. Time-based when the timestamps are real dates, so every
   * series shares one axis; index-based only for the legacy sample data.
   */
  const px = (p, i, n) => {
    if (time) {
      const t = typeof p.t === 'number' ? p.t : Date.parse(p.t);
      return plot.x + clamp((t - time.lo) / (time.hi - time.lo), 0, 1) * plot.w;
    }
    return plot.x + (n < 2 ? 0 : (i / (n - 1)) * plot.w);
  };
  const py = (v) => plot.y + (1 - clamp(scaleUnit(v, lo, hi, log), 0, 1)) * plot.h;

  if (title) {
    g.add(new Konva.Text({
      text: title, fontSize: titleFont, fontFamily: axisFamily, fontStyle: 'bold', fill: ink,
      x: 1, y: 0, width: Math.max(4, w - 2), wrap: 'none', ellipsis: true,
    }));
  }

  // Y ticks: a number beside each, and either a grid line across the plot or,
  // without the grid, a short mark on the axis so the number points at a height.
  // Drawn before the axis and the data, so neither is overdrawn by a grid line.
  // Each number is centred on its tick but kept clear of the title above and the
  // frame's bottom edge, which the top and bottom ticks would otherwise cross.
  const tickMinY = title ? titleFont + 1 : 0;
  ticks.forEach((t, i) => {
    const y = Math.round(py(t)) + 0.5;
    g.add(new Konva.Line({
      points: [plot.x, y, showGrid ? plot.x + plot.w : plot.x + 3, y],
      strokeWidth: 1, ...(showGrid ? faintStroke(ink, 0.35) : { stroke: ink }),
    }));
    g.add(new Konva.Text({
      text: tickLabels[i], fontSize: tickFont, fontFamily: axisFamily, fill: ink,
      x: yGutter, y: clamp(Math.round(y - tickFont / 2), tickMinY, h - tickFont),
      width: tickW, align: 'right',
    }));
  });
  if (showGrid) {
    // Vertical grid at the same cadence as the horizontal one, so the mesh reads
    // as a grid rather than as ruled paper.
    const cols = 4;
    for (let c = 1; c < cols; c++) {
      const x = Math.round(plot.x + (c / cols) * plot.w) + 0.5;
      g.add(new Konva.Line({
        points: [x, plot.y, x, plot.y + plot.h], strokeWidth: 1, ...faintStroke(ink, 0.35),
      }));
    }
  }

  // L-shaped axis: left rule + bottom rule.
  g.add(new Konva.Line({
    points: [plot.x + 0.5, plot.y, plot.x + 0.5, plot.y + plot.h + 0.5,
             plot.x + plot.w, plot.y + plot.h + 0.5],
    stroke: ink, strokeWidth: 1,
  }));

  // The Y caption reads bottom-to-top in the leftmost gutter, the one orientation
  // that fits: laid out horizontally it would need a gutter wider than the plot on
  // a 250px panel.
  if (yLabel) {
    g.add(new Konva.Text({
      text: yLabel, fontSize: axisFont, fontFamily: axisFamily, fill: ink,
      x: 0, y: plot.y + plot.h, rotation: -90, width: plot.h, align: 'center',
    }));
  }
  if (xLabel) {
    g.add(new Konva.Text({
      text: xLabel, fontSize: axisFont, fontFamily: axisFamily, fill: ink,
      x: plot.x, y: plot.y + plot.h + 2 + timeRowH, width: plot.w, align: 'center',
    }));
  }
  if (timeLabels.length) {
    // The ends are pinned inside the plot (left- and right-aligned) rather than
    // centred on their instant, so the first and last times can't hang off the frame.
    timeLabels.forEach(({ frac, text }) => {
      const tw = Math.ceil(text.length * tickFont * 0.62) + 2;
      const x = plot.x + frac * plot.w;
      const [bx, align] = frac === 0 ? [plot.x, 'left']
        : frac === 1 ? [plot.x + plot.w - tw, 'right'] : [x - tw / 2, 'center'];
      g.add(new Konva.Text({
        text, fontSize: tickFont, fontFamily: axisFamily, fill: ink,
        x: Math.round(bx), y: plot.y + plot.h + 2, width: tw, align, wrap: 'none',
      }));
    });
  }

  // One line per series, drawn last so data always sits on top of the grid.
  all.forEach((s) => {
    if (!s.points.length) return;
    // A single sample has no line to draw — Konva would silently render nothing, so
    // a feed that has just started logging would look identical to a broken
    // binding. Mark it instead.
    if (s.points.length === 1) {
      g.add(new Konva.Circle({
        x: px(s.points[0], 0, 1), y: py(s.points[0].v), radius: 1.5, fill: s.color,
      }));
      return;
    }
    const pts = [];
    s.points.forEach((p, i) => {
      const x = px(p, i, s.points.length), y = py(p.v);
      // A stepped line holds each sample until the next one arrives, which is what
      // a logic level or a thermostat state actually did between readings — an
      // interpolated diagonal invents a transition that never happened.
      if (stepped && i > 0) pts.push(x, py(s.points[i - 1].v));
      pts.push(x, y);
    });
    g.add(new Konva.Line({
      points: pts, stroke: s.color, strokeWidth: 1,
      dash: s.dash.length ? s.dash : undefined,
      lineJoin: stepped ? 'miter' : 'round',
    }));
  });

  if (legendH) {
    let x = plot.x;
    const y = h - legendH + 1;
    labelled.forEach((s) => {
      const text = keyLegend ? (s.key || s.name) : (s.name || s.key);
      const entryW = 10 + Math.ceil(text.length * axisFont * 0.62) + 5;
      // Clipped rather than wrapped or shrunk: the legend is one row by design, and
      // silently overflowing it would draw feed names off the edge of the panel.
      if (x + entryW > w && x > plot.x) return;
      // A dash sample rather than a colour chip: the dash is the part that survives
      // a mono panel, so it is the part the legend has to show.
      g.add(new Konva.Line({
        points: [x, y + axisFont / 2, x + 8, y + axisFont / 2],
        stroke: s.color, strokeWidth: 1, dash: s.dash.length ? s.dash : undefined,
      }));
      g.add(new Konva.Text({
        text, fontSize: axisFont, fontFamily: axisFamily, fill: ink,
        x: x + 10, y, width: Math.max(4, w - x - 10), ellipsis: true, wrap: 'none',
      }));
      x += entryW;
    });
  }
}

export function addLineChart(attrs = {}) {
  const { w, h } = logicalDims();
  const g = new Konva.Group({
    x: attrs.x ?? Math.round(w / 2 - 60), y: attrs.y ?? Math.round(h / 2 - 30),
    draggable: true, name: 'element', id: nextId(),
  });
  g.setAttr('etype', 'linechart');
  g.setAttr('w', attrs.w ?? 120);
  g.setAttr('h', attrs.h ?? 60);
  g.setAttr('ink', attrs.ink ?? PALETTES[display.type][0]);
  g.setAttr('title', attrs.title ?? '');
  // Bound feeds and their fetched history. Copied rather than aliased so a saved
  // doc passed straight back in (which is how deserialize works) can't share
  // arrays with the live node.
  g.setAttr('feeds', (attrs.feeds ?? []).map((f) => ({
    key: f.key, name: f.name || f.key, color: f.color || PALETTES[display.type][0],
  })));
  g.setAttr('series', Object.fromEntries(
    Object.entries(attrs.series ?? {}).map(([k, pts]) =>
      [k, (pts || []).map((p) => ({ t: p.t, v: p.v }))])));
  g.setAttr('hours', attrs.hours ?? 24);
  g.setAttr('xLabel', attrs.xLabel ?? '');
  g.setAttr('yLabel', attrs.yLabel ?? '');
  // Blank, not 0 — these are "auto-detect unless authored", and 0 is a legitimate
  // authored bound that must not be confused with "unset".
  g.setAttr('yMin', attrs.yMin ?? '');
  g.setAttr('yMax', attrs.yMax ?? '');
  g.setAttr('yScale', attrs.yScale ?? 'linear');
  g.setAttr('decimals', attrs.decimals ?? 4);
  g.setAttr('rawOnly', attrs.rawOnly ?? false);
  g.setAttr('stepped', attrs.stepped ?? false);
  g.setAttr('gridLines', attrs.gridLines ?? false);
  g.setAttr('keyLegend', attrs.keyLegend ?? false);
  g.setAttr('axisFontSize', attrs.axisFontSize ?? AXIS_FONT_DEFAULT);
  g.setAttr('axisFontFamily', attrs.axisFontFamily ?? 'monospace');
  // Legacy sample data. Only reached when no feeds are bound (see chartSeries), so
  // a fresh unbound chart still shows a shape instead of an empty frame.
  g.setAttr('data', attrs.data ?? randTempSeries());
  buildLineChart(g);
  wireNode(g);
  layer.add(g);
  return g;
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

/** The ring's sweep. Leaves a gap at the bottom so full and empty differ. */
const GAUGE_SWEEP = 270;
const GAUGE_START = 135;   // Konva rotation: 0 is 3 o'clock, so 135 is lower-left.

/** Numeric sample, or null for unbound / unread / non-numeric. */
export function gaugeValue(g) { return toNum(g.getAttr('gaugeValue')); }

/**
 * The range, always ordered. Read through one helper so the ring and the colour
 * can't disagree about it — and swapped rather than honoured when the fields are
 * typed the wrong way round, which is a typo, not a request for an inverted gauge.
 */
function gaugeRange(g) {
  const a = toNum(g.getAttr('min')) ?? 0;
  const b = toNum(g.getAttr('max')) ?? 100;
  return a <= b ? { min: a, max: b } : { min: b, max: a };
}

/**
 * How far round the ring the value sits, 0..1. Unknown reads as EMPTY rather than
 * full, the same policy as batteryFraction: a broken binding has to look broken
 * instead of looking like a healthy reading.
 */
export function gaugeFraction(g) {
  const v = gaugeValue(g);
  if (v === null) return null;
  const { min, max } = gaugeRange(g);
  if (max === min) return 0;
  return clamp((v - min) / (max - min), 0, 1);
}

/** Which of the three colours the reading calls for. */
function gaugeInk(g) {
  const v = gaugeValue(g);
  const ink = g.getAttr('ink');
  if (v === null) return ink;
  const { min, max } = gaugeRange(g);
  // Out of range wins outright — IO recolours here whether or not warning values
  // were given, because a reading off the end of the scale is the louder fault.
  if (v < min || v > max) return g.getAttr('alarmColor') || ink;
  const low = toNum(g.getAttr('lowWarn'));
  const high = toNum(g.getAttr('highWarn'));
  if ((low !== null && v <= low) || (high !== null && v >= high)) {
    return g.getAttr('warnColor') || ink;
  }
  return ink;
}

function buildGauge(g) {
  g.destroyChildren();
  const w = g.getAttr('w');
  const ink = g.getAttr('ink');
  const title = g.getAttr('title') || '';
  const label = g.getAttr('gaugeLabel') || '';
  const decimals = g.getAttr('decimals') ?? 2;
  const showIcon = !!g.getAttr('showIcon');

  const titleFont = 9;
  const titleH = title ? titleFont + 3 : 0;
  const r = w / 2;
  // The ring can be no thicker than its own radius, or the hole closes and the
  // value has nowhere to sit. Authored in px because that is what the IO field is.
  const thickness = clamp(Math.round(toNum(g.getAttr('ringWidth')) ?? 25), 1, Math.max(1, r - 1));
  const cx = r, cy = titleH + r;
  const H = titleH + w;
  g.setAttr('h', H);                    // derived from width, as it always was

  g.add(new Konva.Rect({ width: w, height: H, fill: '#000', opacity: 0 })); // hit area

  if (title) {
    g.add(new Konva.Text({
      text: title, fontSize: titleFont, fontFamily: 'monospace', fill: ink,
      x: 0, y: 0, width: w, align: 'center',
    }));
  }

  const frac = gaugeFraction(g);
  const valueInk = gaugeInk(g);
  const arc = { x: cx, y: cy, innerRadius: r - thickness, outerRadius: r, rotation: GAUGE_START };

  // The empty track is drawn faintly rather than omitted: without it, a low reading
  // gives no clue how much scale is left. On a mono panel a stipple of ink is the only
  // way to say "this part is the background" (see faintFill).
  g.add(new Konva.Arc({ ...arc, angle: GAUGE_SWEEP, ...faintFill(ink, 0.25, { x: cx, y: cy }) }));
  if (frac !== null && frac > 0) {
    g.add(new Konva.Arc({ ...arc, angle: GAUGE_SWEEP * frac, fill: valueInk }));
  }

  // Everything inside the hole is laid out against the inscribed square of the
  // inner circle, so a thick ring shrinks the type instead of colliding with it.
  const inner = (r - thickness) * 2 * 0.707;
  const valueFont = clamp(Math.round(inner * 0.34), 6, 40);
  const labelFont = clamp(Math.round(valueFont * 0.6), 5, 20);
  const iconFont = showIcon ? clamp(Math.round(valueFont * 0.8), 6, 32) : 0;
  const gap = 1;
  const stackH = (iconFont ? iconFont + gap : 0) + valueFont + (label ? labelFont + gap : 0);
  let y = Math.round(cy - stackH / 2);

  if (iconFont) {
    g.add(new Konva.Text({
      text: iconGlyph(g.getAttr('icon')),
      fontSize: iconFont, fontFamily: FA_FAMILY, fontStyle: FA_WEIGHT,
      fill: valueInk, x: 0, y, width: w, align: 'center',
    }));
    y += iconFont + gap;
  }
  g.add(new Konva.Text({
    text: frac === null ? '—' : fmtDecimals(gaugeValue(g), decimals),
    fontSize: valueFont, fontFamily: 'monospace', fill: valueInk,
    x: 0, y, width: w, align: 'center',
  }));
  y += valueFont + gap;
  if (label) {
    g.add(new Konva.Text({
      text: label, fontSize: labelFont, fontFamily: 'monospace', fill: ink,
      x: 0, y, width: w, align: 'center',
    }));
  }
}

export function addGauge(attrs = {}) {
  const { w, h } = logicalDims();
  const g = new Konva.Group({
    x: attrs.x ?? Math.round(w / 2 - 45), y: attrs.y ?? Math.round(h / 2 - 45),
    draggable: true, name: 'element', id: nextId(),
  });
  const ink = attrs.ink ?? PALETTES[display.type][0];
  g.setAttr('etype', 'gauge');
  g.setAttr('w', attrs.w ?? 90);
  g.setAttr('ink', ink);
  g.setAttr('title', attrs.title ?? '');
  g.setAttr('min', attrs.min ?? 0);
  g.setAttr('max', attrs.max ?? 100);
  g.setAttr('ringWidth', attrs.ringWidth ?? 12);
  g.setAttr('gaugeLabel', attrs.gaugeLabel ?? 'Value');
  g.setAttr('lowWarn', attrs.lowWarn ?? '');
  g.setAttr('highWarn', attrs.highWarn ?? '');
  g.setAttr('decimals', attrs.decimals ?? 2);
  g.setAttr('showIcon', attrs.showIcon ?? false);
  g.setAttr('icon', attrs.icon ?? DEFAULT_GAUGE_ICON);
  // Both alarm colours default to plain ink, which exists in EVERY palette — see
  // the note on addIndicator about positional shortcuts. A quadcolor panel is where
  // the user will actually set these to red.
  g.setAttr('warnColor', attrs.warnColor ?? ink);
  g.setAttr('alarmColor', attrs.alarmColor ?? ink);
  g.setAttr('feedKey', attrs.feedKey ?? '');
  g.setAttr('feedName', attrs.feedName ?? '');
  // `gaugeValue`, not `value` — see FEED_VALUE_ATTR. `attrs.value` is the migration
  // path for docs saved before the rename, which is the only place it appears:
  // deserialize hands the saved object straight to this factory, so the factory IS
  // the migration point (nothing reads the doc's `version`).
  g.setAttr('gaugeValue', attrs.gaugeValue ?? attrs.value ?? (attrs.feedKey ? null : randTemp()));
  buildGauge(g);
  wireNode(g);
  layer.add(g);
  return g;
}

// ---------- indicator: on/off lamp driven by an Adafruit IO feed -------------

/** Operators are stored as JSON-safe tokens and shown as symbols in the UI. */
export const INDICATOR_OPS = [
  { op: 'eq', label: '=' }, { op: 'ne', label: '≠' },
  { op: 'gt', label: '>' }, { op: 'lt', label: '<' },
  { op: 'ge', label: '≥' }, { op: 'le', label: '≤' },
];

/**
 * Numeric when BOTH sides parse as finite numbers, else a case-insensitive
 * string compare: all values are assumed numeric, and a feed value that can't
 * be converted to a number is treated as a string.
 */
export function compareValues(raw, op, cmp) {
  const a = Number(raw), b = Number(cmp);
  const numeric = String(raw).trim() !== '' && String(cmp).trim() !== ''
    && Number.isFinite(a) && Number.isFinite(b);
  const [x, y] = numeric
    ? [a, b]
    : [String(raw ?? '').trim().toLowerCase(), String(cmp ?? '').trim().toLowerCase()];
  switch (op) {
    case 'eq': return x === y;
    case 'ne': return x !== y;
    case 'gt': return x > y;
    case 'lt': return x < y;
    case 'ge': return x >= y;
    case 'le': return x <= y;
    default:   return false;
  }
}

/** An unavailable value (never bound, fetch failed, empty feed) is false -> Off. */
export function indicatorValueKnown(g) {
  const v = g.getAttr('value');
  return v !== null && v !== undefined && v !== '';
}

function evalIndicator(g) {
  if (!indicatorValueKnown(g)) return false;
  return compareValues(g.getAttr('value'), g.getAttr('op'), g.getAttr('cmp'));
}

function buildIndicator(g) {
  g.destroyChildren();
  const w = g.getAttr('w');
  g.setAttr('h', w);                                                        // square
  g.add(new Konva.Rect({ width: w, height: w, fill: '#000', opacity: 0 })); // hit area
  // The outline is not decoration: on a mono panel the palette is only ink and
  // paper, so an Off lamp filled with paper would be invisible against the page.
  g.add(new Konva.Circle({
    x: w / 2, y: w / 2, radius: Math.max(1, w / 2 - 1),
    fill: evalIndicator(g) ? g.getAttr('onColor') : g.getAttr('offColor'),
    stroke: g.getAttr('ink'), strokeWidth: 1,
  }));
}

export function addIndicator(attrs = {}) {
  const { w: cw, h: ch } = logicalDims();
  const g = new Konva.Group({
    x: attrs.x ?? Math.round(cw / 2 - 8), y: attrs.y ?? Math.round(ch / 2 - 8),
    draggable: true, name: 'element', id: nextId(),
  });
  g.setAttr('etype', 'indicator');
  g.setAttr('w', attrs.w ?? 16);
  // Defaults use the darkest ink and the display background, both of which exist
  // in EVERY palette (the background is snapped to it). Positional shortcuts don't:
  // [1] is a dark grey on gray4, and the last entry is paper on gray4 (an invisible
  // "on" lamp). Off follows the background so an unlit lamp reads as unlit on a
  // dark or coloured page too, not as a paper-white dot.
  g.setAttr('onColor', attrs.onColor ?? PALETTES[display.type][0]);
  g.setAttr('offColor', attrs.offColor ?? display.background);
  g.setAttr('ink', attrs.ink ?? PALETTES[display.type][0]);
  g.setAttr('op', attrs.op ?? 'eq');
  g.setAttr('cmp', attrs.cmp ?? '1');
  g.setAttr('feedKey', attrs.feedKey ?? '');
  g.setAttr('feedName', attrs.feedName ?? '');
  g.setAttr('value', attrs.value ?? null);
  buildIndicator(g);
  wireNode(g);
  layer.add(g);
  return g;
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

const BATTERY_ASPECT = 0.5;    // body height as a fraction of body width

/**
 * Bar length only. Unknown or non-numeric reads as EMPTY, not full: a broken
 * feed binding should look obviously wrong rather than like a healthy battery.
 */
export function batteryFraction(g) {
  const raw = g.getAttr('feedValue');
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const v = Number(raw);
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(1, v / 100));
}

/** First matching condition wins, top to bottom. */
function batteryShade(g) {
  const raw = g.getAttr('feedValue');
  if (raw !== null && raw !== undefined && raw !== '') {
    for (const c of g.getAttr('conds') || [])
      if (compareValues(raw, c.op, c.cmp)) return c.color;
  }
  return g.getAttr('defaultShade');
}

function buildBattery(g) {
  g.destroyChildren();
  const w = g.getAttr('w');
  const ink = g.getAttr('ink');
  const bodyH = Math.max(6, Math.round(w * BATTERY_ASPECT));
  const nubW = Math.max(2, Math.round(w * 0.07));
  const nubH = Math.max(2, Math.round(bodyH * 0.4));
  const bodyW = w - nubW;                       // `w` is the whole icon, nub included
  g.setAttr('h', bodyH);                        // derived from width, as buildGauge does

  const frac = batteryFraction(g);
  const pctText = frac === null ? '—' : `${Math.round(Number(g.getAttr('feedValue')))}%`;
  const fontSize = Math.max(7, Math.round(bodyH * 0.6));
  // Reserve a fixed 4-character box so the icon doesn't shift as the value changes.
  const textW = g.getAttr('showPct') ? Math.ceil(fontSize * 0.62 * 4) : 0;
  const gap = g.getAttr('showPct') ? Math.max(2, Math.round(w * 0.08)) : 0;
  const totalW = w + gap + textW;

  // Hit area spans the percentage text too, so the whole widget is grabbable.
  g.add(new Konva.Rect({ width: totalW, height: bodyH, fill: '#000', opacity: 0 }));

  // Body outline. Always drawn in ink, never in the condition shade: on a mono
  // panel a paper-shaded fill is invisible, so the outline is what keeps the
  // battery on the page at all. Same reasoning as the indicator's lamp stroke.
  g.add(new Konva.Rect({
    x: 0.5, y: 0.5, width: bodyW - 1, height: bodyH - 1,
    stroke: ink, strokeWidth: 1, cornerRadius: 1,
  }));
  // Terminal nub on the right edge.
  g.add(new Konva.Rect({
    x: bodyW, y: Math.round((bodyH - nubH) / 2), width: nubW, height: nubH, fill: ink,
  }));

  // Fill bar, inset inside the outline so the two never touch.
  const inset = 2;
  const innerW = bodyW - 1 - inset * 2;
  const innerH = bodyH - 1 - inset * 2;
  if (frac !== null && frac > 0 && innerW > 0 && innerH > 0) {
    g.add(new Konva.Rect({
      x: inset + 0.5, y: inset + 0.5,
      width: Math.max(1, Math.round(innerW * frac)), height: innerH,
      fill: batteryShade(g),
    }));
  }

  if (g.getAttr('showPct')) {
    g.add(new Konva.Text({
      text: pctText, fontSize, fontFamily: 'monospace', fill: ink,
      x: w + gap, y: Math.round((bodyH - fontSize) / 2), width: textW, align: 'left',
    }));
  }
}

export function addBattery(attrs = {}) {
  const { w: cw, h: ch } = logicalDims();
  const g = new Konva.Group({
    x: attrs.x ?? Math.round(cw / 2 - 24), y: attrs.y ?? Math.round(ch / 2 - 12),
    draggable: true, name: 'element', id: nextId(),
  });
  const ink = attrs.ink ?? PALETTES[display.type][0];
  g.setAttr('etype', 'battery');
  g.setAttr('w', attrs.w ?? 48);
  // Every default resolves to the darkest ink, which exists in EVERY palette —
  // positional shortcuts don't (see the note on addIndicator). Both the seeded
  // condition and the fallback are visible the moment the widget is dropped.
  g.setAttr('ink', ink);
  g.setAttr('showPct', attrs.showPct ?? false);
  g.setAttr('conds', (attrs.conds ?? [{ op: 'lt', cmp: '20', color: ink }])
    .map((c) => ({ op: c.op, cmp: c.cmp, color: c.color })));
  g.setAttr('defaultShade', attrs.defaultShade ?? ink);
  g.setAttr('feedKey', attrs.feedKey ?? '');
  g.setAttr('feedName', attrs.feedName ?? '');
  g.setAttr('feedValue', attrs.feedValue ?? null);   // not 'value' — see FEED_VALUE_ATTR
  buildBattery(g);
  wireNode(g);
  layer.add(g);
  return g;
}

// ---------- image -----------------------------------------------------------

const IMG_MAX_BYTES = 25 * 1024 * 1024; // 25 MB per file

/**
 * A picture's own dither, from saved attrs. Left unset for 'inherit' (or anything this
 * editor doesn't know), which is how a picture that follows the panel default is stored —
 * see imagedither.js.
 */
function applyImageDither(node, attrs) {
  if (IMAGE_DITHERS.includes(attrs.dither) && attrs.dither !== 'inherit') {
    node.setAttr('dither', attrs.dither);
    if (attrs.dither === 'FloydSteinberg' && Number.isFinite(attrs.diffusion)) {
      node.setAttr('diffusion', clamp(Math.round(attrs.diffusion), 0, 100));
    }
  }
}

/** The dither attrs to carry across when a picture changes element type. */
const imageDitherAttrs = (n) => ({ dither: n.getAttr('dither'), diffusion: n.getAttr('diffusion') });
const IMG_TYPES = ['image/png', 'image/jpeg', 'image/bmp', 'image/x-ms-bmp'];

export function addImage(imageObj, attrs = {}) {
  const { w: cw, h: ch } = logicalDims();
  const iw = imageObj.width, ih = imageObj.height;
  // Default: fit within the panel while keeping aspect ratio.
  let dw = attrs.w, dh = attrs.h;
  if (dw === undefined || dh === undefined) {
    const scale = Math.min(1, (cw * 0.8) / iw, (ch * 0.8) / ih);
    dw = Math.max(1, Math.round(iw * scale));
    dh = Math.max(1, Math.round(ih * scale));
  }
  const node = new Konva.Image({
    image: imageObj,
    x: attrs.x ?? Math.round((cw - dw) / 2),
    y: attrs.y ?? Math.round((ch - dh) / 2),
    width: dw, height: dh,
    draggable: true, name: 'element', id: nextId(),
  });
  node.setAttr('etype', 'image');
  node.setAttr('natW', iw);
  node.setAttr('natH', ih);
  if (attrs.src) node.setAttr('src', attrs.src); // data URL kept for save/load
  applyImageDither(node, attrs);
  wireNode(node);
  layer.add(node);
  return node;
}

/** Load a File into an <img>, enforcing type + size, then place it. */
export function loadImageFile(file) {
  if (!file) return;
  const typeOk = IMG_TYPES.includes(file.type) || /\.(png|jpe?g|bmp)$/i.test(file.name);
  if (!typeOk) { toast('Only PNG, JPEG and BMP images are allowed'); return; }
  if (file.size > IMG_MAX_BYTES) {
    toast(`Image is ${(file.size / 1048576).toFixed(1)} MB — 25 MB limit`);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const node = addImage(img, { src: reader.result });
      select(node);
      toast(`Placed ${img.width}×${img.height} image`);
    };
    img.onerror = () => toast('Could not decode that image');
    img.src = reader.result;
  };
  reader.onerror = () => toast('Could not read that file');
  reader.readAsDataURL(file); // data URL so it round-trips through save/load
}

// ---------- feed image ------------------------------------------------------
//
// A picture read from an Adafruit IO feed — a camera project's latest frame, say. A
// widget, not a Konva.Image, because the thing the user authors is a FRAME on the panel
// and the picture is a sample that changes shape from one reading to the next; the
// group's `w`×`h` is the frame, and each new picture is placed into it by fitRect().
// The decoded <img> rides in the `imageObj` attr (never serialized); `src` is the data
// URL that round-trips through canvas.json, as it does for a static image.

/**
 * Where a decode in flight for each node can be awaited. deserialize() needs it the way
 * it needs a static image's decode: a caller photographing the canvas straight after a
 * load must not capture the frame before its picture has arrived.
 */
const feedImageLoads = new WeakMap();

/** Resolves once the picture `addFeedImage()` or `setFeedImageSrc()` last started decoding is in. */
export function feedImageSettled(g) {
  return feedImageLoads.get(g) || Promise.resolve(true);
}

function buildFeedImage(g) {
  g.destroyChildren();
  const w = Math.max(1, Math.round(g.getAttr('w') || 1));
  const h = Math.max(1, Math.round(g.getAttr('h') || 1));
  // Hit area spans the whole frame, so an empty one is still grabbable.
  g.add(new Konva.Rect({ width: w, height: h, fill: '#000', opacity: 0 }));
  const img = g.getAttr('imageObj');
  if (img) {
    const r = fitRect(g.getAttr('natW') || img.width, g.getAttr('natH') || img.height, w, h,
      g.getAttr('fit') || 'contain');
    const node = new Konva.Image({ image: img, x: r.x, y: r.y, width: r.w, height: r.h });
    if (r.crop) node.crop(r.crop);
    g.add(node);
    return;
  }
  // No picture yet: an outline, so the frame is visible on the canvas — and on the panel,
  // where an empty feed should look like an empty feed rather than like nothing at all.
  // The same honesty as a linked label's em dash.
  const ink = PALETTES[display.type][0];
  g.add(new Konva.Rect({
    x: 0.5, y: 0.5, width: w - 1, height: h - 1, stroke: ink, strokeWidth: 1, dash: [3, 3],
  }));
  if (w >= 40 && h >= 14) {
    const fontSize = clamp(Math.round(Math.min(w / 8, h / 3)), 7, 14);
    g.add(new Konva.Text({
      text: g.getAttr('feedKey') ? 'no image yet' : 'IO image', fontSize, fontFamily: 'monospace',
      fill: ink, width: w, y: Math.round((h - fontSize) / 2), align: 'center',
    }));
  }
}

/**
 * Decode a data URL into an <img>, or null when the browser cannot. parseFeedImage() only
 * checks the signature, so a truncated file passes it and fails here; callers that are
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
 * unbind, and captured by the asynchronous paths (a feed read, a decode) when they start:
 * a result that comes back under a different generation belongs to a binding that no
 * longer exists and is dropped. A frame rebound from feed A to feed B while A's read was
 * in flight must never end up showing A's picture.
 */
export function feedImageGen(g) { return g.getAttr('feedGen') || 0; }

/** Point a frame at a feed (or at nothing), invalidating whatever was in flight for it. */
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
 * Decode a data URL into the frame. Resolves true once the picture is showing, false
 * when it could not be decoded or no longer belongs — in which case the previous picture
 * is LEFT IN PLACE, matching refreshFeedElements' rule that a failed read never blanks an
 * element.
 *
 * Only the newest call per node lands, and a superseded call resolves with the NEWEST
 * call's outcome rather than its own: the caller is a take about to photograph the
 * canvas, and "done" has to mean the frame shows the latest picture, not that this
 * particular decode finished. The binding generation is checked as well, so a decode
 * started under a binding that has since been changed or removed is dropped.
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

export function addFeedImage(attrs = {}) {
  const { w: cw, h: ch } = logicalDims();
  // A third of the panel, landscape — big enough to read a camera frame, small enough
  // to leave room for the caption that usually goes with one.
  const w = attrs.w ?? Math.max(MIN_WIDGET_W.feedimage, Math.round(cw / 3));
  const h = attrs.h ?? Math.max(MIN_WIDGET_H.feedimage, Math.round(w * 0.75));
  const g = new Konva.Group({
    x: attrs.x ?? Math.round((cw - w) / 2), y: attrs.y ?? Math.round((ch - h) / 2),
    draggable: true, name: 'element', id: nextId(),
  });
  g.setAttr('etype', 'feedimage');
  g.setAttr('w', w);
  g.setAttr('h', h);
  g.setAttr('fit', FEED_IMAGE_FITS.some((f) => f.id === attrs.fit) ? attrs.fit : 'contain');
  g.setAttr('feedKey', attrs.feedKey ?? '');
  g.setAttr('feedName', attrs.feedName ?? '');
  g.setAttr('natW', attrs.natW ?? null);
  g.setAttr('natH', attrs.natH ?? null);
  g.setAttr('src', attrs.src ?? null);
  // An already-decoded picture (the static-image conversion below) shows at once; a
  // saved data URL decodes in the background and the frame fills in when it lands.
  if (attrs.imageObj) g.setAttr('imageObj', attrs.imageObj);
  applyImageDither(g, attrs);
  buildFeedImage(g);
  wireNode(g);
  layer.add(g);
  if (!attrs.imageObj && attrs.src) setFeedImageSrc(g, attrs.src);
  return g;
}

/**
 * Turn a static image into a feed image in place: same spot, same box, same picture
 * until the first reading replaces it. The frame is the box the user had already sized,
 * so nothing on the canvas moves.
 */
export function imageToFeedImage(node, attrs = {}) {
  const g = addFeedImage({
    x: node.x(), y: node.y(), w: Math.round(node.width()), h: Math.round(node.height()),
    src: node.getAttr('src'), natW: node.getAttr('natW'), natH: node.getAttr('natH'),
    imageObj: node.image(),
    ...imageDitherAttrs(node),
    ...attrs,
  });
  g.zIndex(node.zIndex());
  node.destroy();
  return g;
}

/**
 * The reverse: unlink a feed image and keep its picture as a plain, static image, drawn
 * exactly where the frame was showing it (so a 'contain' fit's letterbox bars vanish
 * and nothing visible moves). Returns the new node, or null — and leaves the frame in
 * place — when there is no picture to keep.
 */
export function feedImageToImage(g) {
  let img = g.getAttr('imageObj');
  if (!img) return null;
  const r = fitRect(g.getAttr('natW') || img.width, g.getAttr('natH') || img.height,
    g.getAttr('w'), g.getAttr('h'), g.getAttr('fit') || 'contain');
  let src = g.getAttr('src');
  // A 'cover' fit was showing a WINDOW of the picture. A plain image has no crop, so the
  // window is baked into a new picture — what was on the glass stays on the glass, and
  // the static image's own data URL carries it through save and load without the
  // document format learning a crop.
  if (r.crop) {
    const c = document.createElement('canvas');
    c.width = r.crop.width;
    c.height = r.crop.height;
    c.getContext('2d').drawImage(img, r.crop.x, r.crop.y, r.crop.width, r.crop.height,
      0, 0, r.crop.width, r.crop.height);
    img = c;
    src = c.toDataURL('image/png');
  }
  const node = addImage(img, { x: g.x() + r.x, y: g.y() + r.y, w: r.w, h: r.h, src, ...imageDitherAttrs(g) });
  node.zIndex(g.zIndex());
  g.destroy();
  return node;
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

// ---------- icon font gate ---------------------------------------------------

/**
 * Re-draw every gauge showing an icon once the Font Awesome face has actually
 * loaded. @font-face loading is lazy and Konva paints icons as canvas text, so the
 * first build after a cold load would rasterise the browser's substitute glyph —
 * and the dither preview would then cache that as if it were the artwork.
 *
 * Called once from boot. Cheap when nothing uses an icon: no icon, no rebuild.
 */
export function initIconFont() {
  onFaReady(() => {
    const withIcons = layer.find('.element')
      .filter((n) => n.getAttr('etype') === 'gauge' && n.getAttr('showIcon'));
    if (!withIcons.length) return;
    withIcons.forEach(rebuildWidget);
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
    // Same for a feed image — but its empty-frame placeholder is drawn in the darkest
    // ink of the palette at build time, so it is rebuilt to pick up the new one.
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
