/**
 * Pointing the app at a different device.
 *
 * devices.js is a pure store — it knows what a device IS, and deliberately imports
 * nothing but util.js so that a setup screen touching it does not drag Konva in. This
 * module is the other half: it knows what has to be torn down and rebuilt when the
 * record underneath the app changes, which means importing most of the editor.
 *
 * It lives apart from main.js because A1 has to call it too, and a screen importing the
 * entry point would be a cycle.
 *
 * THE ORDERING IS THE POINT. Most of these steps are individually obvious and only work
 * in this sequence; the load-bearing ones say why inline. If you add a step, add it
 * where its reason puts it, not at the end.
 */

import { snapshotConfig, loadConfig, syncDerivedUI } from '../core/config.js';
import {
  deserialize, serialize, saveCanvasNow, cancelCanvasSave, invalidateCanvasBaseline,
  whenCanvasSettled,
} from '../core/doc.js';
import { readCanvasState, noteCanvasStateSeen } from './canvasfeed.js';
import { resetCounter } from '../canvas/elements.js';
import { stopDeviceRuntime, ensureStatusWatch } from './device.js';
import { hideDitherPreview } from '../canvas/stage.js';
import { syncNav } from '../core/router.js';
import { getState, replaceFlow } from '../core/state.js';
import * as devices from './devices.js';
import { syncCfg } from './cfg.js';
import { deleteGroupFeeds } from './provision.js';
import { hasIoConfig, connectedUser } from './credentials.js';
import { ioGroupKey } from '../core/api.js';
import { syncPushBlock, syncIntervalFromField } from '../screens/a7.js';
import { resetDrawnCache, capturePanelFromCanvas } from '../screens/a8.js';

/**
 * Adopt the scene from {group}.canvas-state, if that is the newer one.
 *
 * WHO WINS, and why it is decided on time rather than on principle. localStorage is
 * still the store — every edit lands there first — but it is one browser's copy of a
 * document that now has a home both browsers can reach. So the rule is simply "the
 * newer scene is the scene", measured with the two stamps that exist: when this
 * browser last saved (devices.canvasSavedAt) and when IO accepted the datum
 * (createdAt, IO's own server clock).
 *
 *   nothing on the feed     keep what is here — including a canvas that is empty
 *                           because this display has genuinely never been drawn on.
 *   same scene both ends    nothing to decide. Checked FIRST, and on the bytes, so the
 *                           ordinary case — this browser reading back its own publish —
 *                           never depends on two clocks agreeing.
 *   nothing saved here      the feed wins. This is the case the feed exists for: a
 *                           machine that has never opened this display.
 *   feed newer              the feed wins. Somebody edited this display elsewhere.
 *   local newer or equal    keep what is here. The publish debounce in canvasfeed.js
 *                           carries it up on its own; nothing to do.
 *
 * The two clocks are a browser's and IO's, so the last two lines rest on them being
 * roughly in step. That is only ever consulted when the scenes genuinely differ, and
 * there is nothing better available: a datum carries IO's stamp and a localStorage
 * write carries this machine's, and no amount of care makes those the same clock.
 *
 * Off the critical path deliberately. rehydrateFor() does not await it, so a slow or
 * unreachable IO delays nothing — the editor opens on the local scene and the feed
 * replaces it a moment later if it has something newer to say. Everything it touches
 * is re-checked against `id` afterwards, because a user who clicks two tiles in a
 * second will have moved on before this returns.
 */
async function hydrateFromCanvasFeed(id) {
  const remote = await readCanvasState();
  if (!remote || devices.activeDeviceId() !== id) return;

  // Byte-for-byte against what is STORED, not against a fresh serialize() of the live
  // canvas: canvasfeed.js publishes exactly the JSON that devices.saveCanvas() wrote, so
  // a datum this browser put there matches its stored document character for character,
  // while a round-trip through Konva can differ in a rounded coordinate and would read
  // as a change that is not one.
  if (remote.json === JSON.stringify(devices.loadCanvas(id))) return;

  const localAt = devices.canvasSavedAt(id);
  if (localAt && remote.at && remote.at <= localAt) return;

  // The feed holds this exact payload, so the save below must not echo it back up.
  noteCanvasStateSeen(remote.json);
  // The local document's own autosave is still pending from the deserialize in
  // rehydrateFor(); letting it fire after this one would write the scene we are
  // replacing back over the record.
  cancelCanvasSave();

  // keepDisplay for the same reason as the local load: the panel descriptor is this
  // bench's, and the display block inside a document authored on another machine
  // describes that machine's idea of the panel, not the pins in front of the user.
  deserialize(remote.doc, { keepDisplay: true });
  invalidateCanvasBaseline();
  saveCanvasNow();

  // Images decode asynchronously, so the canvas is not finished until they land — and
  // photographing it early would cache a panel with holes where the artwork goes.
  await whenCanvasSettled();
  if (devices.activeDeviceId() !== id) return;
  // The scene is now on the canvas but nothing in this browser has a picture of what
  // the display is carrying: the A1 tile would say "Nothing drawn yet" and A8's left
  // glass would sit empty. Render it once and file it.
  await capturePanelFromCanvas();
}

