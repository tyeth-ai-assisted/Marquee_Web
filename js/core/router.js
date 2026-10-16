/**
 * Screen navigation, the editor rail, and the chrome bar.
 *
 * Screens are shown and hidden, never created or destroyed — see the note in
 * index.html. `navigate()` is therefore cheap, and the per-screen enter hooks
 * exist for the things that genuinely need a visible container (measuring the
 * canvas to fit the zoom, sizing a panel preview).
 *
 * THE FLOW:
 *
 *   A1 device list → A4 pick device → A5b Adafruit IO → A5C Wi-Fi → A6-A flash
 *                                                                      ↓
 *                                              A1 ← ‹ ALL DISPLAYS ← A7 ⇄ A8
 *
 * A7 and A8 are a loop of their own; setup is only ever re-entered by adding a
 * device. There is no act staging left on the setup screens — no numerals, no
 * locked cells, no "step 2 of 3". The rail survives only as a two-entry switch
 * between the two editor screens.
 *
 * SCREENS below is the whole set, and `navigate()` hard-rejects anything not in
 * it. Keep that rejection a hard return rather than a warning: it is what stops a
 * `lastScreen` from an older build routing to a screen that no longer exists.
 */

import { getState, setState } from './state.js';
import { displayState } from '../device/cycle.js';
import { activeDevice, deviceLabel, isFinished } from '../device/devices.js';
import { $, $$, val, show } from './util.js';

/**
 * Every reachable screen, and what the chrome owes it.
 *
 *   chrome  'list'   A1 — above the flow. No device identity, because the list is
 *                    about all of them and the active one is an implementation detail.
 *           'setup'  the setup run. No device state; ALL DISPLAYS asks before leaving.
 *           'device' A7/A8 — the full set: countdown, ALL DISPLAYS, the state lamp.
 *   rail    which of the two editor cells is current, or null for no rail at all.
 */
const SCREENS = {
  a1:  { chrome: 'list',   rail: null },
  a4:  { chrome: 'setup',  rail: null },
  a5b: { chrome: 'setup',  rail: null },
  a5c: { chrome: 'setup',  rail: null },
  a6a: { chrome: 'setup',  rail: null },
  a7:  { chrome: 'device', rail: 'build' },
  a8:  { chrome: 'device', rail: 'show' },
};

let current = null;
const enterHooks = new Map();

/**
 * Whether the list was the last screen shown, kept for the BROWSER rather than per device.
 *
 * `lastScreen` lives in the active device's flow slice, and the list is the one screen that
 * is not about the active device — which can even change underneath it: arriving here
 * discards an untouched draft, and removing a tile moves activeId on. Either way the next
 * device's own lastScreen would answer a reload of the list with "the editor".
 */
const ON_LIST_KEY = 'marquee.onList';

export function wasOnList() {
  try { return localStorage.getItem(ON_LIST_KEY) === '1'; } catch { return false; }
}

/** Register a callback run every time `screen` becomes visible. */
export function onEnter(screen, fn) {
  const list = enterHooks.get(screen) || [];
  list.push(fn);
  enterHooks.set(screen, list);
}

export function currentScreen() { return current; }

/** Whether a screen id can be routed to. Parked screens answer false, which is what
 *  a restored `lastScreen` has to be checked against — see landingScreen(). */
export function isNavigable(screen) { return !!SCREENS[screen]; }

/**
 * Where opening a device lands: the step it still owes, or the editor.
 *
 * Setup progress is RECORDED rather than inferred. The old actOneEntry() /
 * editorEntry() pair read flow state to guess how far setup got, which worked while
 * every step left a trace in it. A5C leaves none — Wi-Fi credentials are held in
 * memory and deliberately never persisted — so there is nothing to infer from, and
 * each setup screen writes `setupStep` on its way out instead.
 */
export function deviceEntry(rec) { return rec?.setupStep || 'a7'; }

export function navigate(screen) {
  if (!SCREENS[screen]) return;
  current = screen;
  $$('.screen').forEach((el) => { el.dataset.active = String(el.dataset.screen === screen); });
  // Remembered so a reload lands where the user left off. Safe to do before the
  // sync below: the subscriber this wakes only re-renders nav, it never navigates.
  setState({ lastScreen: screen });
  try { localStorage.setItem(ON_LIST_KEY, screen === 'a1' ? '1' : '0'); } catch { /* storage disabled */ }
  syncRail();
  syncChrome();
  // After the display flip, so anything measuring a container sees real numbers.
  requestAnimationFrame(() => enterHooks.get(screen)?.forEach((fn) => fn()));
}

// ---------- the rail --------------------------------------------------------

