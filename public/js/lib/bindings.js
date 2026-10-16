/**
 * Feed bindings on a saved document: what a scene reads, and where each reading goes.
 *
 * Two hosts ask both questions. The editor re-reads its bindings before a push and on the
 * board's cycle (device/feeds.js); a server keeping a display live without the editor
 * open asks the same of a canvas.json it has never drawn (renderer/, and Adafruit IO
 * behind it — see docs/server-live-take.md). The answers live here once, because a second
 * spelling is how a widget ends up refreshing in the browser and freezing on the server:
 * which etypes take a last value, which take a history window, the attr each keeps its
 * reading in, how a chart window is parsed, thinned and merged.
 *
 * Everything here works on plain element objects — a saved element, or a Konva node's
 * getAttrs() — and returns new objects rather than mutating its input. Nothing reads a
 * feed: the host does the I/O and passes the results in as `readings`.
 */

import { FEED_ETYPES, valueAttrOf } from './scene.js';
import { parseFeedImage } from './feedimage.js';

/** IO's own ceiling on a raw (unaggregated) chart pull. */
export const CHART_RAW_MAX = 640;

/** Does this element take a feed's last value? */
export const readsLast = (el) => !!el && FEED_ETYPES.includes(el.etype) && !!el.feedKey;

/**
 * Does this element take a feed's last value as a PICTURE? Read like any last value (one
 * GET, filed under the feed key), but the host decodes it before it can draw.
 */
export const readsImage = (el) => !!el && el.etype === 'feedimage' && !!el.feedKey;

/** Does this element take a window of feed history? */
export const readsChart = (el) => !!el && el.etype === 'linechart' && Array.isArray(el.feeds) && el.feeds.length > 0;

/** A date & time element: always live, its content is the time. */
export const readsTime = (el) => !!el && el.etype === 'datetime';

/** The history window a chart asks for. */
export function chartWindow(el) {
  return { hours: el.hours ?? 24, raw: !!el.rawOnly };
}

/**
 * The key a chart reading is filed under. Not the bare feed key: two charts on one feed
 * can ask for different windows, and each must get its own.
 */
export function chartReadId(feed, { hours = 24, raw = false } = {}) {
  return `${feed}@${hours}h${raw ? '/raw' : ''}`;
}

/** How many points a chart keeps per series: about one per pixel of width. */
export const chartCap = (el) => Math.max(2, Math.round(el.w || 120));

/**
 * Every read a document needs, de-duplicated.
 *
 *   -> { reads: [{ id, feed, kind: 'last' } | { id, feed, kind: 'chart', hours, raw, limit }],
 *        datetime: bool }
 *
 * `id` is the key the host files the result under in `readings`. `limit` is set only on a
 * raw chart pull, which IO caps at CHART_RAW_MAX. `datetime` says the scene shows the time,
 * so it changes on every take even when no feed does.
 */
export function feedReads(doc) {
  const reads = new Map();
  let datetime = false;
  for (const el of doc?.elements || []) {
    if (readsTime(el)) datetime = true;
    if ((readsLast(el) || readsImage(el)) && !reads.has(el.feedKey)) {
      reads.set(el.feedKey, { id: el.feedKey, feed: el.feedKey, kind: 'last' });
    }
    if (readsChart(el)) {
      const { hours, raw } = chartWindow(el);
      for (const f of el.feeds) {
        const id = chartReadId(f.key, { hours, raw });
        if (reads.has(id)) continue;
        reads.set(id, raw
          ? { id, feed: f.key, kind: 'chart', hours, raw, limit: CHART_RAW_MAX }
          : { id, feed: f.key, kind: 'chart', hours, raw });
      }
    }
  }
  return { reads: [...reads.values()], datetime };
}

/**
 * A chart window as [{t, v}], oldest first — or null when it cannot be read.
 *
 * Takes IO's /data/chart body ({ columns, data }) or points already in that shape. The
 * shape of an IO body DEPENDS ON THE QUERY: raw pulls give ["date","value"], aggregated
 * ones may give ["date","min","max","avg"]. So the value column is resolved BY NAME —
 * indexing positionally silently plots minima as if they were readings the moment IO
 * decides a window is large enough to aggregate.
 */
