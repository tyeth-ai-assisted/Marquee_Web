/**
 * Adafruit IO feed binding.
 *
 * Browser-direct to IO, same host and auth as the publish flows: GET /feeds to
 * list, then GET /feeds/{key}/data/last for a value or /data/chart for a window of
 * history. The picker serves four callers — the toolbox "Text from Adafruit IO Feed"
 * button, which drops a NEW label; an element's "Connect to IO Feed" button, which
 * binds the element already selected; the chart's "Add feed", which APPENDS to a list;
 * and the toolbox "Image from Adafruit IO Feed" button and a picture's inspector, which
 * open it in IMAGE mode: pick a feed holding a picture, or upload one to a new feed.
 */

import { ioHost, ioLog, feedUrl, parseSharedFeed } from '../core/api.js';
import { layer } from '../canvas/stage.js';
import {
  addLabel, rebuildWidget, applyFeedValue, applyTimeValue,
  addFeedImage, imageToFeedImage, setFeedImageSrc, decodeImage, applyFeedImage, clearFeedImage,
  bindFeedImage, feedImageGen,
} from '../canvas/elements.js';
import {
  CHART_RAW_MAX, readsLast, readsImage, readsChart, readsTime, chartWindow, chartCap, chartPoints,
  mergeSeries,
} from '../lib/bindings.js';
import { parseFeedImage, feedImageProblem } from '../lib/feedimage.js';
import { logicalDimsOf } from '../lib/palette.js';
import {
  encodePicture, describePicture, pictureProblem, uploadToNewFeed, publishPicture, feedNameFor,
  turnHistoryOff,
} from './imagefeeds.js';
import { readIoMillis } from './iotime.js';
import { strftime } from '../lib/timefmt.js';
import { display, PALETTES } from '../canvas/palette.js';
import { select } from '../canvas/selection.js';
import {
  $, val, toast, escapeHtml, escapeAttr, openModal, closeModal, wireModal, onModalEscape,
} from '../core/util.js';

let feedsCache = [];

const showingShared = () => !!$('feedSharedToggle')?.checked;

/**
 * Which element the picker is binding to. null = the toolbox flow, which drops a
 * new label on the canvas. A node = bind that existing element instead. Always
 * cleared when the modal closes, so a cancelled bind can't leak into the next
 * open.
 */
let feedPickerTarget = null;

/**
 * 'bind' replaces the target's single binding; 'series' appends to its `feeds`
 * array; 'image' binds a feed image (or drops one when there is no target), refuses a
 * feed whose value is not a picture, and offers an upload to a new feed. Held next to
 * the target because they are one decision — a stale mode with a fresh target would
 * append to a gauge or overwrite a chart.
 */
let feedPickerMode = 'bind';

/**
 * Which pick is the live one. pickFeed() and the upload await network requests before
 * they touch the canvas, and both the mode and the target can change under them: a
 * second click in the list, or the picker closing. Each takes a number on the way in
 * and checks it on the way out; closing the picker takes the next number, so nothing
 * pending can land.
 */
let pickSeq = 0;

/** The picture the image-mode upload panel would send, once encoded. */
let uploadPic = null;

function renderFeedList() {
  const q = ($('feedFilter').value || '').trim().toLowerCase();
  const list = $('feedList');
  const all = feedsCache || [];
  const shown = all.filter((f) =>
    !q || (f.name || '').toLowerCase().includes(q) || (f.key || '').toLowerCase().includes(q));
  // In image mode a feed with history on is marked: it cannot hold a picture until its
  // history is turned off, which picking it offers to do.
  const histNote = (f) => (feedPickerMode === 'image' && f.history
    ? '<span class="mono" style="opacity:.6; margin-left:auto; font-size:11px">history on</span>' : '');
  list.innerHTML = shown.map((f) =>
    `<button type="button" class="btn" data-key="${escapeAttr(f.key)}" data-name="${escapeAttr(f.name || f.key)}"`
    + ` data-history="${f.history ? '1' : ''}"`
    + ' style="justify-content:flex-start; text-align:left; font-family:var(--font-body); letter-spacing:0">'
    + `${escapeHtml(f.name || f.key)}<span class="mono" style="opacity:.6; margin-left:6px; font-size:11px">${escapeHtml(f.key)}</span>${histNote(f)}</button>`
  ).join('');
  $('feedListStatus').textContent = all.length ? `${shown.length} of ${all.length} feed(s)`
    : 'No feeds found';
}

