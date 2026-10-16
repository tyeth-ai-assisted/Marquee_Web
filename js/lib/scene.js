/**
 * The scene: canvas.json elements as Konva nodes, with no editor attached. Builds
 * every element type, rebuilds widgets from their attrs, serializes a node back to
 * its saved shape, and lays a whole document out for rendering.
 *
 * Konva is passed in rather than imported, so each host brings its own: the editor's
 * vendored global, Adafruit IO's npm copy, a server's canvas-backed build. `display`
 * is the panel descriptor ({ type, background, ... }); it only supplies defaults for
 * attrs a document leaves out. Dragging, selection, ids and the stage are the
 * editor's (canvas/elements.js).
 */

import { PAPER, PALETTES, isHexColor, logicalDimsOf, paletteBackground, hexToRGB, nearestColor } from './palette.js';
import {
  clamp, toNum, fmtDecimals, fmtFeedText, niceTicks, niceStep, snapToStep, fmtTicks, scaleUnit,
} from './format.js';
import { normalizeDatetimeAttrs, placeholderText } from './timefmt.js';
import { FA_FAMILY, FA_WEIGHT, iconGlyph, DEFAULT_GAUGE_ICON } from './icons.js';
import { FONT_MONO, GFX_5X7_FAMILY, normalizeFontFamily } from './fonts.js';
import { textMetrics, captionFamily } from './pixelfont.js';
import { newText } from './pixeltext.js';
import { fitRect, FEED_IMAGE_FITS, feedImageRef } from './feedimage.js';
import { savedImageDither } from './imagedither.js';

/** A picture's own dither (see imagedither.js), set on its node only when it has one. */
function applyImageDither(node, attrs) {
  const own = savedImageDither(attrs);
  if (own.dither) node.setAttr('dither', own.dither);
  if (own.diffusion !== undefined) node.setAttr('diffusion', own.diffusion);
}

/** The darkest ink of the panel's palette, which every palette has. */
const inkOf = (display) => (PALETTES[display?.type] || PALETTES.mono)[0];

/**
 * Group-based elements that rebuild their children from attrs. Membership here
 * is load-bearing, not a convenience: an etype missing from this set falls
 * through the editor's wireNode transformend chain into the LABEL branch and throws
 * on fontSize() (a Group has no such method), and through refreshProps into the
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
 * the host's job and asynchronous (see readsImage in bindings.js).
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
/** The attr an element of this etype keeps its reading in, for a saved element as well as a node. */
export const valueAttrOf = (etype) => FEED_VALUE_ATTR[etype] || 'feedValue';
export const feedValueAttr = (n) => valueAttrOf(n.getAttr('etype'));

/** Does this element take its content from a feed right now? */
export const isFeedLinked = (n) => !!n.getAttr('feedKey');

/** Is this a "Date & time" prop, whose text IO renders (see createDatetime)? */
export const isDatetime = (n) => n.getAttr('etype') === 'datetime';

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

/** The text a datetime shows: IO's last answer, or its preset's example before one. */
export function datetimeText(n) {
  return n.getAttr('timeValue') ?? placeholderText(n.getAttr('timeFmt'));
}

// ---------- faint ink -------------------------------------------------------
//
// A few things are drawn at part strength so they read as background: a gauge's empty
// track, a chart's grid. Only pictures are dithered (imagedither.js), and a part-strength
// ink snapped to the nearest panel colour is just paper. So each is drawn as something
// the panel can show: a real in-between shade where the palette has one (4 greys), and
// otherwise a sparse pattern of whole ink pixels.
//
// Both depend on the page, which a widget reads from its `display` attr: the descriptor
// it was created with, kept on the node and never saved (the editor hands it the live
// one on every rebuild, and redraws gauges and charts when the page colour changes).

/** The page colour and palette a widget is drawn against. */
function pageOf(g) {
  const d = g.getAttr('display') || {};
  const type = PALETTES[d.type] ? d.type : 'mono';
  return { type, bg: paletteBackground(d.background ?? PAPER, type) };
}

/** `ink` at `alpha` over the page, as a hex colour. */
function blendOnPage(ink, alpha, bg) {
  const a = hexToRGB(ink), b = hexToRGB(bg);
  return '#' + a.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('');
}

