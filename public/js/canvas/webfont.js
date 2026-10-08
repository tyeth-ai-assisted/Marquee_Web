/**
 * Web fonts: a font fetched from a URL and drawn by the browser.
 *
 * The font menu offers the three generic families and two bitmap fonts; this is the
 * way past that list. A text that uses a web font stores the family it draws in and the
 * URL it came from (`fontFamily` + `fontUrl` on a label or datetime, `axisFontFamily` +
 * `axisFontUrl` on a chart), so a saved document loads the font again before it draws.
 *
 * Two kinds of URL are accepted:
 *   - a font file (.woff2, .woff, .ttf, .otf), registered with the FontFace API under
 *     a family named after the file;
 *   - a stylesheet of @font-face rules — a Google Fonts css2 link, say — fetched,
 *     added to the page, and used under the family the rules declare.
 * A bare Google Fonts family name ("Press Start 2P") becomes its css2 link.
 *
 * Canvas text needs the face actually loaded (the same gate icons.js keeps for Font
 * Awesome): until it is, the browser draws a substitute and the dither preview would
 * cache that. So callers redraw in whenWebFont() once the load resolves. Loads are
 * remembered per URL for the session, and every font loaded so far is listed for the
 * menu, so a second label can pick the same font without the URL.
 *
 * The parsing helpers at the top are pure, so `node --test` reaches them.
 */

const FONT_FILE = /\.(woff2?|ttf|otf)(?:[?#].*)?$/i;

/** The family a font file is registered under: its file name, without the extension. */
export function webFontName(url) {
  let path;
  try { path = new URL(url).pathname; } catch { path = String(url); }
  const base = decodeURIComponent(path.split('/').pop() || '').replace(/\.[a-z0-9]+$/i, '');
  return base.replace(/[+_]/g, ' ').trim() || 'Web font';
}

/** The distinct font-family names declared by the @font-face rules in `css`. */
export function cssFontFamilies(css) {
  const out = [];
  for (const m of String(css).matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const fam = /font-family\s*:\s*(['"]?)([^;'"]+)\1/.exec(m[1]);
    if (fam && !out.includes(fam[2].trim())) out.push(fam[2].trim());
  }
  return out;
}

/**
 * What the user typed, as the URL to load: a URL as given, or a Google Fonts family
 * name turned into its css2 link. Returns '' for nothing usable.
 */
export function resolveFontSource(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[A-Za-z0-9 ]+$/.test(s)) {
    return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(s).replace(/%20/g, '+')}&display=swap`;
  }
  return '';
}

/** Whether `url` names a font file (as opposed to a stylesheet). */
export function isFontFileUrl(url) {
  try { return FONT_FILE.test(new URL(url).pathname); } catch { return FONT_FILE.test(String(url)); }
}

// ---------- the loader ------------------------------------------------------

/** url -> Promise<{ family, url }>; one load per URL per session. */
const loads = new Map();
/** Every font loaded so far, in load order, for the menu. */
const loaded = [];

/** The fonts loaded this session, as [{ family, url }]. */
export function webFonts() {
  return loaded.slice();
}

/** The family a loaded URL draws in, or null if it has not loaded (yet, or at all). */
export function loadedWebFont(url) {
  return loaded.find((f) => f.url === url)?.family ?? null;
}

async function loadFromFile(url) {
  const family = webFontName(url);
  const face = new FontFace(family, `url(${JSON.stringify(url)})`);
  await face.load();
  document.fonts.add(face);
  return family;
}

async function loadFromStylesheet(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const css = await res.text();
  const families = cssFontFamilies(css);
  if (!families.length) throw new Error('no @font-face rules in that stylesheet');
  const style = document.createElement('style');
  style.dataset.webfont = url;
  style.textContent = css;
  document.head.appendChild(style);
  // Google Fonts splits a family into unicode ranges; loading any text in the family
  // fetches the Latin range, which is what the canvas draws.
  await document.fonts.load(`16px "${families[0]}"`, 'Ag0');
  return families[0];
}

/**
 * Load the font at `url`. Resolves to { family, url } once the browser can draw it;
 * rejects with a message fit for a toast. A URL that failed is tried again next time.
 */
export function loadWebFont(url) {
  if (loads.has(url)) return loads.get(url);
  const p = (async () => {
    if (typeof FontFace === 'undefined' || !document.fonts) throw new Error('this browser has no font loader');
    const family = isFontFileUrl(url) ? await loadFromFile(url) : await loadFromStylesheet(url);
    if (!loaded.some((f) => f.url === url)) loaded.push({ family, url });
    return { family, url };
  })();
  loads.set(url, p);
  p.catch(() => loads.delete(url));
  return p;
}

/**
 * Run `fn` once the font at `url` has loaded. Never rejects: a failed load leaves the
 * browser's substitute, which is visible and reportable, rather than throwing from
 * inside an element's construction.
 */
export function whenWebFont(url, fn) {
  if (!url) return;
  loadWebFont(url).then(fn, (e) => console.warn('[webfont]', url, e));
}

// ---------- the emoji fallback ----------------------------------------------
//
// Every browser font's stack ends in Noto Emoji (pixelfont.js cssFamily), so an emoji
// or symbol the font lacks is drawn as monochrome line art rather than the OS's colour
// bitmap. The font is fetched the first time a text needs it, not at boot: most
// documents never do, and a panel editor should not pay for a font nobody draws with.

const EMOJI_CSS = 'https://fonts.googleapis.com/css2?family=Noto+Emoji&display=swap';
const emojiListeners = new Set();
let emojiLoad = null;

/** Run `fn` each time the emoji font finishes loading. Listens only; never starts a load. */
export function onEmojiFont(fn) {
  emojiListeners.add(fn);
}

/**
 * Make the emoji font drawable for `text`. The stylesheet is fetched once; Google
 * serves the font in unicode-range subsets, so each text then asks for the ranges its
 * own characters need (a no-op once they are in). Resolves true once drawable, or —
 * never rejecting — false when the load failed and the browser's own fallback stays.
 */
export function requestEmojiFont(text = '') {
  if (!emojiLoad) {
    emojiLoad = loadWebFont(EMOJI_CSS).then(() => true, (e) => { console.warn('[webfont] emoji fallback', e); return false; });
  }
  return emojiLoad.then(async (ok) => {
    if (!ok) return false;
    await document.fonts.load(`16px "${loadedWebFont(EMOJI_CSS)}"`, text).catch(() => {});
    emojiListeners.forEach((fn) => fn());
    return true;
  });
}