/**
 * Swap the picker between this account's feed list and the shared-feed entry.
 *
 * Shared feeds can't be listed: GET /{user}/sharing, which io.adafruit.com's own
 * Privacy & Sharing page reads, answers an AIO key with 401 "this endpoint requires a
 * user session token". So shared mode is just the URL box — the filter and the list
 * only ever held this account's feeds.
 */
function showSharedMode() {
  const shared = showingShared();
  for (const id of ['feedSharedHelp', 'feedSharedManual']) $(id)?.classList.toggle('hidden', !shared);
  for (const id of ['feedFilter', 'feedList']) $(id)?.classList.toggle('hidden', shared);
  if (shared) {
    $('feedListStatus').textContent = '';
    $('feedSharedKey').focus();
  } else renderFeedList();
}

export async function openFeedPicker(target = null, { mode = 'bind' } = {}) {
  const user = val('ioUser'), key = val('ioKey');
  if (!user || !key) { toast('Connect your Adafruit IO account from the display list'); return; }

  feedPickerTarget = target;
  feedPickerMode = mode;
  pickSeq++;
  showImageMode(target);
  openModal('feedDataModal');
  $('feedFilter').value = '';
  $('feedSharedToggle').checked = false;
  $('feedSharedKey').value = '';
  showSharedMode();
  $('feedList').innerHTML = '';
  $('feedListStatus').textContent = 'Loading feeds…';
  try {
    ioLog('list   ', 'feeds', 'every feed on the account');
    const res = await fetch(`https://${ioHost()}/api/v2/${encodeURIComponent(user)}/feeds`,
      { headers: { 'X-AIO-Key': key } });
    if (!res.ok) {
      $('feedListStatus').textContent = `IO replied ${res.status}`;
      toast(res.status === 401 ? 'IO rejected the key (401) — check credentials' : `IO replied ${res.status}`);
      return;
    }
    feedsCache = await res.json();
    renderFeedList();
  } catch {
    $('feedListStatus').textContent = 'Could not reach Adafruit IO';
    toast(`Could not reach ${ioHost()} — check the network`);
  }
}

export function closeFeedPicker() {
  closeModal('feedDataModal');
  forgetPicker();
}

/** Every way out of the picker ends here, so a pick or upload still in flight cannot land. */
function forgetPicker() {
  feedPickerTarget = null;
  feedPickerMode = 'bind';
  uploadPic = null;
  pickSeq++;
}

// ---------- image mode: upload a picture to a new feed ------------------------

/**
 * Set the picker up for its mode. In image mode it gets its own title and the upload
 * panel above the feed list. A target that is an image from before #36 (its picture
 * embedded in the document) has that picture queued for upload straight away, since
 * moving it onto a feed is why the picker was opened.
 */
function showImageMode(target) {
  const image = feedPickerMode === 'image';
  $('feedDataTitle').textContent = image ? 'Image from Adafruit IO Feed' : 'Select a feed';
  $('feedImageUpload')?.classList.toggle('hidden', !image);
  uploadPic = null;
  $('feedImageFile').value = '';
  $('feedImageName').value = '';
  setUploadStatus('No file chosen');
  if (image && target?.getAttr('etype') === 'image' && target.image()) {
    queueUpload(target.image(), 'Marquee image', 'This picture');
  }
}

function setUploadStatus(text) {
  $('feedImageFileStatus').textContent = text;
  $('feedImageUploadBtn').disabled = !uploadPic;
}

/** Encode a picture for upload and show what would be sent. */
async function queueUpload(source, name, label) {
  const seq = pickSeq;
  uploadPic = null;
  setUploadStatus('Preparing the picture…');
  const pic = await encodePicture(source);
  if (seq !== pickSeq) return;
  if (!pic.ok) { setUploadStatus(pictureProblem(pic.reason)); return; }
  uploadPic = pic;
  if (!$('feedImageName').value.trim()) $('feedImageName').value = name;
  setUploadStatus(`${label}: ${describePicture(pic)}${pic.scaled ? ', shrunk to fit the panel' : ''}`);
}

