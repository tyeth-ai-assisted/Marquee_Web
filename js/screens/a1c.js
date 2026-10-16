/**
 * A1-C — connect your Adafruit IO account.
 *
 * A dialog, not a screen. It sits in screens/ because that is what the design docs
 * call it and because it belongs to A1, but router.js has never heard of it: there
 * is no route, no enter hook, and nothing here ever calls navigate().
 *
 * It is the ONE place in the app where an Adafruit IO key is typed. Everything else
 * — A5b, Settings, the flash payload — reads what this dialog stored. That is the
 * whole point: a key is checked once, against Adafruit IO, before setup can start,
 * rather than discovered to be wrong four screens later on a board that fetches
 * nothing and draws nothing.
 *
 * Two ways in, and the difference between them is a callback rather than a flag.
 * The add tile passes `onSaved` and gets sent on to A4; the account button passes
 * none and the dialog just closes. A gate that continues only when it was asked to
 * cannot continue by accident.
 *
 * THE KEY IS NEVER LOGGED, never put in a URL, and never written anywhere but the
 * canonical #ioKey field and ioFetch's X-AIO-Key header.
 */

import { validateCredentials } from '../device/provision.js';
import { saveIoAccount } from '../device/credentials.js';
import {
  $, val, wireModal, openModal, closeModal, onModalClose,
} from '../core/util.js';

/**
 * What the dialog says, per way in.
 *
 * The eyebrow is the part that has to move: "before you add a display" is a lie
 * when the trigger was the account button on a shelf that already has four.
 */
const MODES = {
  add: {
    eyebrow: 'Before you add a display',
    title: 'Connect your Adafruit IO account',
    body: 'Marquee reads and writes feeds on your behalf, so it needs your username and key '
      + 'before setup can start.',
    action: 'Connect account',
  },
  edit: {
    eyebrow: 'Adafruit IO account',
    title: 'Change the connected account',
    body: 'Marquee reads and writes feeds on your behalf. Saving a different account leaves the '
      + 'displays and feeds you already have exactly as they are — it only changes which account '
      + 'the next setup writes to.',
    action: 'Save account',
  },
};

const BUSY_LABEL = 'Checking…';

/** What to do after a successful save, set per opening. Null in edit mode, which
 *  is what makes "just close" the default rather than a branch. */
let onSaved = null;

/** Bumped by every run and by every teardown, so a response that lands after the
 *  user cancelled — or after they pressed the button again — is inert. */
let runToken = 0;

/** The key already on file, and whether the user has touched the field since it
 *  was seeded. Together they drive clear-on-focus without ever losing a key to a
 *  stray tab. */
let storedKey = '';
let keyTouched = false;

// ---------- errors ----------------------------------------------------------
//
// Per-field, because the two halves of a credential fail for different reasons and
// "that didn't work" over both of them is not an answer anyone can act on. The
// footer line carries what belongs to neither field — a network that is down.

function setFieldError(inputId, errId, msg) {
  const err = $(errId);
  if (err) { err.hidden = !msg; err.textContent = msg || ''; }
  const input = $(inputId);
  if (!input) return;
  if (msg) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

const setUserError = (msg) => setFieldError('a1cUser', 'a1cUserError', msg);
const setKeyError = (msg) => setFieldError('a1cKey', 'a1cKeyError', msg);

/** The line at the bottom left. Its resting state explains what the button will
 *  do; a failure that belongs to no field replaces it. */
function setFoot(text, tone = '') {
  const el = $('a1cFoot');
  if (!el) return;
  el.textContent = text;
  el.className = tone === 'fail' ? 'field-error' : 'hint';
  el.style.flex = '1';
  el.style.textAlign = 'left';
}

const RESTING_FOOT = 'We check the key before continuing.';

/** The primary button's label. Corner marks are children of the button, so only
 *  the leading text node can be rewritten — textContent would take the frame. */
function setActionLabel(text) {
  const btn = $('a1cSave');
  if (btn) btn.firstChild.nodeValue = text;
}

function setBusy(busy) {
  ['a1cUser', 'a1cKey', 'a1cKeyReveal', 'a1cSave'].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = busy;
  });
  // Cancel and ✕ stay live on purpose: a request that hangs must still be
  // escapable, and the token check makes whatever comes back afterwards inert.
}

function setMasked() {
  const input = $('a1cKey');
  if (input) input.type = 'password';
  const btn = $('a1cKeyReveal');
  if (!btn) return;
  btn.textContent = 'Show';
  btn.setAttribute('aria-pressed', 'false');
  btn.setAttribute('aria-label', 'Show the key');
}

// ---------- opening and closing ---------------------------------------------

/**
 * Show the dialog.
 *
 * `onSaved` is the continuation: the add tile passes the routine that mints a
 * draft and moves to A4, the account button and A5b pass a re-render or nothing.
 * `trigger` is where focus goes on the way out — passed explicitly because Safari
 * does not focus a button on click, so document.activeElement would be <body>.
 */