/**
 * Rebuild the world around a record. Every path that changes which device the app is
 * looking at ends here — an A1 tile, a setup run finishing, the first activation at
 * boot — so this is the single description of what "showing a device" means.
 */
export async function rehydrateFor(rec) {
  if (!rec) return;

  devices.restoreDeviceFields(rec.settings || {});

  // The dither overlay is a bitmap of the OUTGOING panel at the outgoing geometry.
  // setResolution() only suspends it, which hides without cancelling, so left alone it
  // reappears over the new board's artwork.
  hideDitherPreview();

  // BEFORE the deserialize. loadConfig() ends in remapColorsToPalette(), which rewrites
  // every element's fill against the CURRENT palette — run it after the artwork lands
  // and the incoming design gets remapped into the outgoing board's colour space.
  loadConfig(rec.displayConfig);
  // The descriptor and the settings fields are both in place now, so the board's config
  // file can be rebuilt from them. This is also how a record minted before `cfg` existed
  // gets one: the first time it is opened, not by a migration pass.
  syncCfg();

  // keepDisplay because the descriptor loaded a line above is the authority, not
  // whatever display block the stored document happens to carry.
  resetCounter();
  // A record minted by the migration with no local copy simply starts empty: the
  // server-side canvas.json it used to be seeded from no longer exists.
  const doc = devices.loadCanvas(rec.id);
  if (!doc && devices.activeNeedsCanvasSeed()) devices.markCanvasSeeded(rec.id, null);
  deserialize(doc || { version: 1, elements: [] }, { keepDisplay: true });

  // deserialize() fires 'draw' for every element it destroys and re-adds, and the
  // de-dupe baseline still holds the outgoing document. Drop it, or a first edit that
  // happens to serialize identically is swallowed as a no-op.
  invalidateCanvasBaseline();
  saveCanvasNow();

  // The action bar reads sleepDuration, which just changed under it with no input event
  // to notice.
  syncIntervalFromField();
  syncPushBlock();

  // This board's panel cache, this board's status watch, and a last pass over the
  // derived UI so selectedPanel (from the flow) and the form (from the descriptor)
  // agree — hasOverrides() compares the two, and disagreeing makes "Reset to preset" lie.
  resetDrawnCache();
  ensureStatusWatch();
  syncDerivedUI();
  syncNav();

  // Last, and NOT awaited: the display is fully shown by this point, and what follows
  // is a second opinion from Adafruit IO about which scene that should have been.
  hydrateFromCanvasFeed(rec.id).catch(() => { /* the local scene is up and stays up */ });
}

/**
 * Delete the removed display's group and feeds on Adafruit IO — silently, best-effort.
 *
 * Skipped when there is no verified account to do it with, when the record never got a
 * group (a draft abandoned before A5b), and when another display in this browser still
 * uses the same group key: that one's feeds are not this one's to delete.
 */
function cleanupFeeds(rec, wasActive) {
  const groupKey = ((wasActive ? ioGroupKey() : '') || rec.settings?.ioGroup || '').trim();
  if (!groupKey || !hasIoConfig()) return;
  if (devices.groupKeyTaken(groupKey, rec.id)) {
    console.log(`[io] delete ${groupKey} skipped — another display in this browser uses it`);
    return;
  }
  const user = connectedUser();
  const key = document.getElementById('ioKey')?.value || '';
  deleteGroupFeeds(user, key, groupKey)
    .then((out) => {
      if (!out.ok) console.warn(`[io] some of ${groupKey}'s feeds could not be deleted:`, out.failed);
    })
    .catch((err) => console.warn(`[io] feed cleanup for ${groupKey} threw`, err));
}