async function uploadQueued() {
  const pic = uploadPic;
  const name = $('feedImageName').value.trim();
  if (!pic) return;
  if (!name) { $('feedImageName').focus(); setUploadStatus('Name the new feed first'); return; }
  const seq = ++pickSeq;
  const target = feedPickerTarget;
  $('feedImageUploadBtn').disabled = true;
  setUploadStatus(`Creating the feed "${name}" and uploading…`);
  const out = await uploadToNewFeed(name, pic);
  if (seq !== pickSeq) return;
  if (!out.ok) {
    // IO's own words: the feed limit, a name already taken, a value too large.
    setUploadStatus(`Not uploaded: ${out.error}`);
    toast(`Adafruit IO refused the upload: ${out.error}`);
    $('feedImageUploadBtn').disabled = false;
    return;
  }
  const node = placeFeedImage(target, out.feedKey, out.feedName, pic.img, pic.dataUrl);
  closeFeedPicker();
  select(node);
  toast(`Uploaded to the new feed "${out.feedName}": ${describePicture(pic)}`);
}

/**
 * Bind `target` (or a new frame) to a picture feed, with its first picture if there is
 * one. A static image from before #36 becomes a feed image where it stands. A new frame
 * holding a picture takes the picture's shape, fitted inside 80% of the panel the way a
 * placed image always was; an empty one takes the default frame.
 */
function placeFeedImage(target, feedKey, feedName, img, dataUrl) {
  let node = target;
  if (node && node.getAttr('etype') === 'image') node = imageToFeedImage(node);
  if (!node) {
    let size = {};
    if (img) {
      const { w: cw, h: ch } = logicalDimsOf(display);
      const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
      const scale = Math.min(1, (cw * 0.8) / iw, (ch * 0.8) / ih);
      size = { w: Math.max(8, Math.round(iw * scale)), h: Math.max(8, Math.round(ih * scale)) };
    }
    node = addFeedImage(size);
  }
  bindFeedImage(node, feedKey, feedName);
  if (img) applyFeedImage(node, img, dataUrl);
  else clearFeedImage(node);
  rebuildWidget(node);
  return node;
}

/**
 * Replace the picture on the feed a frame is bound to (#23, re-scoped): the frame keeps
 * its place, size and fit, and the feed gets a new value. Asked first, because the feed
 * is not the frame's alone. Every display and project reading it changes too, and a
 * camera publishing to it will overwrite the upload with its next frame.
 */
export async function replaceFeedPicture(node, file) {
  const feedKey = node.getAttr('feedKey');
  const feedName = node.getAttr('feedName') || feedKey;
  if (!feedKey || !file) return;
  const pic = await encodePicture(file);
  if (!pic.ok) { toast(pictureProblem(pic.reason)); return; }
  if (!confirm(`Replace the picture on the Adafruit IO feed "${feedName}" with ${describePicture(pic)}?\n\n`
    + 'Everything that reads this feed shows the new picture, including other displays. '
    + 'To leave the feed as it is, use Change to upload to a new feed instead.')) return;
  const gen = feedImageGen(node);
  const sent = await publishPicture(feedKey, pic.base64);
  if (!sent.ok) {
    toast(sent.status === 403 || sent.status === 401
      ? `"${feedName}" cannot be written with this key. If it is shared with you read-only, upload to a new feed instead`
      : `Adafruit IO refused the picture: ${sent.error}`);
    return;
  }
  if (feedImageGen(node) === gen && node.getLayer()) applyFeedImage(node, pic.img, pic.dataUrl);
  select(node);
  toast(`Replaced the picture on "${feedName}": ${describePicture(pic)}`);
}

