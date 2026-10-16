/**
 * Small shared helpers. Imports only lib/format.js — this is the bottom of the module graph.
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

// ---------- numbers: lib/format.js, re-exported for the editor -------------

export {
  clamp, toNum, fmtDecimals, fmtFeedText, niceStep, stepDecimals, snapToStep, niceTicks, scaleUnit, fmtTicks,
} from '../lib/format.js';

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
