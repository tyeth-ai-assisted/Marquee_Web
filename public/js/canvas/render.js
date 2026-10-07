/**
 * The render pipeline.
 *
 * The editor captures the canvas at exactly 1:1, with each picture already dithered on
 * its own (imagedither.js), and palette-remaps it right here, in the browser, with
 * bitmap.js — a pure-JS port of the ImageMagick pipeline this app used to shell out to,
 * byte-identical to what `magick` produced (see test/bitmap.test.js). There is no
 * server: the same bytes go to the preview, the export and the panel.
 */

import { ioHost, ioLog, bitmapFeedKey, IO_MAX_NO_HISTORY } from '../core/api.js';
import { display, logicalDims, ditherLabel, PALETTES } from './palette.js';
import { renderIndexedBmp } from './bitmap.js';
import { captureClean } from './stage.js';
import { selected, select } from './selection.js';
import { refreshFeedElements } from '../device/feeds.js';
import {
  $, val, toast, fmtBytes, base64ToBlob, download, openModal, closeModal, wireModal,
} from '../core/util.js';

// ---------- the authoritative render ----------------------------------------

function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/**
 * Render the clean 1:1 capture with the current display settings.
 *
 * Returns { bmp, png, bmpBytes, base64Bytes, fitsNoHistory, fitsHistory } — `bmp` is
 * the base64 indexed BMP3 that ships to the panel, `png` a base64 PNG of the very
 * same pixels for on-screen use. This is the shape the old /render endpoint
 * answered with, kept so its callers did not have to change.
 *
 * Deselecting for the capture is done here rather than inside captureClean so
 * stage.js doesn't have to know selection exists. A dither refresh shouldn't
 * cost you your active element, so the selection is put straight back.
 */
export function renderBitmap() {
  const prev = selected;
  const canvas = captureClean({
    onDeselect: () => select(null),
    onReselect: () => { if (prev) select(prev); },
    ditherImages: true,
  });
  const w = canvas.width, h = canvas.height;
  const rgba = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  // Nearest colour, never a dither: the pictures arrive already dithered (imagedither.js)
  // and come through unchanged, and text, lines and shapes stay crisp instead of picking
  // up the error a diffusion pass spreads from every anti-aliased edge.
  const { bmp, indices, colormap } = renderIndexedBmp(rgba, w, h, PALETTES[display.type], { method: 'none' });

  // Preview: the indexed pixels painted back out as truecolor.
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < indices.length; i++) {
    const c = colormap[indices[i]], o = i * 4;
    img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  const b64 = bytesToBase64(bmp);
  return {
    bmp: b64,
    png: out.toDataURL('image/png').split(',')[1],
    bmpBytes: bmp.length,
    base64Bytes: b64.length,
    fitsNoHistory: b64.length <= IO_MAX_NO_HISTORY,
    fitsHistory: b64.length <= 1024,
  };
}

/**
 * Render, or report why not. Wraps the toast so the six callers that need a BMP
 * don't each repeat it. Returns null on failure. Still async so callers that await
 * it keep working; the render itself is synchronous and takes a few milliseconds.
 */
export async function renderOrReport(what) {
  try {
    return renderBitmap();
  } catch (e) {
    console.error('[render]', e);
    toast(`Render failed — cannot ${what}`);
    return null;
  }
}

/**
 * IO rejects a datum over its per-feed ceiling. Checking here rather than at
 * each call site means the message names the actual number every time.
 */
export function tooLargeForIO(b64) {
  if (b64.length <= IO_MAX_NO_HISTORY) return false;
  toast(`Base64 BMP is ${fmtBytes(b64.length)} — over IO's ${fmtBytes(IO_MAX_NO_HISTORY)} ceiling. Shrink the panel or use fewer colours.`);
  return true;
}

/**
 * POST one datum to an Adafruit IO feed, browser-direct.
 *
 * The feed defaults to the image feed. It is a parameter because a push writes two
 * of them — the dashboard and the sleep window — and failures name the feed, so
 * "which of the two POSTs went wrong" is answerable from the toast alone.
 *
 * `quiet` is for the one publish nobody asked for: canvasfeed.js mirrors the scene on
 * a timer behind the user's typing, and a toast per attempt would turn one wrong feed
 * key into a wall of them. It suppresses the TOAST only — the return value and the
 * `[io]` log line are identical either way, and the caller still has to decide what a
 * failure means.
 */