/**
 * The newest datum on a feed: `{ status, datum }`, where datum is null unless status is 2xx
 * and IO sent one back. Throws only when IO can't be reached.
 *
 * `/data?limit=1` first, `/data/last` as the fallback. Neither endpoint answers for every
 * feed, and which one fails has moved over time:
 *
 *   - On a feed shared READ-ONLY with this account, and on public feeds under another
 *     owner, IO 404s `/data/last` while the feed record and `/data` both read fine
 *     (checked against a live share on 2026-09-30; a writable share of the same feed
 *     answered `/data/last`). That is why `/data` is asked first.
 *   - `/data` used to answer `[]` for a feed with history OFF, which made `/data/last`
 *     the only read that worked for the bitmap, canvas-state and picture feeds. Checked
 *     again on 2026-10-06 against three history-off feeds: `/data?limit=1` now returns
 *     the current datum on all of them, with the same value and created_at as
 *     `/data/last`, but with a datum `id` minted PER REQUEST, so on such a feed two
 *     reads of one value carry two ids. The fallback stays in case the old behaviour
 *     comes back; nothing reading a history-off feed may rely on its ids.
 */
async function fetchLastDatum(feedKey, key) {
  const headers = { 'X-AIO-Key': key };
  let res = await fetch(feedUrl(feedKey, '/data?limit=1'), { headers });
  if (res.ok) {
    const rows = await res.json().catch(() => null);
    if (Array.isArray(rows) && rows[0]) return { status: res.status, datum: rows[0] };
  }
  // Empty, or refused: the other spelling gets one try before this counts as "no data".
  res = await fetch(feedUrl(feedKey, '/data/last'), { headers });
  if (!res.ok) return { status: res.status, datum: null };
  return { status: res.status, datum: await res.json().catch(() => null) };
}

/**
 * Read one feed's last value. Resolves to a string, or null when the feed is
 * unreadable or empty — callers treat null as "unknown", never as a real value.
 */
export async function readFeedValue(feedKey) {
  const user = val('ioUser'), key = val('ioKey');
  if (!user || !key || !feedKey) return null;
  ioLog('read   ', feedKey, 'last value');
  try {
    const { datum } = await fetchLastDatum(feedKey, key);
    return datum && datum.value != null ? String(datum.value) : null;
  } catch { return null; }
}

/**
 * The newest datum as a POINT — value, id and timestamp — through fetchLastDatum().
 *
 * For feeds with no history. IO only retains data points
 * for feeds with history ON, and history caps a datum at 1 KB — which a panel BMP is
 * twenty times over, so the image feed can never have it. `/data` on such a feed returns
 * an empty array while `/data/last` still returns the current value, and reading only the
 * former is what left "On the panel now" claiming nothing had ever been published to a feed
 * the board was actively drawing from.
 *
 * One datum is all there is in that configuration: enough to say what is on the feed, never
 * enough to say what was on it before.
 */
export async function readFeedLast(feedKey) {
  const user = val('ioUser'), key = val('ioKey');
  if (!user || !key || !feedKey) return null;
  ioLog('read   ', feedKey, 'last datum');
  try {
    const { datum: d } = await fetchLastDatum(feedKey, key);
    if (!d || d.value == null) return null;
    return { id: d.id, value: String(d.value), createdAt: Date.parse(d.created_at) };
  } catch { return null; }
}

/**
 * Read the newest data POINTS of a feed, not just their values.
 *
 * readFeedValue above is enough for an element binding, which only ever asks "what
 * does it say now". A watcher needs more: `id` to tell a repeated value from a
 * repeated event, and `created_at` because IO stamps every datum server-side — the
 * only trustworthy clock in a story where the other participant is a board with no
 * RTC that has been asleep.
 *
 * `limit` above 1 is what makes a late poll recoverable: a backgrounded tab gets its
 * timers throttled hard, and asking for the last few data points reconstructs the
 * transitions that happened while nobody was looking.
 *
 * Newest-first, matching IO's own ordering for /data. Resolves to null on an
 * unreadable feed, keeping readFeedValue's contract: null is "unknown", never a
 * real reading.
 */
export async function readFeedData(feedKey, { limit = 1 } = {}) {
  const user = val('ioUser'), key = val('ioKey');
  if (!user || !key || !feedKey) return null;
  const qs = new URLSearchParams({ limit: String(Math.max(1, limit)) });
  ioLog('read   ', feedKey, `newest ${Math.max(1, limit)} datum(s)`);
  try {
    const res = await fetch(
      feedUrl(feedKey, `/data?${qs}`),
      { headers: { 'X-AIO-Key': key } });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    if (!Array.isArray(body)) return null;
    return body.map((d) => ({
      id: d.id,
      value: d.value == null ? null : String(d.value),
      // Epoch ms, so callers can do arithmetic without re-parsing. NaN on a datum
      // IO didn't stamp, which the callers treat as "no usable time".
      createdAt: Date.parse(d.created_at),
    }));
  } catch { return null; }
}

