/**
 * A5b — configure Adafruit IO.
 *
 * Sits where it does because it has to: the device is flashed two steps from here with
 * the username, the key and the three feed keys baked in, and until this screen has run
 * those keys are a guess. A board booting on a guessed feed key fetches nothing and
 * draws nothing, and there is no error anywhere to tell you why — which is the failure
 * this screen exists to prevent.
 *
 * ONE field and one action, and the screen is built to look like it. The Adafruit IO
 * account is not asked for here — it was settled once in A1-C, before the first display
 * was ever added, and this screen reads it (see the plate at the top). The device name
 * becomes the group's name, its slug becomes the group key, and it is also what this
 * display is called everywhere else in the app — the tile on A1, the crumb in the
 * chrome. The feeds box below is a preview of what will be created, and then the
 * progress display for creating it.
 *
 * WHAT THIS SCREEN SAYS, IT SAYS IN THE RAIL. The main column is the account, the field,
 * the four dots and the buttons; every standing explanation is in the aside. The group
 * key line is the exception, and only because it is a readout of what was typed rather
 * than prose: "Kitchen Board" creating `kitchen-board` is a consequence the user should
 * meet here rather than in the IO web UI afterwards.
 *
 * REUSE OVER REPLACE, always. An existing group is used as it stands and an existing
 * feed is left alone — this screen never renames or deletes anything on the account.
 */

import { ioGroupKey } from '../core/api.js';
import {
  MARQUEE_FEEDS, getGroup, createGroup, createGroupFeed, feedsIn,
} from '../device/provision.js';
import { getState, setState } from '../core/state.js';
import { navigate } from '../core/router.js';
import { activeDeviceId, groupKeyTaken, setSetupStep } from '../device/devices.js';
import { hasIoConfig, connectedUser, clearIoVerified } from '../device/credentials.js';
import { openCredentialsGate } from './a1c.js';
import { $, val, toast, setCheck, slugifyKey, setFieldValue } from '../core/util.js';

/** The label the primary button wears while requests are in flight. Named because
 *  the finally block reads it back to tell "nothing else set a label" from "a branch
 *  already said what happened". */
const BUSY_LABEL = 'Working…';

/** Set while a run is in flight, so the enter hook can't reset the dots underneath
 *  it and the button can't be double-fired. */
let running = false;

// ---------- the form -------------------------------------------------------

/** The group key, slugified from whatever is in the device-name field. */
function slug() {
  return slugifyKey($('a5bDevice')?.value);
}

/**
 * Mirror this screen's field into the canonical settings fields.
 *
 * Those live in the Settings modal and are the app's real store — every other screen
 * reads `#ioGroup`, and main.js persists it by listening for `input`. setFieldValue()
 * raises that event, so writing through here is what makes A5b's field the same
 * field rather than a second copy that drifts.
 *
 * The credentials used to be mirrored from here too. They are A1-C's now, and this
 * screen only ever reads them.
 */
function mirrorToSettings() {
  setFieldValue('ioGroup', slug());
  // The typed name, not the slug, and into the descriptor rather than the settings
  // blob — `marqueeName` is where deviceLabel() looks. This field is the only place
  // the new flow asks what to call a board, so without this write every display on A1
  // would be titled by whatever applyDisplayPreset() happened to leave behind.
  const typed = ($('a5bDevice')?.value || '').trim();
  if (typed) setFieldValue('marqueeName', typed);
}

/**
 * The group key line and whether the action is available.
 *
 * The line shows the SLUG, not what was typed — "Kitchen Board" creates
 * `kitchen-board`, and the user should find that out here rather than in the IO web
 * UI later. A name with nothing slug-able in it leaves the button disabled.
 */
