/**
 * Boot, the settings field bank, and the device-switch sequence.
 *
 * "Settings" is no longer a screen anyone can open — the chrome button that was its
 * only door is gone. #settingsModal stays mounted and hidden all the same, because it
 * was never really a settings dialog: it is the DOM home of the app's live store, and
 * config.js, api.js and devices.js all read straight out of it. See initSettings().
 *
 * Order matters in three places and nowhere else:
 *   - initDevices() runs FIRST. It migrates the pre-multi-device stores and decides
 *     which record is active, and both initSettings() and initConfig() need a record
 *     to restore from.
 *   - initConfig() runs before anything reads the display descriptor, because it is
 *     what restores it and pushes it into `display`.
 *   - the screen modules register their enter hooks before the first navigate(), or
 *     the landing screen would miss its own hook.
 *
 * The device-switch sequence itself is activate.js — A1 has to call it too, and a
 * screen importing this entry point would be a cycle.
 */

import { initConfig } from './core/config.js';
import { initDoc, saveCanvasNow } from './core/doc.js';
import { initRender } from './canvas/render.js';
import { initFeeds } from './device/feeds.js';
import { initIconFont } from './canvas/elements.js';
import { initDevice } from './device/device.js';
import { initKeyboard, initDeselect, initContextMenu } from './canvas/selection.js';
import { initRouter, navigate, onEnter, syncNav, isNavigable, wasOnList } from './core/router.js';
import { getState, subscribe, replaceFlow } from './core/state.js';
import * as devices from './device/devices.js';
import { rehydrateFor, removeDevice } from './device/activate.js';
import { initA1 } from './screens/a1.js';
// A1-C is a modal, not a route — it registers no enter hook and router.js has
// never heard of it. Its init lives here so the one-line-per-screen list stays honest.
import { initA1c, openCredentialsGate } from './screens/a1c.js';
import { initA4 } from './screens/a4.js';
import { initA5b } from './screens/a5b.js';
import { initA5c } from './screens/a5c.js';
import { initA6a } from './screens/a6a.js';
import { initA7 } from './screens/a7.js';
import { initA8 } from './screens/a8.js';
import { $, wireModal, closeModal, toast } from './core/util.js';
import { clearIoVerified, hasIoConfig, connectedUser } from './device/credentials.js';
import { syncCfg } from './device/cfg.js';

// ---------- settings persistence --------------------------------------------
//
// Credentials, the device identity and the sleep behaviour live in localStorage rather
// than on the server: they are per-browser bench setup, and keeping them client-side
// means they survive a server restart.
//
// They are no longer ONE blob. Half of these fields describe the Adafruit IO account
// and half describe a particular board, and the split is declared once in
// devices.js#SETTINGS_SCOPE so a field cannot quietly end up in both or neither. The
// legacy migration that used to live here (ioFeed -> ioGroup)
// moved into devices.js#migrate(), which is the last place the old flat blob is ever
// read — so they now run once instead of on every boot forever.
//
// NOTE: the AIO key is stored here in plaintext, and so — per display, in `rec.cfg` —
// are the Wi-Fi credentials A5C collects. Acceptable for a local dev tool on your own
// machine; both are written onto the device at A6-A. See device/cfg.js.

function saveSettings(id) {
  const scope = devices.SETTINGS_SCOPE[id];
  if (scope === 'account') {
    // An edit to either credential retires the verification: neither is a check
    // against Adafruit IO. saveIoAccount() writes its stamp AFTER raising these same
    // events, which is why it can do both without fighting this line.
    if (id === 'ioUser' || id === 'ioKey') clearIoVerified();
    devices.saveAccount(devices.snapshotAccountFields());
  } else devices.flushActive();
  // Account and group key both land in the board's config file, so it follows every
  // settings write — including A5b's mirror into #ioGroup and A1-C's into #ioUser/#ioKey.
  syncCfg();
}

function restoreSettings() {
  devices.restoreAccountFields();
  devices.restoreDeviceFields(devices.activeDevice()?.settings || {});
}

/**
 * Which Adafruit IO account this browser is on, in Settings — the same read-only
 * plate A5b carries, for the same reason. The fields behind it are hidden, so this
 * is the only thing here that says who we are talking to.
 */
function renderSettingsAccount() {
  const connected = hasIoConfig();
  const user = $('settingsAccountUser');
  const keyLine = $('settingsAccountKey');
  if (!user || !keyLine) return;
  user.textContent = connected ? connectedUser() : 'No account connected';
  keyLine.hidden = !connected;
  $('settingsAccountChange').textContent = connected
    ? 'Change account' : 'Connect your Adafruit IO account';
}

/**
 * Wire the settings fields. NOTHING OPENS #settingsModal any more — the chrome button
 * was its only entry point and it has been removed — so everything below is field
 * persistence, and the handlers on the modal's own controls are inert.
 *
 * The markup stays mounted regardless, and that is the load-bearing part: those inputs
 * ARE the store. feeds.js/credentials.js/canvasfeed.js read #ioUser and #ioKey, and
 * config.js builds
 * the display descriptor out of the advanced disclosure — several of those reads are
 * not optional-chained, so deleting the markup throws during boot rather than degrading.
 *
 * The in-modal handlers are kept for the same reason the markup is: they cost one
 * listener each, and giving the modal a door again is a single openModal() call.
 */