/**
 * Two cells, no state machine.
 *
 * What used to be here — locked/done/active per act, a collapsed mode, a status line
 * under each title, and a lock on Act III until something had been written — was all
 * in service of a rail that doubled as a progress meter for first-run setup. Setup no
 * longer has a rail, so none of it has anything to describe. What is left is a switch
 * between two screens that are always both available.
 */
function syncRail() {
  const rail = $('stepRail');
  if (!rail) return;

  const slot = SCREENS[current]?.rail || null;
  show(rail, !!slot);
  if (!slot) return;

  $$('.step', rail).forEach((cell) => {
    const on = cell.dataset.rail === slot;
    cell.dataset.state = on ? 'active' : 'idle';
    cell.dataset.clickable = String(!on);
    cell.disabled = on;
  });
}

// ---------- the chrome bar --------------------------------------------------

function syncChrome() {
  const st = getState();
  const kind = SCREENS[current]?.chrome || 'setup';

  // ALL DISPLAYS is on every screen but the list itself. During setup it asks first —
  // see leaveForList() — so leaving a half-configured board is a decision, not a stray
  // click in the chrome.
  show($('crumbAllDisplays'), kind !== 'list');

  // The device status pill. Editor screens only. Hidden on A1 because the list is about
  // every device, and a lamp up here would be reporting on whichever one happens to be
  // active behind it; hidden during setup because a board being re-run through the flow
  // is being reconfigured, and what it was last doing is not the point of those screens.
  //
  // On A7/A8, shown whenever there is ANYTHING to say — a write of our own, or a
  // report from the board.
  const pill = $('devicePill');
  const showDevice = kind === 'device' && !!(st.lastWriteAt || st.lastWokeAt || st.lastSleptAt);
  pill.hidden = !showDevice;

  if (showDevice) {
    // The three states, and the whole set. `{feed}-status` publishes `awake` or
    // `sleeping` (docs/marquee-status.md), device.js turns those into `deviceState`,
    // and cycle.js adds the one thing the feed cannot report: a board that proved it
    // reports and then went quiet. The derivation is imported rather than repeated
    // because the Showtime clock renders from the same call — this label and that
    // countdown disagreeing is the exact failure cycle.js exists to prevent.
    const phase = displayState(st);
    pill.className = `pill ${phase === 'redrawing' ? 'pill-on-air' : phase === 'offline' ? 'pill-offline' : 'pill-asleep'}`;
    pill.querySelector('[data-role="text"]').textContent =
      phase === 'offline' ? 'Offline' : phase === 'sleeping' ? 'Sleeping 💤' : 'On air';
  }

  // The last crumb is the board being edited. Read from the LIVE form rather than the
  // stored record, so renaming in Settings reaches the crumb while the dialog is
  // still open — it is the only field up there whose effect is visible behind the
  // modal. The record is the fallback for the moment before the form is populated.
  const crumb = $('crumbBoard');
  if (crumb) {
    const live = (val('marqueeName') || val('pmDevice') || '').trim();
    crumb.textContent = kind === 'list' ? 'All displays' : (live || deviceLabel(activeDevice()));
  }
}

/** Re-render the rail and chrome without changing screen. */
export function syncNav() {
  syncRail();
  syncChrome();
}

/**
 * ALL DISPLAYS. Straight there from the editor; from a setup screen, only once confirmed.
 *
 * Nothing is lost either way — a draft keeps its setupStep and shows on the list as a
 * resume tile — but a board can be mid-flash on A6-A, and pulling the screen out from under
 * that is the click this exists to catch. A finished display on those screens is being
 * re-flashed or moved to a new network rather than set up, so it is asked in those terms.
 */
function leaveForList() {
  if (SCREENS[current]?.chrome === 'setup') {
    const message = isFinished(activeDevice())
      ? 'Are you sure you want to leave?\n\nAnything not yet written to the board will not reach it.'
      : 'Are you sure you want to exit setup?\n\nYour progress is saved, you can pick up from where you left off by clicking the display tile.';
    if (!confirm(message)) return;
  }
  navigate('a1');
}

export function initRouter() {
  $$('#stepRail .step').forEach((cell) => {
    cell.addEventListener('click', () => {
      if (cell.dataset.clickable !== 'true') return;
      navigate(cell.dataset.rail === 'build' ? 'a7' : 'a8');
    });
  });

  $('crumbAllDisplays')?.addEventListener('click', leaveForList);

  // Renaming the board in Settings has to reach the crumb while the dialog is still
  // open. Both fields feed deviceLabel(), so both have to be watched.
  $('pmDevice')?.addEventListener('input', syncChrome);
  $('marqueeName')?.addEventListener('input', syncChrome);

  // Any flow-state change can move the pill or a rail cell.
  return { syncNav };
}