/**
 * Read a window of history for one feed, for the chart.
 *
 * IO's /data/chart returns a `columns` header naming what each row holds, and the
 * shape DEPENDS ON THE QUERY: raw pulls give ["date","value"], aggregated ones give
 * ["date","min","max","avg"]. So the value column is resolved BY NAME — indexing
 * positionally silently plots minima as if they were readings the moment IO decides
 * a window is large enough to aggregate.
 *
 * Resolves to [{t, v}] or null, matching readFeedValue's contract: null means
 * "unknown", never a real reading.
 */
export async function readFeedHistory(feedKey, { hours = 24, raw = false } = {}) {
  const user = val('ioUser'), key = val('ioKey');
  if (!user || !key || !feedKey) return null;
  const qs = new URLSearchParams({ hours: String(hours) });
  // IO caps a raw pull at 640 points and returns the most recent ones, which is
  // exactly the behaviour the "Raw Data Only" option promises.
  if (raw) { qs.set('raw', 'true'); qs.set('limit', String(CHART_RAW_MAX)); }
  ioLog('read   ', feedKey, `${hours}h history${raw ? ', raw' : ''}`);
  try {
    const res = await fetch(
      feedUrl(feedKey, `/data/chart?${qs}`),
      { headers: { 'X-AIO-Key': key } });
    if (!res.ok) return null;
    // Columns by name, oldest first: see chartPoints() in lib/bindings.js.
    return chartPoints(await res.json().catch(() => null));
  } catch { return null; }
}

// Shared with the server renderer; re-exported for anything that imported it from here.
export { downsample } from '../lib/bindings.js';

/**
 * Every element with a live binding, split by HOW it is read: `targets` take a last
 * value, `charts` take a window, `datetimes` take the current time from IO's Time API,
 * `images` take a last value too but have to DECODE it before it can show.
 *
 * Exported because the question has a second asker. refreshFeedElements() below answers
 * "which of these do I re-read"; device.js's live take asks "is there anything here a feed
 * could change at all", before deciding whether a background refresh is worth an Adafruit
 * IO request. Those are one derivation, and a second spelling of it is how a newly added
 * widget type ends up refreshing on a push and never on the cycle.
 */
export function feedBoundElements(nodes) {
  const all = nodes || layer.find('.element');
  // The same predicates feedReads() applies to a saved document, so the editor and a
  // server render agree on what is bound.
  return {
    targets: all.filter((n) => readsLast(n.getAttrs())),
    charts: all.filter((n) => readsChart(n.getAttrs())),
    // Always live: a datetime has no binding to be missing, the time is its content.
    datetimes: all.filter((n) => readsTime(n.getAttrs())),
    images: all.filter((n) => readsImage(n.getAttrs())),
  };
}

/**
 * Re-read one feed image. The same best-effort contract as every other binding: an
 * unreadable feed, or a picture the browser cannot decode, LEAVES THE PREVIOUS PICTURE
 * IN PLACE and returns false. A feed that answers with nothing, or with a value that is
 * not a picture, shows the "no picture" placeholder instead (#24): the read worked, and
 * that is what is on the feed. A value identical to the one showing is not decoded
 * again, so a camera feed with no new frame costs one GET per cycle and nothing more.
 */
export async function refreshFeedImage(n) {
  // The binding as it was when the read went out. A frame rebound while the request was
  // in flight must not take the answer: the generation covers the read here and the
  // decode inside setFeedImageSrc.
  const feedKey = n.getAttr('feedKey');
  const gen = feedImageGen(n);
  const user = val('ioUser'), key = val('ioKey');
  if (!user || !key || !feedKey) return false;
  ioLog('read   ', feedKey, 'picture');
  let read;
  try { read = await fetchLastDatum(feedKey, key); } catch { return false; }
  if (feedImageGen(n) !== gen || n.getAttr('feedKey') !== feedKey) return false;
  const { status, datum } = read;
  if (!(status >= 200 && status < 300) && status !== 404) return false;
  const parsed = parseFeedImage(datum?.value);
  if (!parsed.ok) {
    if (parsed.reason !== 'empty') console.warn(`[io] ${feedKey}: ${feedImageProblem(parsed.reason)}`);
    clearFeedImage(n);
    return true;
  }
  if (parsed.dataUrl === n.getAttr('src') && n.getAttr('imageObj')) return true;
  const ok = await setFeedImageSrc(n, parsed.dataUrl);
  if (!ok) console.warn(`[io] ${feedKey}: the picture could not be decoded, or the frame was rebound meanwhile; keeping the previous one`);
  return ok;
}