function syncForm() {
  renderGroupLine();
  const key = ioGroupKey();
  // Two displays on one group publish to the same {group}.bitmap and each read the
  // other's status as their own — the one way this app can produce confidently wrong
  // behaviour rather than an obvious mess. Caught here, on the field, rather than after
  // a write that would succeed.
  const taken = groupKeyTaken(key, activeDeviceId());
  if (taken) showFormError(`Another display in this browser already uses the group ${key}. `
    + 'Give this one a different name — two boards sharing a group overwrite each '
    + "other's picture and misread each other's status.", { field: 'a5bDevice' });
  else if ($('a5bError')?.textContent.startsWith('Another display')) clearFormError();

  // hasIoConfig(), not "are the fields filled in": the account can be un-verified
  // underneath this screen — a 401 below retires the stamp — and creating feeds
  // against an unchecked key is the thing A1-C exists to prevent.
  const ready = hasIoConfig() && !!slug() && !taken;
  const btn = $('a5bCreate');
  if (btn && !running) btn.disabled = !ready;
}

/** The group key as it will actually be used. Read off the canonical field rather
 *  than recomputed from the name, because IO gets the last word on it — see the
 *  read-back in createGroupAndFeeds(). */
function renderGroupLine() {
  const el = $('a5bGroupKey');
  if (el) el.textContent = ioGroupKey() || '—';
}

/**
 * The screen's one error line.
 *
 * `field` is optional because not every failure here belongs to a field: a group
 * name already in use is about the name, and a key Adafruit IO has stopped
 * accepting is about the account plate above, which is not an input at all.
 *
 * It used to mark #a5bKey for both. That was already the wrong field for the
 * name collision — removing the key input is just what forced the fix.
 */
function clearFormError() {
  const err = $('a5bError');
  if (err) { err.hidden = true; err.textContent = ''; }
  $('a5bDevice')?.removeAttribute('aria-invalid');
}

function showFormError(msg, { field } = {}) {
  const err = $('a5bError');
  if (err) { err.hidden = false; err.textContent = msg; }
  if (field) $(field)?.setAttribute('aria-invalid', 'true');
}

// ---------- the connected account ------------------------------------------

/**
 * Which Adafruit IO account these feeds will be created on — stated, not asked for.
 *
 * Two states rather than one, because this screen is reachable without an account:
 * a reload lands on whatever setupStep the record carries, and a 401 can retire the
 * stored key's verification. In that case the plate stops being a readout and becomes
 * the way out — the create button is already disabled by syncForm(), and an error
 * line saying so with nothing to click would be a dead end.
 *
 * textContent throughout: a username is user data.
 */
function renderAccountBlock() {
  const connected = hasIoConfig();
  const user = $('a5bAccountUser');
  const keyLine = $('a5bAccountKey');
  const btn = $('a5bAccountChange');
  if (!user || !keyLine || !btn) return;

  user.textContent = connected ? connectedUser() : 'No account connected';
  keyLine.hidden = !connected;
  btn.textContent = connected ? 'Change account' : 'Connect your Adafruit IO account';
}

// ---------- the feeds box --------------------------------------------------

/** Reset the feed rows to pending, and clear whatever the last run concluded.
 *  The bare feed key is the row's resting label and the prefix every result is written
 *  onto — what the feed is FOR is said once, in the rail. */
function resetRows() {
  MARQUEE_FEEDS.forEach((f) => setCheck(f.rowId, 'wait', f.key));
  setOutcome('');
}

/**
 * The box at rest: green and settled if these feeds are already confirmed, neutral
 * and offering to create them otherwise.
 *
 * Called on entry and after any edit, so coming BACK to this screen from A6 shows
 * what is true rather than pretending nothing has happened — a row of grey dots over
 * a button labelled "create" would read as work still owed on feeds that exist.
 */
function renderRestingState() {
  if (alreadyConfirmed()) {
    // The row says the feed's name and the dot says its state — a "ready" after each
    // one, under a line that already claims all four, was the same fact three times.
    MARQUEE_FEEDS.forEach((f) => setCheck(f.rowId, 'pass', f.key));
    setOutcome('');
    setActionLabel('Continue');
    return;
  }
  resetRows();
  setActionLabel('Create group and feeds');
}

/** The one line under the rows that says how the run as a whole went. */
function setOutcome(text, tone = '') {
  const el = $('a5bOutcome');
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
  el.className = tone === 'fail' ? 'field-error' : 'hint';
}

