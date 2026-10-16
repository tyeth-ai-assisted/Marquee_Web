/**
 * Number formatting and tick maths for the data-driven widgets. Pure: no imports.
 */

// ---------- numbers, for the data-driven widgets ----------------------------
//
// Feed values arrive from IO as STRINGS, and "no reading yet" has to stay
// distinguishable from a real zero, so every conversion here funnels through
// toNum and returns null rather than NaN or 0 for an unusable value.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** A finite number, or null for empty / non-numeric / unset. Never NaN. */
export function toNum(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

/** `places` is user-supplied, so it's clamped to what toFixed actually accepts. */
export function fmtDecimals(raw, places) {
  const v = toNum(raw);
  if (v === null) return '—';
  return v.toFixed(clamp(Math.round(places) || 0, 0, 10));
}

/**
 * A feed reading as a linked label shows it. Unset `places` means "as sent", and a
 * reading that isn't a number is passed through untouched — unlike fmtDecimals, a
 * label bound to a text feed must not collapse to a dash.
 */
export function fmtFeedText(raw, places) {
  if (places === null || places === undefined || places === '') return String(raw);
  return toNum(raw) === null ? String(raw) : fmtDecimals(raw, places);
}

/** The 1 / 2 / 5 × 10ⁿ step that niceTicks() spaces its stops by. */
export function niceStep(lo, hi, count = 4) {
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm > 5 ? 10 : norm > 2 ? 5 : norm > 1 ? 2 : 1) * mag;
}

/**
 * How many decimal places a LABEL on a `step` grid prints: 0 for 5, 1 for 0.5.
 * Capped at 10 because that is display precision, not arithmetic — values on
 * the grid go through gridValue(), which has no such cap.
 */
export const stepDecimals = (step) => clamp(Math.ceil(-Math.log10(step) - 1e-9), 0, 10);

/**
 * The i-th stop of a `step` grid, with floating-point drift removed.
 * i * step alone yields 0.30000000000000004 at step 0.1. Rounding to 12
 * significant digits removes that at every magnitude. Fixed decimal places
 * would not: capped at 10, they rounded a 1e-12 grid to 0 and collapsed the
 * chart's whole domain onto one edge.
 */
const gridValue = (i, step) => Number((i * step).toPrecision(12));

/**
 * `v` rounded out to the step grid — down, or up when `up`. The epsilon keeps a
 * value already on the grid (65 / 5 = 12.999… in floating point) where it is.
 */
export function snapToStep(v, step, up = false) {
  const q = v / step;
  return gridValue(up ? Math.ceil(q - 1e-9) : Math.floor(q + 1e-9), step);
}

/**
 * Tick stops on a 1 / 2 / 5 × 10ⁿ ramp, the spacing that reads as "round numbers"
 * at any magnitude. `count` is a target, not a promise: the stops are aligned to
 * the ramp, so the count lands near it rather than on it. Always returns at least
 * the two endpoints.
 *
 * The ramp rounds UP (a step of 5 where 3.3 was asked for) because these label a
 * 60px-tall plot on an e-ink panel — erring toward fewer, further-apart stops is
 * what keeps them legible.
 *
 * `step` lets a caller that has already snapped its range to a grid (the chart's
 * auto-detected Y bounds) reuse that grid. Recomputed over the snapped range it
 * can come out coarser and miss the ends: 0.33–0.91 snaps to 0.2–1 on a 0.2 grid,
 * and a fresh step of 0.5 labels only 0.5 and 1.
 */
export function niceTicks(lo, hi, count = 4, step = niceStep(lo, hi, count)) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [lo, hi];
  // Accumulating (t += step) drifts, so each stop is computed from its index and
  // cleaned by gridValue(). The stops are positions as well as labels, so they
  // keep their magnitude here; label formatting is stepDecimals()'s job.
  const out = [];
  const first = Math.ceil(lo / step - 1e-9);
  for (let i = first; i * step <= hi + step * 1e-9; i++) out.push(gridValue(i, step));
  return out.length >= 2 ? out : [lo, hi];
}

/**
 * Normalise a value to 0..1 across [lo, hi]. The ONE place linear vs log is
 * decided, so plotting code stays a single expression.
 *
 * Log needs a strictly positive domain — log10(0) is -Infinity and negatives are
 * undefined — so a caller that can't guarantee that gets the linear mapping
 * instead of a silently broken plot.
 */
export function scaleUnit(v, lo, hi, log = false) {
  if (log && lo > 0 && hi > 0 && v > 0) {
    const l = Math.log10(lo), h = Math.log10(hi);
    return h === l ? 0 : (Math.log10(v) - l) / (h - l);
  }
  return hi === lo ? 0 : (v - lo) / (hi - lo);
}

/**
 * Labels for a run of evenly spaced tick values, as strings in the same order.
 *
 * Each label gets exactly the decimal places its step needs (65, 70, 75, not
 * 65.00; 0.2, 0.4 at a 0.2 step). Any fewer and neighbouring ticks print the same
 * text (0, 1, 1 for a 0.5 grid), so no Decimals-style cap applies here.
 * Fixed-point stops at 4 places, and at a million or more. Past those, labels
 * switch to exponent form, with just enough digits to tell neighbouring ticks
 * apart. That keeps a 1e-12 series from being labelled 0.00 at every tick.
 * `places` only formats a lone tick, which has no step to go by.
 */
export function fmtTicks(ticks, places = 2) {
  if (ticks.length < 2) return ticks.map((t) => fmtDecimals(t, places));
  const step = Math.abs(ticks[1] - ticks[0]);
  const maxAbs = Math.max(...ticks.map(Math.abs));
  const dp = stepDecimals(step);
  if (dp <= 4 && maxAbs < 1e6) return ticks.map((t) => fmtDecimals(t, dp));
  const digits = Math.max(0, Math.floor(Math.log10(maxAbs)) - Math.floor(Math.log10(step)));
  return ticks.map((t) => (t === 0 ? '0' : t.toExponential(digits)));
}
