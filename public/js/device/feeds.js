/**
 * Adafruit IO feed binding.
 *
 * Browser-direct to IO, same host and auth as the publish flows: GET /feeds to
 * list, then GET /feeds/{key}/data/last for a value or /data/chart for a window of
 * history. The picker serves three callers — the toolbox "Feed value" button, which
 * drops a NEW label; an element's "Connect to IO Feed" button, which binds the
 * element already selected; and the chart's "Add feed", which APPENDS to a list.
 */

import { ioHost, ioLog, feedUrl, parseSharedFeed } from '../core/api.js';
import { layer } from '../canvas/stage.js';
import {
  addLabel, addFeedImage, imageToFeedImage, setFeedImageSrc, decodeImage, applyFeedImage,
  bindFeedImage, feedImageGen, rebuildWidget, applyFeedValue, applyTimeValue, FEED_ETYPES,
  CHART_RAW_MAX,
} from '../canvas/elements.js';
import { parseFeedImage, feedImageProblem } from '../core/feedimage.js';
import { readIoMillis } from './iotime.js';
import { strftime } from '../core/timefmt.js';
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
 * array; 'image' binds a feed image (or drops one when there is no target), and
 * refuses a feed whose value is not a picture. Held next to the target because they
 * are one decision — a stale mode with a fresh target would append to a gauge or
 * overwrite a chart.
 */
let feedPickerMode = 'bind';

