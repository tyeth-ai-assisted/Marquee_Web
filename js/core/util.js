/**
 * Small shared helpers. No imports — this is the bottom of the module graph.
 */

export const $ = (id) => document.getElementById(id);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Trimmed value of a text field, or '' if the field isn't in the DOM. */
export const val = (id) => ($(id)?.value || '').trim();

/**
 * Write a value into a field and let everything already listening find out.
 *
 * The settings fields are their own store — main.js persists them by listening for
 * `input`, and render.js redraws the publish line off the same event. So a screen
 * that sets one programmatically has to raise the event too, or the value lands in
 * the DOM and nowhere else. Bubbling, because some listeners are delegated.
 *
 * A no-op when the value is unchanged, so mirroring on every keystroke doesn't
 * write to localStorage on every keystroke.
 */
export function setFieldValue(id, value) {
  const el = $(id);
  if (!el || el.value === value) return;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * An Adafruit IO group or feed key: lowercase a-z, 0-9 and dashes, nothing else.
 *
 * IO enforces this server-side, so slugifying before the request is what turns a
 * 422 into a key the user can see in advance. Spaces, underscores and punctuation
 * all collapse to a single dash; leading and trailing dashes are trimmed, because
 * IO rejects those too. Returns '' for a name with nothing usable in it, which the
 * callers treat as "no key yet" rather than as a key.
 */
export function slugifyKey(s) {
  return String(s ?? '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Minimal escaping for values interpolated into innerHTML / attributes. */
export function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
export function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  // MB from a megabyte up: a 1.27 MB firmware image as "1300.4 KB" is the wrong unit.
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

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

/** "5 minutes" / "1 hour" — the human form of a refresh interval. */
export function fmtInterval(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  if (s < 3600) {
    const m = Math.round(s / 60);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  const h = s / 3600;
  const rounded = Number.isInteger(h) ? h : h.toFixed(1);
  return `${rounded} hour${h === 1 ? '' : 's'}`;
}

/**
 * "just now" / "4m ago" / "3h ago" / "2d ago" — how long since an epoch-ms moment.
 *
 * Coarse on purpose. This is the second line on an A1 tile, read at a glance across a
 * grid of boards; "refreshed 4m ago" and "refreshed 4m 12s ago" answer the same
 * question, and only one of them reflows every second. Returns '' for a null time so
 * a device that has never pushed prints nothing rather than "56 years ago".
 */
export function fmtAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Local wall-clock time, e.g. "9:47 AM". */
export function fmtLocalTime(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Local date and time, e.g. "Sep 29, 9:47 AM" — for a moment that may not be today.
 *  The year only when it is not this one. */
export function fmtLocalDateTime(date) {
  const opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  if (date.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return date.toLocaleString([], opts);
}

/** The same, WITH seconds — "9:47:12 AM". Minutes are right for "written 9:47 AM" and
 *  useless for a device report, where a whole wake lasts twenty seconds. */
export function fmtLocalSeconds(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

export function base64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(',')[1]); // strip the data: URL prefix
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

/**
 * Copy text to the clipboard, falling back to a throwaway textarea where the
 * async Clipboard API is unavailable — it needs a secure context, so a plain
 * http:// origin (which is how this app is usually run locally) does not have it.
 * Resolves false only if both routes fail.
 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* blocked or insecure context — fall through */ }

  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

/**
 * Copy, then say so on the button that was clicked. The label is restored on a
 * timer, so a second click before it lapses must not capture "✓ Copied" as the
 * label to go back to.
 */
export async function copyFromButton(btn, text, restore = btn.textContent) {
  const ok = await copyText(text);
  if (!ok) { toast('Copy failed — select the text manually'); return; }
  btn.textContent = '✓ Copied';
  clearTimeout(btn._copyTimer);
  btn._copyTimer = setTimeout(() => { btn.textContent = restore; }, 1200);
}

let toastTimer;
export function toast(msg) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

/**
 * Set one of the dotted status lines in a side rail. `state` is one of
 * wait | pass | warn | fail and drives the dot color via CSS.
 */
export function setCheck(id, state, text) {
  const el = $(id);
  if (!el) return;
  el.dataset.state = state;
  const slot = el.querySelector('[data-role="text"]');
  if (slot) slot.textContent = text;
}

/** Show/hide via the shared .hidden class. */
export function show(el, visible) {
  if (el) el.classList.toggle('hidden', !visible);
}

/** Read the checked radio out of a .seg segmented control. */
export function segValue(containerId) {
  const checked = $(containerId)?.querySelector('input:checked');
  return checked ? checked.value : null;
}

/** Check the radio matching `value` in a .seg segmented control. */
export function setSegValue(containerId, value) {
  $$(`#${containerId} input`).forEach((i) => { i.checked = i.value === String(value); });
}

/** Standard modal wiring: close button, backdrop click, and a shared registry. */
const openModals = new Set();

export function wireModal(backdropId, closeIds = []) {
  const backdrop = $(backdropId);
  if (!backdrop) return;
  closeIds.forEach((id) => $(id)?.addEventListener('click', () => closeModal(backdropId)));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(backdropId); });
}

/**
 * Teardown for a dialog, fired on EVERY way out — the close button, Cancel, a
 * backdrop click and Escape.
 *
 * Distinct from onModalEscape() below, which only ever fires on Escape. A dialog
 * holding a secret needs the one that cannot be missed.
 */
const closeHandlers = new Map();
export function onModalClose(id, fn) { closeHandlers.set(id, fn); }

// ---------- focus, while a dialog is open -----------------------------------
//
// Two separate favours, and a caller can ask for either: remember where focus came
// from so it can go back, and confine Tab to the dialog while it is open.
//
// The trap is opt-in rather than automatic. The four dialogs that predate it were
// written without one and their content is inert; a credential prompt is the one
// place in the app where tabbing out to the shelf behind is a real defect. Focus
// RETURN is worth having either way, which is why it is not conditional on it.

const focusStack = new Map();

/** Everything the browser would let you tab to inside a dialog. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), '
  + 'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusablesIn(root) {
  // offsetParent is null for anything display:none — the reveal toggle of a hidden
  // sub-block, a field the caller took out of the flow — and tabbing to something
  // invisible is the same bug as tabbing out of the dialog.
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
}

const asElement = (x) => (typeof x === 'string' ? $(x) : x);

/**
 * Show a dialog.
 *
 * `trap` confines Tab to the dialog. Where focus came from is remembered either
 * way. Pass `returnFocusTo` explicitly rather than trusting document.activeElement:
 * Safari does not focus a <button> on click, so the trigger would read as <body>.
 */
export function openModal(id, { trap = false, focus = null, returnFocusTo = null } = {}) {
  const backdrop = $(id);
  if (!backdrop) return;
  backdrop.classList.remove('hidden');
  openModals.add(id);

  focusStack.set(id, { trap, returnTo: asElement(returnFocusTo) || document.activeElement });
  // Only move focus for a dialog that asked to hold it. The editor's modals put
  // focus where the user clicked and are better left alone.
  if (!trap && !focus) return;
  const first = asElement(focus) || focusablesIn(backdrop)[0];
  first?.focus();
}

export function closeModal(id) {
  $(id)?.classList.add('hidden');
  openModals.delete(id);
  closeHandlers.get(id)?.();

  const t = focusStack.get(id);
  if (!t) return;
  focusStack.delete(id);
  // The trigger may be gone: A1 rebuilds its grid with innerHTML, and a successful
  // connect navigates away from the screen the button was on.
  if (t.returnTo?.isConnected) t.returnTo.focus();
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || !focusStack.size) return;
  // The last TRAPPED one opened is the one on top; a dialog that only asked for
  // focus return does not confine anything.
  const id = [...focusStack].filter(([, v]) => v.trap).map(([k]) => k).pop();
  const backdrop = id && $(id);
  if (!backdrop) return;
  const items = focusablesIn(backdrop);
  if (!items.length) return;

  const first = items[0];
  const last = items[items.length - 1];
  const on = document.activeElement;
  if (e.shiftKey && (on === first || !backdrop.contains(on))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (on === last || !backdrop.contains(on))) {
    e.preventDefault();
    first.focus();
  }
});

/** Escape closes whatever is open. Callers register extra teardown per modal. */
const escapeHandlers = new Map();
export function onModalEscape(id, fn) { escapeHandlers.set(id, fn); }

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !openModals.size) return;
  for (const id of [...openModals]) {
    closeModal(id);
    escapeHandlers.get(id)?.();
  }
});

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