function setFeedLimitOutcome() {
  setOutcome('Your Adafruit IO Basic account does not have enough free feeds to continue with Marquee. '
    + 'IO Basic plans provide 10 feeds, and Marquee requires 4 feeds per device. Visit your ', 'fail');
  const el = $('a5bOutcome');
  if (!el) return;
  const feedsLink = document.createElement('a');
  feedsLink.href = 'https://io.adafruit.com/feeds';
  feedsLink.textContent = 'feeds page';
  const plusLink = document.createElement('a');
  plusLink.href = 'https://io.adafruit.com/plus';
  plusLink.textContent = 'Adafruit IO Plus';
  for (const link of [feedsLink, plusLink]) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  el.append(feedsLink, ' to make room, or upgrade to ', plusLink, ' for unlimited feeds.');
}

/** A row that failed says why on the row itself, because "something went wrong"
 *  four feeds deep is not an answer anyone can act on. */
function failRow(feed, why) {
  setCheck(feed.rowId, 'fail', `${feed.key} — ${why}`);
}

// ---------- the run --------------------------------------------------------

/**
 * The primary button's label.
 *
 * The corner marks are children of the button, so only the leading text node can be
 * rewritten — setting textContent would take the blueprint frame with it.
 */
function setActionLabel(text) {
  const btn = $('a5bCreate');
  if (btn) btn.firstChild.nodeValue = text;
}

/** Lock the form while requests are in flight. Nothing moves on the screen; the
 *  fields simply stop accepting edits that the run would not pick up. */
function setBusy(busy) {
  running = busy;
  ['a5bDevice', 'a5bAccountChange'].forEach((id) => { const el = $(id); if (el) el.disabled = busy; });
  const btn = $('a5bCreate');
  if (btn) btn.disabled = busy;
}

/**
 * Whether the group and feeds on the account have already been confirmed for the key
 * the app would actually publish to.
 *
 * Not just `ioSetup === 'ready'`: a group edited since makes that claim about a
 * different group. Compared against the canonical field rather than a fresh slug of
 * the name, because that field is what every other screen reads — and IO is allowed
 * to have handed back a key that is not the one the name slugifies to.
 */
function alreadyConfirmed() {
  const st = getState();
  return st.ioSetup === 'ready' && !!st.ioGroupKey && st.ioGroupKey === ioGroupKey();
}