export function openCredentialsGate({ mode = 'add', onSaved: after = null, trigger = null } = {}) {
  const copy = MODES[mode] || MODES.add;
  onSaved = after;

  $('a1cEyebrow').textContent = copy.eyebrow;
  $('a1cTitle').textContent = copy.title;
  $('a1cBody').textContent = copy.body;
  setActionLabel(copy.action);

  // Seeded from the canonical store, never from a copy this module keeps.
  storedKey = $('ioKey')?.value || '';
  keyTouched = false;
  $('a1cUser').value = val('ioUser');
  $('a1cKey').value = storedKey;

  setMasked();
  setBusy(false);
  setUserError('');
  setKeyError('');
  setFoot(RESTING_FOOT);

  openModal('a1cModal', { trap: true, focus: 'a1cUser', returnFocusTo: trigger });
}

/**
 * Teardown, on every way out — ✕, Cancel, the scrim and Escape.
 *
 * Registered through onModalClose rather than onModalEscape precisely because it
 * has to be all four: this is the function that gets the key back out of the DOM,
 * and a dismissal path that skipped it would leave one sitting in a field on a
 * screen the user has walked away from.
 */
function reset() {
  runToken++;
  onSaved = null;
  storedKey = '';
  keyTouched = false;
  $('a1cKey').value = '';
  $('a1cUser').value = '';
  setMasked();
  setBusy(false);
  setUserError('');
  setKeyError('');
  setFoot(RESTING_FOOT);
}

// ---------- the check -------------------------------------------------------

async function connect() {
  if ($('a1cSave')?.disabled) return;

  const user = val('a1cUser');
  const key = ($('a1cKey').value || '').trim();

  // Caught here rather than by Adafruit IO: an empty field is not worth a request,
  // and a 401 would say the key was wrong when the username was simply blank.
  if (!user) { setUserError('Enter your Adafruit IO username.'); $('a1cUser').focus(); return; }
  if (!key) { setKeyError('Enter your Adafruit IO key.'); $('a1cKey').focus(); return; }

  const token = ++runToken;
  const label = $('a1cSave').firstChild.nodeValue;
  setUserError('');
  setKeyError('');
  setFoot(RESTING_FOOT);
  setBusy(true);
  setActionLabel(BUSY_LABEL);

  const out = await validateCredentials(user, key);
  // Cancelled, dismissed, or superseded while this was in flight. The teardown has
  // already restored the dialog; painting a result into it now would be a message
  // about a request nobody is waiting for.
  if (token !== runToken) return;

  setBusy(false);
  setActionLabel(label);

  if (out.status === 401) {
    setKeyError('Adafruit IO rejected this key. Check it on io.adafruit.com — nothing was saved.');
    $('a1cKey').focus();
    return;
  }
  if (!out.ok) {
    setFoot(out.error, 'fail');
    return;
  }
  // The key is good, but it may not be the account that was typed. IO scopes every
  // username lookup to the authenticated account, so a mismatch here would surface
  // later as a 404 claiming the username does not exist — which it does.
  if (out.username && out.username.toLowerCase() !== user.toLowerCase()) {
    setUserError(`That key belongs to ${out.username}. Use that username, or a key from the `
      + `${user} account.`);
    $('a1cUser').focus();
    return;
  }

  saveIoAccount(user, key);
  // Close first: closeModal runs the teardown and returns focus to the trigger,
  // and both want to happen before a continuation navigates the trigger away.
  const done = onSaved;
  closeModal('a1cModal');
  done?.();
}

// ---------- boot ------------------------------------------------------------

export function initA1c() {
  wireModal('a1cModal', ['a1cClose', 'a1cCancel']);
  onModalClose('a1cModal', reset);

  $('a1cSave').addEventListener('click', connect);

  /**
   * Clear-on-focus, so a stored key can be pasted over rather than selected and
   * deleted first.
   *
   * The blur half is what makes it safe: tabbing through the field without typing
   * puts the stored key back, so a keyboard walk down the dialog cannot silently
   * blank a credential that was never being changed.
   */
  $('a1cKey').addEventListener('focus', () => {
    const input = $('a1cKey');
    if (!keyTouched && storedKey && input.value === storedKey) input.value = '';
  });
  $('a1cKey').addEventListener('blur', () => {
    const input = $('a1cKey');
    if (!keyTouched && input.value === '') input.value = storedKey;
  });
  $('a1cKey').addEventListener('input', () => { keyTouched = true; setKeyError(''); });
  $('a1cUser').addEventListener('input', () => setUserError(''));

  $('a1cKeyReveal').addEventListener('click', () => {
    const input = $('a1cKey');
    const shown = input.type === 'text';
    input.type = shown ? 'password' : 'text';
    const btn = $('a1cKeyReveal');
    btn.textContent = shown ? 'Show' : 'Hide';
    btn.setAttribute('aria-pressed', String(!shown));
    btn.setAttribute('aria-label', shown ? 'Show the key' : 'Hide the key');
  });

  // Not a <form>, so Enter is wired by hand — which is the trade that keeps a
  // default submit from ever putting the key in a query string.
  ['a1cUser', 'a1cKey'].forEach((id) => {
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); connect(); }
    });
  });
}