/** The palette shade a part-strength `ink` reads as, or null when none sits between it and the page. */
function faintShade(g, ink, alpha) {
  const { type, bg } = pageOf(g);
  const shade = nearestColor(blendOnPage(ink, alpha, bg), PALETTES[type]);
  return shade !== bg && shade !== ink ? shade : null;
}

const stipples = new Map();
/** A 2×2 tile with 1, 2 or 3 ink pixels, the nearest to `alpha` of the page covered. */
function stipple(Konva, ink, alpha) {
  const n = alpha <= 0.375 ? 1 : alpha <= 0.625 ? 2 : 3;
  const key = `${ink}|${n}`;
  if (!stipples.has(key)) {
    const c = Konva.Util.createCanvasElement();
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
function faintFill(Konva, g, ink, alpha, origin = { x: 0, y: 0 }) {
  const shade = faintShade(g, ink, alpha);
  if (shade) return { fill: shade };
  return {
    fillPatternImage: stipple(Konva, ink, alpha), fillPatternRepeat: 'repeat',
    fillPatternX: -(origin.x - Math.floor(origin.x)), fillPatternY: -(origin.y - Math.floor(origin.y)),
  };
}

/** Stroke attrs for a 1px line at part strength: the shade, or ink dashed one pixel in three. */
function faintStroke(g, ink, alpha) {
  const shade = faintShade(g, ink, alpha);
  return shade ? { stroke: shade } : { stroke: ink, dash: [1, 2] };
}

// ---------- line chart ------------------------------------------------------

/**
 * Dash patterns, assigned by series index. Colour alone cannot separate series:
 * on a mono panel every ink collapses to black, so two feeds would draw as one
 * indistinguishable tangle. Same reasoning as the indicator's lamp stroke and the
 * battery's outline — the panel type must not be able to erase information.
 */
const SERIES_DASH = [[], [4, 2], [1, 2], [6, 2, 1, 2], [8, 3], [2, 2, 6, 2]];
export const seriesDash = (i) => SERIES_DASH[i % SERIES_DASH.length];

// The chart's text (tick numbers, X/Y captions, legend, block title) is sized and
// set per chart; these are the defaults and the range the inspector allows. 7 px is
// what every chart drew before the option existed, so older layouts keep their
// proportions. A NEW chart's family is the Adafruit 5×7 bitmap font: at 7 px the tick
// numbers come out at 6 px, which outline type cannot draw on a panel (pixelfont.js).
// A chart saved with a family keeps it. The title stays TITLE_STEP px larger than the
// rest so it still reads as the heading.
const AXIS_FONT_DEFAULT = 7;
const AXIS_FAMILY_DEFAULT = GFX_5X7_FAMILY;
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
 * nothing. Both come from the host's locale. The zone is `timeZone` when the host
 * names one — a server has no useful zone of its own — and the host's otherwise, which
 * in the editor is the browser drawing the bitmap.
 */
function timeTickLabels(time, plotW, m, timeZone) {
  const fmt = time.hi - time.lo <= 36 * 3600e3
    ? (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone })
    : (ms) => new Date(ms).toLocaleDateString([], { month: 'numeric', day: 'numeric', timeZone });
  for (const n of [5, 3, 2]) {
    const labels = Array.from({ length: n }, (_, i) => {
      const frac = i / (n - 1);
      return { frac, text: fmt(time.lo + frac * (time.hi - time.lo)) };
    });
    const widest = Math.max(...labels.map((l) => l.text.length)) * m.charW;
    // The ends are pinned inside the plot while the rest centre on their instant, so
    // the tightest pair is an end and its neighbour: one full label plus half of the
    // next has to fit in one step, with a gap to spare.
    const step = plotW / (n - 1);
    if (step >= (n > 2 ? 1.5 : 2) * widest + m.lineH) return labels;
  }
  return [];
}

function buildLineChart(Konva, g) {
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
  const axisFamily = normalizeFontFamily(g.getAttr('axisFontFamily'));

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
    // In a bitmap font (pixelfont.js) characters and lines are a fixed size that the
    // estimates for outline type would get wrong, so every gutter is measured with the
    // font that will actually draw in it.
    const am = textMetrics(axisFont, axisFamily), tm = textMetrics(tickFont, axisFamily);
    const ttm = textMetrics(titleFont, axisFamily);
    const yGutter = yLabel ? am.lineH + 1 : 0;                     // rotated Y caption
    // Y tick numbers, drawn whether or not the grid is. Capped: a pressure feed
    // reading 1013.25 wants 7 characters, which on a 120px chart would spend a
    // quarter of the frame on labels for the data itself.
    const tickW = ticks.length
      ? Math.min(Math.round(Math.max(...tickLabels.map((l) => l.length)) * tm.charW) + 1,
                 Math.floor(w * 0.28))
      : 0;
    const left = yGutter + tickW + 1;
    const top = title ? ttm.lineH + 3 : 1;
    const legendH = showLegend ? am.lineH + 2 : 0;
    // The X axis mirrors the Y: times under the axis, as the Y has its tick numbers,
    // whenever the samples carry real timestamps (the legacy sample data doesn't),
    // and the X caption on its own row beneath them, as the Y has its own gutter.
    const plotW = Math.max(4, w - left - 1);
    const timeLabels = withTimes && time ? timeTickLabels(time, plotW, tm, g.getAttr('axisTimeZone')) : [];
    const timeRowH = timeLabels.length ? tm.lineH + 1 : 0;
    const bottom = 1 + timeRowH + (xLabel ? am.lineH + 1 : 0) + legendH;
    return { axisFont, titleFont, tickFont, am, tm, ttm, yGutter, tickW, left, top, legendH,
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
  const { axisFont, titleFont, tickFont, am, tm, ttm, yGutter, tickW, left, top, legendH,
          plotW, timeLabels, timeRowH } = lay;
  // Read back by the inspector, which says so when the size was cut down. Not
  // serialized: it is derived, and the next build recomputes it.
  g.setAttr('axisFontFit', axisFont);
  g.setAttr('axisTickFit', tickFont);   // the smallest text drawn: what the font advice judges
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
    g.add(newText(Konva, {
      text: title, fontSize: titleFont, fontFamily: axisFamily, fontStyle: 'bold', fill: ink,
      x: 1, y: 0, width: Math.max(4, w - 2), wrap: 'none', ellipsis: true,
    }));
  }

  // Y ticks: a number beside each, and either a grid line across the plot or,
  // without the grid, a short mark on the axis so the number points at a height.
  // Drawn before the axis and the data, so neither is overdrawn by a grid line.
  // Each number is centred on its tick but kept clear of the title above and the
  // frame's bottom edge, which the top and bottom ticks would otherwise cross.
  const tickMinY = title ? ttm.lineH + 1 : 0;
  ticks.forEach((t, i) => {
    const y = Math.round(py(t)) + 0.5;
    g.add(new Konva.Line({
      points: [plot.x, y, showGrid ? plot.x + plot.w : plot.x + 3, y],
      strokeWidth: 1, ...(showGrid ? faintStroke(g, ink, 0.35) : { stroke: ink }),
    }));
    g.add(newText(Konva, {
      text: tickLabels[i], fontSize: tickFont, fontFamily: axisFamily, fill: ink,
      // Centred on the capitals, which is where a number's ink is.
      x: yGutter, y: clamp(Math.round(y - tm.capH / 2), tickMinY, h - tm.lineH),
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
        points: [x, plot.y, x, plot.y + plot.h], strokeWidth: 1, ...faintStroke(g, ink, 0.35),
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
    g.add(newText(Konva, {
      text: yLabel, fontSize: axisFont, fontFamily: axisFamily, fill: ink,
      x: 0, y: plot.y + plot.h, rotation: -90, width: plot.h, align: 'center',
    }));
  }
  if (xLabel) {
    g.add(newText(Konva, {
      text: xLabel, fontSize: axisFont, fontFamily: axisFamily, fill: ink,
      x: plot.x, y: plot.y + plot.h + 2 + timeRowH, width: plot.w, align: 'center',
    }));
  }
  if (timeLabels.length) {
    // The ends are pinned inside the plot (left- and right-aligned) rather than
    // centred on their instant, so the first and last times can't hang off the frame.
    timeLabels.forEach(({ frac, text }) => {
      const tw = Math.ceil(text.length * tm.charW) + 2;
      const x = plot.x + frac * plot.w;
      const [bx, align] = frac === 0 ? [plot.x, 'left']
        : frac === 1 ? [plot.x + plot.w - tw, 'right'] : [x - tw / 2, 'center'];
      g.add(newText(Konva, {
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
      const entryW = 10 + Math.ceil(text.length * am.charW) + 5;
      // Clipped rather than wrapped or shrunk: the legend is one row by design, and
      // silently overflowing it would draw feed names off the edge of the panel.
      if (x + entryW > w && x > plot.x) return;
      // A dash sample rather than a colour chip: the dash is the part that survives
      // a mono panel, so it is the part the legend has to show.
      g.add(new Konva.Line({
        points: [x, y + Math.floor(am.capH / 2) + 0.5, x + 8, y + Math.floor(am.capH / 2) + 0.5],
        stroke: s.color, strokeWidth: 1, dash: s.dash.length ? s.dash : undefined,
      }));
      g.add(newText(Konva, {
        text, fontSize: axisFont, fontFamily: axisFamily, fill: ink,
        x: x + 10, y, width: Math.max(4, w - x - 10), ellipsis: true, wrap: 'none',
      }));
      x += entryW;
    });
  }
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

function buildGauge(Konva, g) {
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
    g.add(newText(Konva, {
      text: title, fontSize: titleFont, fontFamily: captionFamily(titleFont), fill: ink,
      x: 0, y: 0, width: w, align: 'center',
    }));
  }

  const frac = gaugeFraction(g);
  const valueInk = gaugeInk(g);
  const arc = { x: cx, y: cy, innerRadius: r - thickness, outerRadius: r, rotation: GAUGE_START };

  // The empty track is drawn faintly rather than omitted: without it, a low reading
  // gives no clue how much scale is left. On a mono panel a stipple of ink is the only
  // way to say "this part is the background" (see faintFill).
  g.add(new Konva.Arc({ ...arc, angle: GAUGE_SWEEP, ...faintFill(Konva, g, ink, 0.25, { x: cx, y: cy }) }));
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
  // The gauge picks its own type (captionFamily): under 8 px a bitmap font, whose lines
  // are taller than their nominal size, so line heights, not font sizes, stack here.
  const valueFamily = captionFamily(valueFont), labelFamily = captionFamily(labelFont);
  const valueH = textMetrics(valueFont, valueFamily).lineH, labelH = textMetrics(labelFont, labelFamily).lineH;
  const stackH = (iconFont ? iconFont + gap : 0) + valueH + (label ? labelH + gap : 0);
  let y = Math.round(cy - stackH / 2);

  if (iconFont) {
    g.add(newText(Konva, {
      text: iconGlyph(g.getAttr('icon')),
      fontSize: iconFont, fontFamily: FA_FAMILY, fontStyle: FA_WEIGHT,
      fill: valueInk, x: 0, y, width: w, align: 'center',
    }));
    y += iconFont + gap;
  }
  g.add(newText(Konva, {
    text: frac === null ? '—' : fmtDecimals(gaugeValue(g), decimals),
    fontSize: valueFont, fontFamily: valueFamily, fill: valueInk,
    x: 0, y, width: w, align: 'center',
  }));
  y += valueH + gap;
  if (label) {
    g.add(newText(Konva, {
      text: label, fontSize: labelFont, fontFamily: labelFamily, fill: ink,
      x: 0, y, width: w, align: 'center',
    }));
  }
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

function buildIndicator(Konva, g) {
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

function buildBattery(Konva, g) {
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
  const family = captionFamily(fontSize);
  // Reserve a fixed 4-character box so the icon doesn't shift as the value changes.
  const textW = g.getAttr('showPct') ? Math.ceil(textMetrics(fontSize, family).charW * 4) : 0;
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
    g.add(newText(Konva, {
      text: pctText, fontSize, fontFamily: family, fill: ink,
      x: w + gap, y: Math.round((bodyH - textMetrics(fontSize, family).capH) / 2), width: textW, align: 'left',
    }));
  }
}

// ---------- feed image ------------------------------------------------------
//
// A picture read from an Adafruit IO feed: a camera project's latest frame, or a
// picture the editor uploaded to a feed of its own. Every image placed on a marquee
// canvas is one of these (#36); a document names the feed and never embeds the picture.
// A widget, not a Konva.Image, because what the user authors is a FRAME on the panel
// and the picture is a reading that can change shape from one read to the next: the
// group's `w`x`h` is the frame, and each picture is placed into it by fitRect().
//
// The decoded picture rides in the `imageObj` attr and is never serialized. Decoding is
// the host's job (an <img> in the editor, skia-canvas's loadImage on a server), so this
// builder only ever draws what it is handed.

/** The palette colour that stands out most against `bg`, by luminance. */
function contrastInk(type, bg) {
  const lum = (hex) => { const [r, g, b] = hexToRGB(hex); return 0.299 * r + 0.587 * g + 0.114 * b; };
  const pal = PALETTES[type] || PALETTES.mono;
  const l = lum(bg);
  return pal.reduce((best, c) => (Math.abs(lum(c) - l) > Math.abs(lum(best) - l) ? c : best), pal[0]);
}

/** The palette's red, when it has one: tricolor and quadcolor panels do. */
function paletteRed(type) {
  return (PALETTES[type] || []).find((c) => { const [r, g, b] = hexToRGB(c); return r > 150 && g < 100 && b < 100; });
}

/**
 * The colours of the "no picture" placeholder on this display's page: the outline and
 * the question mark. Both are picked against the page, so the frame never vanishes into
 * it (#24 calls out black ink on a black page). The mark is red where the panel has red
 * and the page is not already red. Otherwise it uses the outline's colour.
 */
export function feedImagePlaceholderColors(display) {
  const type = display?.type || 'mono';
  const bg = paletteBackground(display?.background ?? PAPER, type);
  const outline = contrastInk(type, bg);
  const red = paletteRed(type);
  return { outline, mark: red && red !== bg ? red : outline };
}

function buildFeedImage(Konva, g) {
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
  // No picture: the feed is empty, unreadable, or not read yet. This is drawn on the
  // panel too, on purpose. An empty feed should look like an empty feed on the glass,
  // not like nothing at all.
  const { outline, mark } = feedImagePlaceholderColors(g.getAttr('display'));
  g.add(new Konva.Rect({
    x: 0.5, y: 0.5, width: Math.max(0, w - 1), height: Math.max(0, h - 1),
    stroke: outline, strokeWidth: 1, dash: [3, 3],
  }));
  const fontSize = Math.round(Math.min(w, h) * 0.75);
  if (fontSize >= 6) {
    g.add(newText(Konva, {
      text: '?', fontSize, fontFamily: FONT_MONO, fontStyle: 'bold', fill: mark,
      width: w, height: h, align: 'center', verticalAlign: 'middle',
    }));
  }
}

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

/** Rebuild a widget's children from its attrs. False for an etype with no builder. */
export function rebuildWidget(Konva, n) {
  const build = WIDGET_BUILDERS[n.getAttr('etype')];
  if (!build) { console.warn('rebuildWidget: no builder for etype', n.getAttr('etype')); return false; }
  build(Konva, n);
  return true;
}

// ---------- construction ----------------------------------------------------
//
// Each factory reads its own attrs off a saved element, so it is also the
// deserializer (createGauge's `value` -> `gaugeValue` migration lives here for that
// reason). `nodeProps` are the host's defaults (position, id, draggable), which the
// element's own attrs override.

export function createLabel(Konva, attrs = {}, display, nodeProps = {}) {
  const node = newText(Konva, Object.assign({
    text: 'Label', fontSize: 20, fontFamily: FONT_MONO, fill: inkOf(display),
  }, nodeProps, attrs));
  node.fontFamily(normalizeFontFamily(node.fontFamily()));
  node.setAttr('etype', 'label');
  // The feed binding is set through attrs rather than the Konva.Text constructor
  // so the names stay together and a plain label still gets them as empty rather
  // than undefined.
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
  return node;
}

export function createDivider(Konva, attrs = {}, display, nodeProps = {}) {
  const node = new Konva.Rect(Object.assign({ height: 2, fill: inkOf(display) }, nodeProps, attrs));
  node.setAttr('etype', 'divider');
  return node;
}

export function createDatetime(Konva, attrs = {}, display, nodeProps = {}) {
  const a = normalizeDatetimeAttrs(attrs);
  const node = newText(Konva, {
    ...nodeProps,
    x: attrs.x ?? nodeProps.x ?? 0, y: attrs.y ?? nodeProps.y ?? 0,
    fontSize: a.fontSize, fontFamily: a.fontFamily, align: a.align,
    fill: a.fill ?? inkOf(display),
  });
  // Only when authored: an unset width is what makes Konva auto-size to the text.
  if (a.width !== undefined) node.width(a.width);
  node.setAttr('etype', 'datetime');
  node.setAttr('timeFmt', a.timeFmt);
  node.setAttr('timeTz', a.timeTz);
  node.setAttr('timeValue', a.timeValue);
  node.text(datetimeText(node));
  applyTextBox(node, attrs);
  return node;
}

/** A widget's Group, placed by its attrs, else by the host's defaults. */
function widgetGroup(Konva, attrs, nodeProps) {
  return new Konva.Group({
    ...nodeProps, x: attrs.x ?? nodeProps.x ?? 0, y: attrs.y ?? nodeProps.y ?? 0,
  });
}

export function createLineChart(Konva, attrs = {}, display, nodeProps = {}) {
  const g = widgetGroup(Konva, attrs, nodeProps);
  const ink = inkOf(display);
  g.setAttr('etype', 'linechart');
  g.setAttr('display', display);   // the page its faint grid is drawn against; never saved
  g.setAttr('w', attrs.w ?? 120);
  g.setAttr('h', attrs.h ?? 60);
  g.setAttr('ink', attrs.ink ?? ink);
  g.setAttr('title', attrs.title ?? '');
  // Bound feeds and their fetched history. Copied rather than aliased so a saved
  // doc passed straight back in (which is how deserialize works) can't share
  // arrays with the live node.
  g.setAttr('feeds', (attrs.feeds ?? []).map((f) => ({
    key: f.key, name: f.name || f.key, color: f.color || ink,
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
  g.setAttr('axisFontFamily', attrs.axisFontFamily === undefined ? AXIS_FAMILY_DEFAULT
    : normalizeFontFamily(attrs.axisFontFamily));
  // The zone the time axis reads in: the host's, passed on the display at render time.
  // Not a design attr, so serializeElement never saves it; undefined in the editor, which
  // leaves the browser's own zone in charge.
  g.setAttr('axisTimeZone', display?.timeZone || undefined);
  // Legacy sample data, only reached when no feeds are bound (see chartSeries).
  g.setAttr('data', attrs.data ?? []);
  buildLineChart(Konva, g);
  return g;
}

export function createGauge(Konva, attrs = {}, display, nodeProps = {}) {
  const g = widgetGroup(Konva, attrs, nodeProps);
  const ink = attrs.ink ?? inkOf(display);
  g.setAttr('etype', 'gauge');
  g.setAttr('display', display);   // the page its faint track is drawn against; never saved
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
  // the note on createIndicator about positional shortcuts. A quadcolor panel is
  // where the user will actually set these to red.
  g.setAttr('warnColor', attrs.warnColor ?? ink);
  g.setAttr('alarmColor', attrs.alarmColor ?? ink);
  g.setAttr('feedKey', attrs.feedKey ?? '');
  g.setAttr('feedName', attrs.feedName ?? '');
  // `gaugeValue`, not `value` — see FEED_VALUE_ATTR. `attrs.value` is the migration
  // path for docs saved before the rename, which is the only place it appears.
  g.setAttr('gaugeValue', attrs.gaugeValue ?? attrs.value ?? null);
  buildGauge(Konva, g);
  return g;
}

export function createIndicator(Konva, attrs = {}, display, nodeProps = {}) {
  const g = widgetGroup(Konva, attrs, nodeProps);
  g.setAttr('etype', 'indicator');
  g.setAttr('w', attrs.w ?? 16);
  // Defaults use the darkest ink and the display background, both of which exist
  // in EVERY palette (the background is snapped to it). Positional shortcuts don't:
  // [1] is a dark grey on gray4, and the last entry is paper on gray4 (an invisible
  // "on" lamp). Off follows the background so an unlit lamp reads as unlit on a
  // dark or coloured page too, not as a paper-white dot.
  g.setAttr('onColor', attrs.onColor ?? inkOf(display));
  g.setAttr('offColor', attrs.offColor ?? display?.background ?? PAPER);
  g.setAttr('ink', attrs.ink ?? inkOf(display));
  g.setAttr('op', attrs.op ?? 'eq');
  g.setAttr('cmp', attrs.cmp ?? '1');
  g.setAttr('feedKey', attrs.feedKey ?? '');
  g.setAttr('feedName', attrs.feedName ?? '');
  g.setAttr('value', attrs.value ?? null);
  buildIndicator(Konva, g);
  return g;
}

export function createBattery(Konva, attrs = {}, display, nodeProps = {}) {
  const g = widgetGroup(Konva, attrs, nodeProps);
  const ink = attrs.ink ?? inkOf(display);
  g.setAttr('etype', 'battery');
  g.setAttr('w', attrs.w ?? 48);
  // Every default resolves to the darkest ink, which exists in EVERY palette —
  // positional shortcuts don't (see createIndicator). Both the seeded condition and
  // the fallback are visible the moment the widget is dropped.
  g.setAttr('ink', ink);
  g.setAttr('showPct', attrs.showPct ?? false);
  g.setAttr('conds', (attrs.conds ?? [{ op: 'lt', cmp: '20', color: ink }])
    .map((c) => ({ op: c.op, cmp: c.cmp, color: c.color })));
  g.setAttr('defaultShade', attrs.defaultShade ?? ink);
  g.setAttr('feedKey', attrs.feedKey ?? '');
  g.setAttr('feedName', attrs.feedName ?? '');
  g.setAttr('feedValue', attrs.feedValue ?? null);   // not 'value' — see FEED_VALUE_ATTR
  buildBattery(Konva, g);
  return g;
}

/**
 * An image from an already-decoded `imageObj` (decoding is the host's: an <img> in
 * a browser, a canvas Image on a server). Unsized, it fits within 80% of the panel.
 */
export function createImage(Konva, imageObj, attrs = {}, display, nodeProps = {}) {
  const { w: cw, h: ch } = logicalDimsOf(display);
  const iw = imageObj.width, ih = imageObj.height;
  let dw = attrs.w, dh = attrs.h;
  if (dw === undefined || dh === undefined) {
    const scale = Math.min(1, (cw * 0.8) / iw, (ch * 0.8) / ih);
    dw = Math.max(1, Math.round(iw * scale));
    dh = Math.max(1, Math.round(ih * scale));
  }
  const node = new Konva.Image({
    ...nodeProps,
    image: imageObj,
    x: attrs.x ?? nodeProps.x ?? Math.round((cw - dw) / 2),
    y: attrs.y ?? nodeProps.y ?? Math.round((ch - dh) / 2),
    width: dw, height: dh,
  });
  node.setAttr('etype', 'image');
  node.setAttr('natW', iw);
  node.setAttr('natH', ih);
  if (attrs.src) node.setAttr('src', attrs.src); // data URL kept for save/load
  applyImageDither(node, attrs);
  return node;
}

/**
 * A feed image's frame. `attrs.imageObj` is an already-decoded picture, when the host
 * has one. Without it the frame shows the placeholder until the host reads the feed.
 * `display` is kept on the node (never saved) so a rebuild can pick placeholder colours
 * against the page. The editor passes its live descriptor, so the next rebuild sees a
 * page colour changed later.
 */
export function createFeedImage(Konva, attrs = {}, display, nodeProps = {}) {
  const g = widgetGroup(Konva, attrs, nodeProps);
  const { w: cw, h: ch } = logicalDimsOf(display);
  g.setAttr('etype', 'feedimage');
  // Unsized: a third of the panel, landscape. Big enough to read a camera frame, small
  // enough to leave room for the caption that usually goes with one.
  const w = attrs.w ?? Math.max(8, Math.round(cw / 3));
  const h = attrs.h ?? Math.max(8, Math.round(w * 0.75));
  g.setAttr('w', w);
  g.setAttr('h', h);
  if (attrs.x === undefined && nodeProps.x === undefined) g.x(Math.round((cw - w) / 2));
  if (attrs.y === undefined && nodeProps.y === undefined) g.y(Math.round((ch - h) / 2));
  g.setAttr('fit', FEED_IMAGE_FITS.some((f) => f.id === attrs.fit) ? attrs.fit : 'contain');
  g.setAttr('feedKey', attrs.feedKey ?? '');
  g.setAttr('feedName', attrs.feedName ?? '');
  g.setAttr('display', display);
  const img = attrs.imageObj || null;
  g.setAttr('imageObj', img);
  g.setAttr('natW', img ? img.width : null);
  g.setAttr('natH', img ? img.height : null);
  applyImageDither(g, attrs);
  buildFeedImage(Konva, g);
  return g;
}

const FACTORIES = {
  label: createLabel, divider: createDivider, datetime: createDatetime, linechart: createLineChart,
  gauge: createGauge, indicator: createIndicator, battery: createBattery, feedimage: createFeedImage,
};

/**
 * Any element but an image, by its etype. An etype this build doesn't know loads as
 * a label, as deserialize always did, rather than vanishing from the document.
 */
export function createElement(Konva, attrs, display, nodeProps = {}) {
  return (FACTORIES[attrs.etype] || createLabel)(Konva, attrs, display, nodeProps);
}

// ---------- serialization ---------------------------------------------------

/** One element node as canvas.json saves it. The inverse of createElement / createImage. */
export function serializeElement(n) {
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
    }, savedImageDither(n.attrs));
  } else if (etype === 'feedimage') {
    // The frame and the fit are the design. The picture is on the feed, so `src` names
    // the feed (see feedImageRef) instead of carrying the bytes. Its natural size only
    // describes the last reading, so that is not saved either.
    Object.assign(base, {
      w: n.getAttr('w'), h: n.getAttr('h'), fit: n.getAttr('fit') || 'contain',
      feedKey: n.getAttr('feedKey') || '', feedName: n.getAttr('feedName') || '',
      src: feedImageRef(n.getAttr('feedKey')),
    }, savedImageDither(n.attrs));
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
  // The text box (see applyTextBox above). Written only when set, so a
  // plain label serializes exactly as it did before the option existed.
  if (etype === 'label' || etype === 'datetime') {
    if (n.getAttr('background')) base.background = n.getAttr('background');
    if (n.padding()) base.padding = n.padding();
  }
  return base;
}

// ---------- a whole document ------------------------------------------------

/**
 * A document laid out for rendering: the page, then every element in saved order
 * (array order is stacking order). `images` maps an element's index to its decoded
 * image; an image element without one is left out, as an undecodable one always was.
 * A feed image without one is drawn as its placeholder. Its frame is the design, and an
 * empty frame on the panel says the feed had no picture.
 * Returns the group and the canvas size to capture it at.
 */
export function buildScene(Konva, doc, { display = doc.display || {}, images = {} } = {}) {
  const { w, h } = logicalDimsOf(display);
  const group = new Konva.Group();
  // The page colour is part of the artwork, so it comes from the document — snapped
  // to this panel's palette, and PAPER for a document from before the field.
  group.add(new Konva.Rect({
    x: 0, y: 0, width: w, height: h,
    fill: paletteBackground(doc.display?.background ?? PAPER, display.type),
  }));
  (doc.elements || []).forEach((el, i) => {
    if (el.etype === 'image') {
      if (images[i]) group.add(createImage(Konva, images[i], el, display));
    } else if (el.etype === 'feedimage') {
      group.add(createFeedImage(Konva, { ...el, imageObj: images[i] || null }, display));
    } else {
      group.add(createElement(Konva, el, display));
    }
  });
  return { group, width: w, height: h };
}