/**
 * Forget a device, and leave the app pointed at something coherent.
 *
 * The delete itself is one line in devices.js. Everything here is about the case that
 * line cannot see: the device being removed is usually the ACTIVE one, which means the
 * live stores — the Konva canvas, the descriptor form, the status watch — are still
 * full of it after its record is gone.
 *
 * Left alone that is not a cosmetic problem. devices.deleteDevice() moves `activeId` to
 * the first surviving record, and doc.js's autosave writes to whatever `activeId` says,
 * so the deleted board's dashboard lands in the surviving board's record on the next
 * edit. And the obvious repair — click the tile of the device you want — does nothing,
 * because activateDevice() early-returns when the id is already active.
 *
 * So: stop the outgoing device's runtime and its pending save FIRST, delete, then
 * rehydrate onto whoever inherited `activeId`. With nothing left to inherit it, the
 * editor is emptied by hand — the same end state, reached without a record to load.
 */
export async function removeDevice(id) {
  const rec = devices.getDevice(id);
  if (!id || !rec) return;
  const wasActive = id === devices.activeDeviceId();

  // The board's feeds go with the record. Started BEFORE the delete, because the group key
  // and the credentials are read from the record and the live fields that are about to be
  // cleared; not awaited, because four requests to Adafruit IO must not hold up a local
  // removal, and a failure there is a console line, not a reason to keep the tile.
  cleanupFeeds(rec, wasActive);

  if (wasActive) {
    // The 400ms autosave debounce must not fire after activeId moves — the same hazard
    // activateDevice() cancels for, with the added twist that here the record it would
    // be writing no longer exists.
    cancelCanvasSave();
    // This board's status watch, timers and broker registrations go with the record. A
    // reset, not a look-away: unlike a device switch, this one is not coming back.
    stopDeviceRuntime();
  }

  devices.deleteDevice(id);
  if (!wasActive) return;

  const next = devices.activeDevice();
  if (next) {
    replaceFlow(next.flow);
    await rehydrateFor(next);
    return;
  }

  // Nothing left to show. The canvas still holds the deleted device's artwork, and the
  // next display anyone adds would inherit it the moment its first save ran.
  //
  // The identity fields go FIRST, and this is the load-bearing line. Emptying the canvas
  // fires 'draw', which schedules a save, which publishes the scene to
  // {ioGroup}.canvas-state — and #ioGroup still names the display just deleted. Without
  // this, removing a display from this browser would blank the scene on a board that is
  // still out there running. Blanking the key makes that publish addressless, which
  // canvasfeed.js already treats as "no feed, nothing to do".
  devices.restoreDeviceFields({ pmDevice: '', ioGroup: '' });
  replaceFlow(undefined);
  hideDitherPreview();
  resetCounter();
  deserialize({ version: 1, elements: [] }, { keepDisplay: true });
  invalidateCanvasBaseline();
  // The panel cache in a8.js is memory as well as storage, and deleteDevice() only took
  // the storage half.
  resetDrawnCache();
  // The deserialize above schedules a save of an empty canvas that belongs to no record.
  // There is nowhere for it to go and nothing for it to say.
  cancelCanvasSave();
  syncNav();
}

/**
 * Switch to a device, flushing the one being left.
 *
 * The flush half is here rather than in devices.js because what has to be captured —
 * the live Konva document and the live descriptor form — is only reachable through
 * modules that store must not import.
 */
export async function activateDevice(id) {
  if (!id || id === devices.activeDeviceId()) return;

  // The 400ms autosave debounce must not fire after activeId moves, or the outgoing
  // document is written into the incoming record.
  cancelCanvasSave();
  // Drop this page's view of the outgoing board. NOT a reset: that board is still out
  // there, and its broker registrations have to survive being looked away from.
  stopDeviceRuntime();

  const snapshot = devices.activeDevice()
    ? { flow: getState(), displayConfig: snapshotConfig(), canvas: serialize() }
    : undefined;

  devices.setActive(id, snapshot);
  // After setActive(), so the record is current before any subscriber this wakes runs.
  replaceFlow(devices.getDevice(id)?.flow);
  await rehydrateFor(devices.getDevice(id));
}