/**
 * Every datetime renders from ONE reading of IO's clock — one request however many there
 * are, and every one of them showing the same instant.
 */
async function refreshDatetimes(datetimes) {
  const ms = await readIoMillis();
  if (ms === null) return false;
  let ok = true;
  for (const n of datetimes) {
    const v = strftime(ms, n.getAttr('timeFmt'), n.getAttr('timeTz') || '');
    // An unknown zone (a doc from a browser with a newer tz table) keeps its last text.
    if (v === null) { ok = false; continue; }
    applyTimeValue(n, v);
  }
  return ok;
}

/** Is there anything on this canvas that a feed could change? */
export function hasFeedBindings() {
  const { targets, charts, datetimes, images } = feedBoundElements();
  return !!(targets.length || charts.length || datetimes.length || images.length);
}

/**
 * The Adafruit IO cost of one refresh, in requests: one per bound single-value element,
 * one per series on every chart. device.js logs it beside each live take, because "is this
 * feature eating my rate limit" is a question the console should be able to answer without
 * anyone counting widgets by hand.
 */
export function feedReadCost() {
  const { targets, charts, datetimes, images } = feedBoundElements();
  return targets.length + images.length
    + charts.reduce((n, c) => n + (c.getAttr('feeds') || []).length, 0)
    + (datetimes.length ? 1 : 0);
}

/**
 * Re-read every feed-bound element (or just the ones passed in) and rebuild
 * them. Best-effort by design: a failed read LEAVES THE PREVIOUS VALUE rather
 * than blanking the element, so one flaky request can't turn a panel off.
 * Returns true when every attempted read succeeded.
 *
 * Charts are handled alongside the single-value elements but through their own
 * request, because they need a window rather than a last value.
 */
export async function refreshFeedElements(nodes) {
  const { targets, charts, datetimes, images } = feedBoundElements(nodes);
  if (!targets.length && !charts.length && !datetimes.length && !images.length) return true;
  const results = await Promise.all([
    ...images.map((n) => refreshFeedImage(n)),
    ...targets.map(async (n) => {
      const v = await readFeedValue(n.getAttr('feedKey'));
      if (v === null) return false;
      // applyFeedValue, not setAttr + rebuildWidget: a label is a plain Konva.Text
      // with no children to rebuild, so the widget-only path would throw on it.
      applyFeedValue(n, v);
      return true;
    }),
    ...charts.map((n) => refreshChart(n)),
    // Same best-effort rule: a failed time read keeps the text the element already had.
    ...(datetimes.length ? [refreshDatetimes(datetimes)] : []),
  ]);
  return results.every(Boolean);
}

/**
 * Refetch every series on one chart. Per-feed failures are tolerated the same way
 * single values are — a feed that doesn't answer keeps the points it already had, so
 * one dead feed doesn't wipe the other lines off the plot.
 */
export async function refreshChart(g) {
  const feeds = g.getAttr('feeds') || [];
  // Unbinding the last feed still has to land: drop the cached series and redraw,
  // or the chart keeps plotting a feed it is no longer connected to.
  if (!feeds.length) {
    g.setAttr('series', {});
    rebuildWidget(g);
    return true;
  }
  const { hours, raw } = chartWindow(g.getAttrs());
  const fetched = {};
  const oks = await Promise.all(feeds.map(async (f) => {
    const pts = await readFeedHistory(f.key, { hours, raw });
    if (pts === null) return false;
    fetched[f.key] = pts;
    return true;
  }));
  g.setAttr('series', mergeSeries(g.getAttr('series'), feeds, fetched, chartCap(g.getAttrs())));
  rebuildWidget(g);
  return oks.every(Boolean);
}