function renderFeedList() {
  const q = ($('feedFilter').value || '').trim().toLowerCase();
  const list = $('feedList');
  const all = feedsCache || [];
  const shown = all.filter((f) =>
    !q || (f.name || '').toLowerCase().includes(q) || (f.key || '').toLowerCase().includes(q));
  list.innerHTML = shown.map((f) =>
    `<button type="button" class="btn" data-key="${escapeAttr(f.key)}" data-name="${escapeAttr(f.name || f.key)}"`
    + ' style="justify-content:flex-start; text-align:left; font-family:var(--font-body); letter-spacing:0">'
    + `${escapeHtml(f.name || f.key)}<span class="mono" style="opacity:.6; margin-left:6px; font-size:11px">${escapeHtml(f.key)}</span></button>`
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

/**
 * Which pick is the live one. pickFeed() awaits a network read before it touches the
 * canvas, and both the mode and the target can change under it — a second click in the
 * list, or the picker closing. Each pick takes a number on the way in and checks it on
 * the way out; closing the picker takes the next number, so nothing pending can land.
 */
let pickSeq = 0;

export function closeFeedPicker() {
  closeModal('feedDataModal');
  feedPickerTarget = null;
  feedPickerMode = 'bind';
  pickSeq++;
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
 *     the only read that worked for the bitmap, canvas-state and image feeds. Checked
 *     again on 2026-10-06 against three history-off feeds: `/data?limit=1` now returns
 *     the current datum on all of them, with the same value and created_at as
 *     `/data/last` — but with a datum `id` minted PER REQUEST, so on such a feed two
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
 * Exists for feeds with no history. IO only retains data points for feeds with history
 * ON, and history caps a datum at 1 KB — which a panel BMP is twenty times over, so the
 * image feed can never have it. Reading such a feed through readFeedData() (a plain
 * `/data` listing) once returned an empty array while the current value sat there
 * unread, which is what left "On the panel now" claiming nothing had ever been published
 * to a feed the board was actively drawing from. fetchLastDatum() tries both spellings.
 *
 * One datum is all there is in that configuration: enough to say what is on the feed, never
 * enough to say what was on it before. And see the note on ids in fetchLastDatum — on a
 * history-off feed the `id` here is not stable across reads.
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
    const body = await res.json().catch(() => null);
    if (!body || !Array.isArray(body.data)) return null;
    const cols = body.columns || ['date', 'value'];
    const ti = cols.indexOf('date');
    // 'avg' is the aggregate that represents the window; 'value' is the raw case.
    const vi = ['value', 'avg', 'max', 'min'].map((c) => cols.indexOf(c)).find((i) => i >= 0);
    if (vi === undefined || vi < 0) return null;
    return body.data
      .map((row) => ({ t: ti >= 0 ? row[ti] : null, v: Number(row[vi]) }))
      .filter((p) => Number.isFinite(p.v))
      // Sorted oldest-first, explicitly. The chart joins points in array order, so
      // a descending response would draw the window backwards.
      // /data/chart ascends today; /data descends, and that is one query away.
      .sort((a, b) => (Date.parse(a.t) || 0) - (Date.parse(b.t) || 0));
  } catch { return null; }
}

/**
 * Thin a series to at most `max` points, keeping the FIRST and LAST so the window's
 * endpoints stay exact.
 *
 * Charts are 120-300px wide, so anything denser than that draws multiple samples
 * into one column — and canvas.json is the wire format to the device, so the
 * invisible points cost bytes for nothing.
 */
export function downsample(points, max) {
  if (!Array.isArray(points) || points.length <= max || max < 2) return points || [];
  const out = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

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
  return {
    targets: all.filter((n) => FEED_ETYPES.includes(n.getAttr('etype')) && n.getAttr('feedKey')),
    charts: all.filter((n) => n.getAttr('etype') === 'linechart' && (n.getAttr('feeds') || []).length),
    // Always live: a datetime has no binding to be missing, the time is its content.
    datetimes: all.filter((n) => n.getAttr('etype') === 'datetime'),
    images: all.filter((n) => n.getAttr('etype') === 'feedimage' && n.getAttr('feedKey')),
  };
}

/**
 * Re-read one feed image. The same best-effort contract as every other binding — an
 * unreadable feed, a value that is not a picture, or a picture the browser cannot decode
 * all LEAVE THE PREVIOUS PICTURE IN PLACE and return false — plus one economy: a value
 * identical to the one already showing is not decoded again. A camera feed that has not
 * taken a new frame costs one GET per cycle and nothing more.
 */
export async function refreshFeedImage(n) {
  // The binding as it was when the read went out. A frame rebound (or unlinked) while
  // the request was in flight must not take the answer: the generation covers the read
  // here and the decode inside setFeedImageSrc.
  const key = n.getAttr('feedKey');
  const gen = feedImageGen(n);
  const v = await readFeedValue(key);
  if (feedImageGen(n) !== gen || n.getAttr('feedKey') !== key) return false;
  if (v === null) return false;
  const parsed = parseFeedImage(v);
  if (!parsed.ok) {
    console.warn(`[io] ${key}: ${feedImageProblem(parsed.reason)}`);
    return false;
  }
  if (parsed.dataUrl === n.getAttr('src') && n.getAttr('imageObj')) return true;
  const ok = await setFeedImageSrc(n, parsed.dataUrl);
  if (!ok) console.warn(`[io] ${key}: the picture could not be decoded, or the frame was rebound meanwhile — keeping the previous one`);
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
  const hours = g.getAttr('hours') ?? 24;
  const raw = !!g.getAttr('rawOnly');
  const cap = Math.max(2, Math.round(g.getAttr('w') || 120));
  const series = { ...(g.getAttr('series') || {}) };
  const oks = await Promise.all(feeds.map(async (f) => {
    const pts = await readFeedHistory(f.key, { hours, raw });
    if (pts === null) return false;
    series[f.key] = downsample(pts, cap).map((p) => ({ t: p.t, v: p.v }));
    return true;
  }));
  // Drop cached series for feeds that are no longer bound, or an unbound-then-
  // rebound feed would silently resurrect stale points.
  const live = new Set(feeds.map((f) => f.key));
  Object.keys(series).forEach((k) => { if (!live.has(k)) delete series[k]; });
  g.setAttr('series', series);
  rebuildWidget(g);
  return oks.every(Boolean);
}

export function initFeeds() {
  wireModal('feedDataModal', ['feedDataClose']);
  // The shared Escape handler closes the modal; clearing the pending target is
  // this picker's own business.
  onModalEscape('feedDataModal', () => { feedPickerTarget = null; pickSeq++; });
  $('feedDataModal')?.addEventListener('click', (e) => {
    if (e.target === $('feedDataModal')) { feedPickerTarget = null; pickSeq++; }
  });
  $('feedDataClose')?.addEventListener('click', () => { feedPickerTarget = null; pickSeq++; });

  $('addFeedData')?.addEventListener('click', () => openFeedPicker(null));
  $('feedFilter')?.addEventListener('input', renderFeedList);

  $('feedSharedToggle')?.addEventListener('change', showSharedMode);

  $('feedList')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-key]');
    if (btn) pickFeed(btn.dataset.key, btn.dataset.name || btn.dataset.key);
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
      pickFeed(feedKey, feed.name || feedKey);
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
async function pickFeed(feedKey, feedName) {
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
  // /data/last fetch below, which treats "no value" as a failure.
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

    // A feed image. Unlike the bindings below, an EMPTY feed is a legitimate thing to
    // bind — the camera has not taken its first frame yet — but a feed that holds a
    // temperature is refused outright, since nothing that could ever arrive on it
    // would be a picture. Everything is checked, and the picture DECODED, before
    // anything on the canvas changes: a refused or undecodable feed leaves a static
    // image static and an existing binding as it was.
    if (mode === 'image') {
      const ok2xx = status >= 200 && status < 300;
      // 404 is "no data yet" (fetchLastDatum tried both spellings); anything else that
      // is not a success is a failed read, not an empty feed.
      if (!ok2xx && status !== 404) {
        const msg = status === 401 ? 'IO rejected the key (401) — check credentials' : `IO replied ${status}`;
        $('feedListStatus').textContent = msg;
        toast(msg);
        return;
      }
      const empty = status === 404 || !datum || datum.value == null || String(datum.value).trim() === '';
      const parsed = empty ? null : parseFeedImage(datum.value);
      if (parsed && !parsed.ok) {
        const msg = feedImageProblem(parsed.reason, `"${feedName}"`);
        $('feedListStatus').textContent = msg;
        toast(msg);
        return;
      }
      let img = null;
      if (parsed) {
        $('feedListStatus').textContent = 'Decoding image…';
        img = await decodeImage(parsed.dataUrl);
        if (stale()) return;
        if (!img) {
          const msg = `"${feedName}" holds a picture this browser could not decode`;
          $('feedListStatus').textContent = msg;
          toast(msg);
          return;
        }
      }
      let node = target;
      // "Connect to IO Feed" on a static image: it becomes a feed image where it stands.
      if (node && node.getAttr('etype') === 'image') node = imageToFeedImage(node);
      if (!node) node = addFeedImage();
      bindFeedImage(node, feedKey, feedName);
      if (img) applyFeedImage(node, img, parsed.dataUrl);
      else rebuildWidget(node);                              // the empty frame now says so
      closeFeedPicker();
      select(node);
      toast(img ? `Bound ${feedName} — ${img.width}×${img.height} image`
                : `Bound ${feedName} — no image on it yet`);
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