export function chartPoints(body) {
  let pts;
  if (Array.isArray(body)) {
    pts = body.map((p) => ({ t: p?.t ?? null, v: Number(p?.v) }));
  } else {
    if (!body || !Array.isArray(body.data)) return null;
    const cols = body.columns || ['date', 'value'];
    const ti = cols.indexOf('date');
    // 'avg' is the aggregate that represents the window; 'value' is the raw case.
    const vi = ['value', 'avg', 'max', 'min'].map((c) => cols.indexOf(c)).find((i) => i >= 0);
    if (vi === undefined) return null;
    pts = body.data.map((row) => ({ t: ti >= 0 ? row[ti] : null, v: Number(row[vi]) }));
  }
  return pts
    .filter((p) => Number.isFinite(p.v))
    // Sorted oldest-first, explicitly. The chart joins points in array order, so a
    // descending response would draw the window backwards.
    .sort((a, b) => (Date.parse(a.t) || 0) - (Date.parse(b.t) || 0));
}

/**
 * Thin a series to at most `max` points, keeping the FIRST and LAST so the window's
 * endpoints stay exact.
 *
 * Charts are 120-300px wide, so anything denser than that draws multiple samples into one
 * column — and canvas.json is the wire format to the device, so the invisible points cost
 * bytes for nothing.
 */
export function downsample(points, max) {
  if (!Array.isArray(points) || points.length <= max || max < 2) return points || [];
  const out = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

/**
 * A chart's `series` after a refresh.
 *
 * `fetched` maps feed key -> points, or null/absent for a read that failed. A failed read
 * KEEPS the points the chart already had, so one dead feed doesn't wipe the other lines off
 * the plot. Series for feeds no longer bound are dropped, or an unbound-then-rebound feed
 * would silently resurrect stale points.
 */
export function mergeSeries(prev, feeds, fetched, cap) {
  const series = { ...(prev || {}) };
  for (const f of feeds || []) {
    const pts = fetched?.[f.key];
    if (pts) series[f.key] = downsample(pts, cap).map((p) => ({ t: p.t, v: p.v }));
  }
  const live = new Set((feeds || []).map((f) => f.key));
  for (const k of Object.keys(series)) if (!live.has(k)) delete series[k];
  return series;
}

/**
 * The document with `readings` written into it, the way the editor writes a refresh into
 * its nodes — so the scene renders exactly as it would after a refresh in the browser.
 *
 *   readings = { last:  { [read id]: value | null },
 *                chart: { [read id]: IO /data/chart body | [{t, v}] | null } }
 *
 * Read ids are the ones feedReads() hands out. A reading that is missing or null leaves the
 * element's saved value alone: one flaky read never blanks a panel.
 *
 * A feed image's reading becomes its `src`, as the data URL of the picture it holds, for
 * the host to decode. A value that is not a picture is left out like a failed read, so
 * the frame keeps its feed reference and draws the "no picture" placeholder. A saved
 * document has no picture of its own to fall back on (#36).
 */
export function bakeReadings(doc, readings = {}) {
  const last = readings.last || {};
  const chart = readings.chart || {};
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== null && o[k] !== undefined;
  const elements = (doc?.elements || []).map((el) => {
    if (readsLast(el) && has(last, el.feedKey)) {
      return { ...el, [valueAttrOf(el.etype)]: String(last[el.feedKey]) };
    }
    if (readsImage(el) && has(last, el.feedKey)) {
      const parsed = parseFeedImage(last[el.feedKey]);
      return parsed.ok ? { ...el, src: parsed.dataUrl } : el;
    }
    if (readsChart(el)) {
      const win = chartWindow(el);
      const fetched = {};
      for (const f of el.feeds) {
        const id = chartReadId(f.key, win);
        if (has(chart, id)) fetched[f.key] = chartPoints(chart[id]);
      }
      return { ...el, series: mergeSeries(el.series, el.feeds, fetched, chartCap(el)) };
    }
    return el;
  });
  return { ...doc, elements };
}