function initSettings() {
  wireModal('settingsModal', ['settingsClose', 'settingsDone']);

  // Settings closes FIRST. The shared Escape handler dismisses every modal in the
  // open set, so leaving this one behind A1-C would mean one keypress taking both.
  $('settingsAccountChange')?.addEventListener('click', (e) => {
    const trigger = e.currentTarget;
    closeModal('settingsModal');
    openCredentialsGate({ mode: 'edit', trigger, onSaved: renderSettingsAccount });
  });

  restoreSettings();
  renderSettingsAccount();

  Object.keys(devices.SETTINGS_SCOPE).forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', () => saveSettings(id));
  });

  // Send THIS device back through setup. Only its flow record is cleared — the panel
  // descriptor, credentials and dashboard are bench setup and survive, exactly as they
  // do through "Reset state".
  //
  // The copy names the device on purpose: with more than one on the list, "setup
  // runs again" never said which one it meant.
  $('restartSetup')?.addEventListener('click', async () => {
    const rec = devices.activeDevice();
    if (!rec) { toast('No display selected'); return; }
    const name = devices.deviceLabel(rec);
    if (!confirm(`Start setup over for "${name}"?\n\nYou will pick the device, its Adafruit IO `
      + 'group and its Wi-Fi again. Its panel settings, credentials and current dashboard '
      + 'are kept.')) return;
    devices.resetDevice(rec.id);
    closeModal('settingsModal');
    navigate('a4');
    toast(`Setup restarted for ${name}`);
  });

  // Forget this device entirely. The sibling to the above, and the only way to get a
  // record out of the list.
  $('removeDisplay')?.addEventListener('click', async () => {
    const rec = devices.activeDevice();
    if (!rec) { toast('No display selected'); return; }
    const name = devices.deviceLabel(rec);
    if (!confirm(`Remove "${name}"?\n\nIts dashboard and settings are deleted from this `
      + 'browser, and its group and feeds are deleted from Adafruit IO. The board itself is '
      + 'not touched — it keeps running whatever was last flashed onto it.')) return;
    closeModal('settingsModal');
    // The same path A1's Remove takes, and it does more than delete: this record is the
    // active one, so the canvas, the descriptor and the status watch in front of the user
    // are all still full of it — see removeDevice().
    await removeDevice(rec.id);
    navigate('a1');
    toast(`Removed ${name}`);
  });
}

// ---------- where to land ---------------------------------------------------

function landingScreen() {
  const rec = devices.activeDevice();
  // Left for the list, so a reload stays on the list — even with setup unfinished. The
  // draft's setupStep is not lost: it is what its "Setup in progress" tile resumes to.
  // Ahead of everything, because which device is active says nothing about the list.
  if (!rec || wasOnList()) return 'a1';
  const st = getState();
  // Setup progress is recorded on the record, not inferred from flow state.
  if (rec.setupStep) return rec.setupStep;
  // A reload lands where you were. This has to come before the sleep rule below, which
  // used to win and sent a refresh of the editor to Showtime whenever the board slept.
  //
  // isNavigable() is required, not defensive padding: a record migrated from the old
  // build can carry lastScreen: 'a5', which is parked. navigate() hard-rejects it, so
  // NO screen would get data-active and the app would boot to an empty <main> with
  // nothing thrown.
  if (st.lastScreen && isNavigable(st.lastScreen)) return st.lastScreen;
  // No screen to go back to: a sleeping device opens on the sleep state, not the
  // editor — that is the screen that explains why nothing is updating.
  if (st.deviceState === 'asleep' && st.lastWriteAt) return 'a8';
  return 'a7';
}

// ---------- go --------------------------------------------------------------

async function boot() {
  devices.initDevices();

  initRouter();
  initSettings();
  initConfig();
  initDoc();
  initRender();
  initFeeds();
  initDevice();
  initKeyboard();
  initDeselect();
  initContextMenu();

  // One init per navigable screen, and router.js's SCREENS is the same list.
  initA1c();
  initA1({ onEnter });
  initA4({ onEnter });
  initA5b({ onEnter });
  initA5c({ onEnter });
  initA6a({ onEnter });
  initA7({ onEnter });
  initA8({ onEnter });

  // Any flow-state change can move the rail or the device pill — and has to
  // reach the active device's record.
  //
  // The mirror is not optional bookkeeping. state.js persists to its own single key, so
  // without this the record's `flow` slice was only refreshed when something happened to
  // call flushActive() — a device switch, or an edit in Settings. Everything in between
  // (deviceState, wakesAt, lastWriteAt, lastScreen) went to the global key and never to
  // the record, and boot's replaceFlow(rec.flow) then installed the stale copy OVER the
  // fresher one. The visible symptom was reopening the app on the last setup screen you
  // happened to pass through instead of the editor.
  subscribe(() => {
    devices.patchActive({ flow: getState() });
    syncNav();
  });

  const rec = devices.activeDevice();
  if (rec) {
    // The first activation of the session. No flush — there is no outgoing device — but
    // everything else has to run, because the stores were just loaded from a record
    // rather than from the keys initConfig() and initSettings() know about.
    replaceFlow(rec.flow);
    await rehydrateFor(rec);
  }

  navigate(landingScreen());
  if (!rec) saveCanvasNow();   // render + persist the initial (empty) state

  // After the restore, not before: it re-draws the gauges that show an icon once the
  // Font Awesome face resolves, and on a cold load those gauges don't exist yet when
  // boot starts. Deliberately not awaited — the editor must not wait on a font.
  initIconFont();
}

boot().catch((err) => {
  console.error('Marquee failed to start', err);
  toast('Marquee failed to start — see the console');
});