export function initFeeds() {
  wireModal('feedDataModal', ['feedDataClose']);
  // The shared Escape handler closes the modal; clearing the pending target is
  // this picker's own business.
  onModalEscape('feedDataModal', forgetPicker);
  $('feedDataModal')?.addEventListener('click', (e) => {
    if (e.target === $('feedDataModal')) forgetPicker();
  });
  $('feedDataClose')?.addEventListener('click', forgetPicker);

  $('addFeedData')?.addEventListener('click', () => openFeedPicker(null));
  // A picture, from a feed or uploaded to a new one. The picker is the whole flow.
  $('addFeedImageBtn')?.addEventListener('click', () => openFeedPicker(null, { mode: 'image' }));
  $('feedImageChoose')?.addEventListener('click', () => $('feedImageFile').click());
  $('feedImageFile')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) queueUpload(file, feedNameFor(file), file.name);
  });
  $('feedImageUploadBtn')?.addEventListener('click', uploadQueued);
  $('feedImageName')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); uploadQueued(); }
  });
  $('feedFilter')?.addEventListener('input', renderFeedList);

  $('feedSharedToggle')?.addEventListener('change', showSharedMode);

  $('feedList')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-key]');
    if (btn) pickFeed(btn.dataset.key, btn.dataset.name || btn.dataset.key, { history: !!btn.dataset.history });
  });

  // A shared feed, pasted in — the only way in, since shared feeds can't be listed.
  // The feed record is fetched first: it is the one request that tells "not shared
  // with you" apart from "empty", and it carries the name the owner gave the feed.
  const useManual = async () => {
    const feedKey = parseSharedFeed($('feedSharedKey').value);
    if (!feedKey) {
      $('feedListStatus').textContent = 'Expected owner/feeds/key, or the feed\'s URL';
      return;
    }
    $('feedListStatus').textContent = 'Looking up feed…';
    ioLog('read   ', feedKey, 'feed record (shared feed entry)');
    try {
      const res = await fetch(feedUrl(feedKey), { headers: { 'X-AIO-Key': val('ioKey') } });
      if (!res.ok) {
        $('feedListStatus').textContent = res.status === 404
          ? 'Not found — or not shared with this account' : `IO replied ${res.status}`;
        return;
      }
      const feed = await res.json().catch(() => ({}));
      pickFeed(feedKey, feed.name || feedKey, { history: !!feed.history });
    } catch {
      $('feedListStatus').textContent = 'Could not reach Adafruit IO';
    }
  };
  $('feedSharedUse')?.addEventListener('click', useManual);
  $('feedSharedKey')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); useManual(); }
  });
}

/**
 * Bind the chosen feed to whatever the picker was opened for. One path for a list
 * click and a typed-in shared feed, so they can't drift apart.
 */