async function createGroupAndFeeds() {
  if (running) return;
  // Straight off the canonical store. The guard stays as defence behind a button
  // syncForm() has already disabled — this function is also reachable from Enter.
  const user = val('ioUser');
  const key = $('ioKey')?.value || '';
  const name = ($('a5bDevice').value || '').trim();
  let groupKey = slug();
  if (!user || !key || !groupKey) return;

  mirrorToSettings();
  clearFormError();
  resetRows();
  setBusy(true);
  setActionLabel(BUSY_LABEL);

  try {
    // 1. Look for the group. This is also the credential check — a bad username or key
    //    401s here, on a GET, so nothing has been written by the time we say so. There
    //    is no separate "validate" request: the endpoint that would have served one
    //    (`/{username}/user`) does not exist, and this call already knows the answer.
    const found = await getGroup(user, key, groupKey);
    if (!found.ok) {
      if (found.status === 401) {
        // A1-C proved this key, so a 401 here means it stopped being true since —
        // regenerated on io.adafruit.com, most likely. Retire the stamp rather than
        // leave the app claiming a connection it does not have, and let the plate
        // above turn into the way back.
        clearIoVerified();
        renderAccountBlock();
        showFormError('Adafruit IO rejected this key — it may have been regenerated since you '
          + 'connected. Reconnect the account above. Nothing was created.');
      } else {
        setOutcome(reason(found, 'group'), 'fail');
      }
      return;
    }

    // 2. Reuse it if it is there; create it only if it is not.

    let group = found.data;
    const groupExisted = !!group;
    if (!group) {
      const made = await createGroup(user, key, groupKey, name);
      if (!made.ok) { setOutcome(reason(made, 'group'), 'fail'); return; }
      group = made.data;

      // IO gets the last word on the key. We ask for one, but it is free to derive
      // its own from the name, and a board configured against the key we ASKED for
      // would point at a group that does not exist. Everything downstream — the feed
      // POSTs, the saved state, what is written to the board — follows what came back.
      const actual = String(group?.key || '').trim();
      if (actual && actual !== groupKey) {
        groupKey = actual;
        setFieldValue('ioGroup', groupKey);
        renderGroupLine();
      }
    }

    // 3. What the group already holds, so step 4 only adds what is missing. This is
    //    also what makes a retry after a partial run safe to press.
    const present = feedsIn(group);

    // 4. One at a time — every CREATE counts against the account's rate limit, and
    //    four at once on a free account is how the last one gets rejected for a reason
    //    that has nothing to do with what the user typed.
    let created = 0;
    let failed = 0;
    let feedLimitReached = false;
    let historyWarning = false;
    for (const feed of MARQUEE_FEEDS) {
      const existing = present.get(feed.key);
      if (existing) {
        // Reuse over replace: an existing feed is left exactly as it is, even when
        // its history setting is wrong for us. But wrong here is not cosmetic — a
        // bitmap feed with history on rejects every publish — so it is said out
        // loud rather than discovered as a 422 two screens later.
        if (!feed.history && existing.history === true) {
          setCheck(feed.rowId, 'warn', `${feed.key} — already there, but its history is ON`);
          historyWarning = true;
        } else {
          setCheck(feed.rowId, 'pass', `${feed.key} — already there`);
        }
        continue;
      }
      const out = await createGroupFeed(user, key, groupKey, feed);
      if (out.ok) {
        setCheck(feed.rowId, 'pass',
          `${feed.key} — created${feed.history ? '' : ', history off'}`);
        created++;
      } else {
        const atFeedLimit = out.status === 403 || /feed limit reached/i.test(out.error);
        feedLimitReached ||= atFeedLimit;
        failRow(feed, atFeedLimit ? 'feed limit reached' : out.error);
        failed++;
      }
    }

    if (failed) {
      // Whatever landed stays. The existence check above is what makes pressing the
      // button again finish the job rather than start it over.
      if (feedLimitReached) setFeedLimitOutcome();
      else setOutcome(
        failed === MARQUEE_FEEDS.length && !groupExisted
          ? `${groupKey} was created but its feeds were not. Try again to finish.`
          : `${failed} feed${failed === 1 ? '' : 's'} could not be created. The rest are in place — try again to finish.`,
        'fail');
      setActionLabel('Retry');
      return;
    }

    setState({ ioSetup: 'ready', ioGroupKey: groupKey });

    if (historyWarning) {
      // The feeds exist, so setup is genuinely done — but publishing will fail until
      // this is changed, and it can only be changed on Adafruit IO. Do not advance
      // past a message the user has to act on.
      setOutcome(`${groupKey}.bitmap already existed with history turned ON. Adafruit IO caps a `
        + 'datum at 1 KB on such a feed and a panel image is around 20 KB, so pushes to it will be '
        + "rejected. Turn history off in that feed's settings on Adafruit IO, or delete the feed and "
        + 'run this again. Nothing here was changed.', 'fail');
      setActionLabel('Continue anyway');
      return;
    }

    if (!created) {
      // The case the right-hand rail promises. Say we did nothing rather than
      // claiming work, and let the user leave under their own steam — auto-advancing
      // past a message whose whole content is "we didn't need to do anything" gives
      // them no chance to read it.
      setOutcome(`Already configured — ${groupKey} and all ${MARQUEE_FEEDS.length} feeds were there. Nothing was changed.`);
      setActionLabel('Continue');
      return;
    }

    toast(`Created ${created} feed${created === 1 ? '' : 's'} in ${groupKey}`);
    advance();
  } finally {
    setBusy(false);
    // Every branch that concluded something has already said so on the button —
    // "Retry" after a partial run, "Continue" when there was nothing to do. What is
    // left is the branches that returned early on an error, and the success that
    // navigated away: both would otherwise leave the button reading "Working…" on a
    // screen where nothing is working.
    if ($('a5bCreate')?.firstChild.nodeValue === BUSY_LABEL) {
      setActionLabel(alreadyConfirmed() ? 'Continue' : 'Create group and feeds');
    }
    syncForm();
  }
}