export async function publishToIO(value, feed = bitmapFeedKey(), { quiet = false } = {}) {
  const say = (msg) => { if (!quiet) toast(msg); };
  const user = val('ioUser'), key = val('ioKey');
  if (!user || !key || !feed) {
    say('An Adafruit IO account and a group key are both required — connect the account from the display list, and add the display so its group gets set up');
    return { ok: false, error: 'missing credentials' };
  }
  const host = ioHost();
  ioLog('publish', feed, `${value.length} B`);
  try {
    const res = await fetch(
      `https://${host}/api/v2/${encodeURIComponent(user)}/feeds/${encodeURIComponent(feed)}/data`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AIO-Key': key },
        body: JSON.stringify({ value }),
      });
    if (res.ok) return { ok: true, host, feed };
    if (res.status === 422 || res.status === 413) {
      say(`IO rejected the datum for "${feed}" (${res.status}) — likely too large for this feed's history setting`);
    } else {
      say(`IO replied ${res.status} for feed "${feed}" — check credentials and that the feed exists`);
    }
    // `status` rides along for the one caller that acts on it rather than reporting it:
    // canvasfeed.js reads a 404 as "this display predates the canvas-state feed" and
    // creates it, rather than as a failure worth telling anyone about.
    return { ok: false, error: `IO ${res.status}`, status: res.status, feed };
  } catch {
    say(`Could not reach ${host} — check the network`);
    return { ok: false, error: 'network', status: 0, feed };
  }
}

// ---------- export ----------------------------------------------------------

export async function exportBMP() {
  const { w, h } = logicalDims();
  await refreshFeedElements();   // feed-bound elements reflect current state, not stale
  const r = await renderOrReport('export a BMP');
  if (!r) return;
  const blob = base64ToBlob(r.bmp, 'image/bmp');
  download(blob, `export_${w}x${h}.bmp`);
  const projectedB64 = Math.ceil(blob.size / 3) * 4;
  if (projectedB64 > IO_MAX_NO_HISTORY) {
    toast(`Exported ${fmtBytes(blob.size)} BMP — too large to publish to IO (~${fmtBytes(projectedB64)} base64). Fine as a local file.`);
  } else {
    toast(`BMP3 exported: ${w}×${h}, ${display.type} · ${fmtBytes(blob.size)}`);
  }
}

// ---------- boot ------------------------------------------------------------

export function initRender() {
  $('btnExport')?.addEventListener('click', exportBMP);

  // Render preview modal.
  wireModal('previewModal', ['previewClose']);
  $('btnRender')?.addEventListener('click', async () => {
    const { w, h } = logicalDims();
    const imgEl = $('previewImg');
    const scale = Math.max(1, Math.min(3, Math.floor(440 / w)));
    imgEl.style.width = (w * scale) + 'px';
    await refreshFeedElements();
    const r = await renderOrReport('render a preview');
    if (!r) return;
    imgEl.src = 'data:image/png;base64,' + r.png;
    $('previewMeta').textContent =
      `${w} × ${h} px · ${display.type} · ${ditherLabel()} · shown at ${scale}× · BMP ${fmtBytes(r.bmpBytes)}`;
    openModal('previewModal');
  });
  $('previewExport')?.addEventListener('click', () => {
    closeModal('previewModal');
    exportBMP();
  });

  // Publish modal.
  wireModal('publishModal', ['publishClose']);
  $('btnPublish')?.addEventListener('click', () => {
    openModal('publishModal');
    updatePublishEstimate();
  });
  $('ioGroup')?.addEventListener('input', renderPublishDebug);

  $('publishSend')?.addEventListener('click', async () => {
    const btn = $('publishSend');
    btn.disabled = true;
    btn.textContent = 'Publishing…';
    try {
      await refreshFeedElements();
      const r = await renderOrReport('publish');
      if (!r) return;
      if (tooLargeForIO(r.bmp)) return;
      const out = await publishToIO(r.bmp);
      if (out.ok) {
        closeModal('publishModal');
        toast(`Published ${fmtBytes(r.bmp.length)} base64 BMP to "${bitmapFeedKey()}" on ${out.host}`);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Publish';
    }
  });
}

/** Live status next to Publish, so the size against the limit isn't a surprise. */
async function updatePublishEstimate() {
  const dbg = $('publishDebug');
  if (!dbg) return;
  let bytes;
  try {
    bytes = renderBitmap().base64Bytes;   // authoritative size: the real bytes
  } catch (e) {
    console.error('[render]', e);
    delete dbg.dataset.size;
    dbg.className = 'hint mono size-bad';
    dbg.textContent = 'Render failed — cannot estimate size';
    return;
  }
  dbg.className = 'hint mono size-' + (bytes <= IO_MAX_NO_HISTORY ? 'ok' : 'bad');
  dbg.dataset.size = fmtBytes(bytes);
  renderPublishDebug();
}

/** Compose the debug line from the cached size + current feed key + host. */
function renderPublishDebug() {
  const dbg = $('publishDebug');
  if (!dbg || !dbg.dataset.size) return;
  const feed = bitmapFeedKey();
  dbg.textContent = `Publishing a base64-encoded BMP = ${dbg.dataset.size}`
    + (feed ? ` to feed ${feed}` : '')
    + ` on ${ioHost()}`;
}