async function pickFeed(feedKey, feedName, { history = false } = {}) {
  const key = val('ioKey');
  // This pick's view of the picker, taken before anything is awaited. The module-level
  // mode and target belong to whichever pick is CURRENT, and a second click or a close
  // can replace them while this one's read is still in flight; a pick that comes back to
  // find its number gone leaves the canvas alone.
  const seq = ++pickSeq;
  const mode = feedPickerMode;
  const target = feedPickerTarget;
  const stale = () => seq !== pickSeq;

  // A chart series is a history pull, not a last value, and an empty feed is
  // still a legitimate series to add — so this mode returns before the
  // last-value fetch below, which treats "no value" as a failure.
  if (mode === 'series' && target) {
    const node = target;
    const feeds = (node.getAttr('feeds') || []).map((f) => ({ ...f }));
    if (feeds.some((f) => f.key === feedKey)) {
      toast(`"${feedName}" is already on this chart`);
      return;
    }
    $('feedListStatus').textContent = 'Loading history…';
    feeds.push({
      key: feedKey,
      name: feedName,
      // Each series gets the next palette ink, so two feeds differ by colour as
      // well as by dash the moment the second one is added.
      color: PALETTES[display.type][feeds.length % PALETTES[display.type].length],
    });
    node.setAttr('feeds', feeds);
    const ok = await refreshChart(node);
    if (!stale()) closeFeedPicker();
    select(node);
    toast(ok ? `Added ${feedName} to the chart`
             : `Added ${feedName}, but its history could not be read`);
    return;
  }

  $('feedListStatus').textContent = 'Loading value…';
  ioLog('read   ', feedKey, 'last value (feed picker)');
  try {
    const { status, datum } = await fetchLastDatum(feedKey, key);
    if (stale()) return;
    if (mode === 'image') {
      await pickImageFeed({ feedKey, feedName, history, status, datum, target, stale });
      return;
    }
    if (status < 200 || status >= 300) {
      const msg = status === 404 ? `"${feedName}" has no data yet` : `IO replied ${status}`;
      $('feedListStatus').textContent = msg;
      toast(msg);
      return;
    }
    const value = datum && datum.value != null ? String(datum.value) : '';
    if (value === '') { toast(`"${feedName}" has no value`); return; }

    if (target) {
      const node = target;
      node.setAttr('feedKey', feedKey);
      node.setAttr('feedName', feedName);
      applyFeedValue(node, value);
      closeFeedPicker();
      select(node);          // re-render the inspector with the new binding
      toast(`Bound ${feedName} = ${value}`);
      return;
    }

    // The toolbox shortcut. It drops a genuinely LINKED label — it used to bake
    // "name: value" into the text once and never read the feed again, which looked
    // like a binding and behaved like a screenshot. The feed name becomes the
    // prefix so the caption survives, but the number now refreshes.
    const node = addLabel({
      feedKey, feedName, feedPrefix: `${feedName}: `, feedValue: value,
    });
    closeFeedPicker();
    select(node);
    toast(`Added ${feedName} = ${value}`);
  } catch {
    if (stale()) return;
    $('feedListStatus').textContent = 'Could not reach Adafruit IO';
    toast(`Could not reach ${ioHost()} — check the network`);
  }
}

/**
 * The image-mode half of pickFeed(). Unlike the bindings above, an EMPTY feed is a
 * legitimate thing to bind (the camera has not taken its first frame yet), but a feed
 * that holds a temperature is refused outright, since nothing that could arrive on it
 * would be a picture. A feed with history on can never hold one (1 KB per value), so
 * the user is offered to turn its history off, and it is refused if they decline.
 * Everything is checked, and the picture DECODED, before anything on the canvas
 * changes: a refused or undecodable feed leaves a static image static and an existing
 * binding as it was.
 */
async function pickImageFeed({ feedKey, feedName, history, status, datum, target, stale }) {
  const say = (msg) => { $('feedListStatus').textContent = msg; toast(msg); };
  // 404 is "no data yet" (fetchLastDatum tried both spellings); anything else that is
  // not a success is a failed read, not an empty feed.
  if (!(status >= 200 && status < 300) && status !== 404) {
    say(status === 401 ? 'IO rejected the key (401) — check credentials' : `IO replied ${status}`);
    return;
  }
  const parsed = parseFeedImage(datum?.value);
  if (!parsed.ok && parsed.reason !== 'empty') { say(feedImageProblem(parsed.reason, `"${feedName}"`)); return; }
  if (history) {
    if (!confirm(`"${feedName}" keeps a history, which limits each value to 1 KB. That is too small for a picture.\n\n`
      + 'Turn its history off? Adafruit IO then keeps only its latest value, for everything that reads this feed.')) {
      say(`"${feedName}" was not used: a feed for a picture needs its history off`);
      return;
    }
    const off = await turnHistoryOff(feedKey);
    if (stale()) return;
    if (!off.ok) { say(`Could not turn off the history of "${feedName}": ${off.error}`); return; }
  }
  let img = null;
  if (parsed.ok) {
    $('feedListStatus').textContent = 'Decoding the picture…';
    img = await decodeImage(parsed.dataUrl);
    if (stale()) return;
    if (!img) { say(`"${feedName}" holds a picture this browser could not decode`); return; }
  }
  const node = placeFeedImage(target, feedKey, feedName, img, parsed.ok ? parsed.dataUrl : null);
  closeFeedPicker();
  select(node);
  toast(img ? `Bound ${feedName}: ${img.width}×${img.height} picture`
            : `Bound ${feedName}: no picture on it yet`);
}