/**
 * On to Wi-Fi, recording that this step is behind us.
 *
 * One function rather than three navigate() calls, because every exit from this screen
 * owes the same bookkeeping: setupStep is what "resume this device's setup" reads, and
 * a path that forgets to write it sends the user back here forever.
 */
function advance() {
  const id = activeDeviceId();
  if (id) setSetupStep(id, 'a5c');
  navigate('a5c');
}

/** Why a group-level call failed, in terms of what the user can do about it. */
function reason(out, what) {
  if (out.status === 403) {
    return `Your Adafruit IO plan will not allow another ${what}. Free up one, or upgrade at io.adafruit.com, then try again.`;
  }
  return `${out.error} — could not read or create the ${what}.`;
}

// ---------- boot -----------------------------------------------------------

export function initA5b({ onEnter }) {
  $('a5bBack').addEventListener('click', () => navigate('a4'));

  // A real escape hatch. The editor works without a board, and holding someone in setup
  // because their network is down would be worse than letting them design first — but
  // the device gets flashed with feed keys that may point at nothing, so say so plainly
  // rather than letting them find out from a blank panel.
  $('a5bSkip').addEventListener('click', () => {
    setState({ ioSetup: 'skipped' });
    advance();
    toast('Skipped — the board will be flashed with feed keys that may not exist yet');
  });

  // Once these feeds are confirmed, the button is the way forward rather than a
  // second write. Re-running would only re-read the group to conclude what it
  // already concluded, and spend the account's rate limit doing it.
  $('a5bCreate').addEventListener('click', () => {
    if (alreadyConfirmed()) advance();
    else createGroupAndFeeds();
  });

  $('a5bDevice').addEventListener('input', () => {
    clearFormError();
    mirrorToSettings();
    // Editing after a run makes the result stale — the dots would otherwise keep
    // claiming feeds are ready under a group key that no longer applies.
    if (!running) renderRestingState();
    syncForm();
  });

  $('a5bAccountChange').addEventListener('click', (e) => {
    const before = connectedUser();
    openCredentialsGate({ mode: 'edit', trigger: e.currentTarget, onSaved: () => {
      renderAccountBlock();
      clearFormError();
      // A confirmed group on the OLD account is not a confirmed group on this one.
      // alreadyConfirmed() only compares group KEYS, so the swap has to retire the
      // claim itself — otherwise four green dots and a "Continue" button would go
      // on asserting that these feeds exist on an account they may never have.
      if (connectedUser().toLowerCase() !== before.toLowerCase() && getState().ioSetup === 'ready') {
        setState({ ioSetup: 'pending' });
      }
      renderRestingState();
      renderGroupLine();
      syncForm();
    } });
  });

  onEnter('a5b', () => {
    if (running) return;
    const st = getState();

    // The group key we resolved last time, else the name the user gave the marquee
    // on A5 — which is almost always the answer, and saves retyping it.
    $('a5bDevice').value = st.ioGroupKey || ioGroupKey() || val('marqueeName');

    // Before the staleness check below, which asks whether the confirmed group is
    // still the one we would publish to — a question about #ioGroup, and #ioGroup has
    // just been left behind by the device name we seeded a line ago.
    mirrorToSettings();

    // A group edited in Settings after setup invalidates the confirmation: the feeds
    // we verified are not the feeds we would now publish to.
    if (st.ioSetup === 'ready' && st.ioGroupKey !== ioGroupKey()) {
      setState({ ioSetup: 'pending' });
    }

    clearFormError();
    setBusy(false);
    renderAccountBlock();
    renderRestingState();
    syncForm();
  });
}
