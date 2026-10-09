/**
 * Which Adafruit IO account this browser is pointed at, and whether anyone has
 * checked it.
 *
 * The account itself is NOT stored here. `#ioUser` and `#ioKey` — the two fields in
 * the Settings modal — are the app's real store: devices.js scopes them to the
 * account, main.js persists them off their own `input` event, and every reader in
 * the app goes through `val('ioUser')` / `val('ioKey')`. This module adds the one
 * fact those fields cannot carry: that the pair has been PROVEN against Adafruit IO
 * rather than merely typed.
 *
 * That distinction is the whole point of the gate. Without it a user who pasted
 * garbage walks straight past A1-C and discovers the problem four screens later, on
 * the flash step, which is exactly the failure the dialog exists to remove.
 */

import { ioHost } from '../core/api.js';
import { getAccount, saveAccount } from './devices.js';
import { $, val, setFieldValue } from '../core/util.js';

/**
 * Whether setup can start.
 *
 * Three parts, and each one is load-bearing:
 *
 *   - both fields have something in them;
 *   - the stamp names THIS username, so a username edited afterwards falsifies it;
 *   - the stamp names THIS host, so a verification recorded against any other
 *     Adafruit IO host does not count here.
 *
 * A key swapped out from under the stamp is the one case this cannot see, which is
 * why A1-C is the only way to change one — and why main.js clears the stamp if the
 * fields are ever written any other way.
 */
export function hasIoConfig() {
  const user = val('ioUser');
  const v = getAccount().ioVerified;
  return !!user && !!$('ioKey')?.value
    && v?.username?.toLowerCase() === user.toLowerCase()
    && v?.host === ioHost();
}

/** The connected username, so callers don't each reach into the DOM for it. */
export function connectedUser() {
  return val('ioUser');
}

/**
 * Commit a validated account.
 *
 * ORDER MATTERS. setFieldValue raises `input`, main.js's listener persists the
 * fields — and clears the stamp, because an ordinary edit to either field is not a
 * verification. So the stamp has to be written after, or it is wiped by its own
 * save.
 *
 * The stamp survives every other write path: saveAccount() and flushActive() both
 * MERGE into env.account, and snapshotAccountFields() only ever produces
 * ACCOUNT_FIELDS keys, so nothing else in devices.js can reach it.
 */
export function saveIoAccount(user, key) {
  setFieldValue('ioUser', user);
  setFieldValue('ioKey', key);
  saveAccount({ ioVerified: { username: user, host: ioHost(), at: Date.now() } });
}

/** Retire the claim. Called when the fields are edited outside A1-C, and when IO
 *  rejects a key that used to work — a revoked key makes the stamp a lie. */
export function clearIoVerified() {
  saveAccount({ ioVerified: null });
}
