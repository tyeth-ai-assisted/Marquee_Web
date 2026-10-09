/** Public photostream page data; parse JSON only, never run Flickr scripts. */
import { MIN_IMAGE_EDGE, MAX_ITEMS, publicURL } from "./discovery.js";

export function flickrSource(value) {
  const u = publicURL(value);
  if (!["www.flickr.com", "flickr.com", "m.flickr.com"].includes(u.hostname))
    return null;
  const match = /^\/photos\/([^/]+)(?:\/(?:albums|sets)\/(\d+))?\/?$/.exec(
    u.pathname,
  );
  return match ? { user: match[1], album: match[2] || null } : null;
}

function exportedModel(html) {
  let attempts = 0;
  for (const match of html.matchAll(/\bmodelExport\s*:\s*(\{)/g)) {
    if (++attempts > 4) break;
    const start = match.index + match[0].length - 1;
    let depth = 0,
      quoted = false,
      escaped = false;
    for (let i = start; i < html.length; i++) {
      const ch = html[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === "{" || ch === "[") {
        if (++depth > 128) break;
      } else if (ch === "}" || ch === "]") {
        if (--depth === 0) {
          try {
            const model = JSON.parse(html.slice(start, i + 1));
            if (model?.main && Array.isArray(model.legend)) return model;
          } catch {
            /* The surrounding JavaScript is deliberately unsupported. */
          }
          break;
        }
      }
    }
  }
  return null;
}

function reader(model) {
  return function unwrap(wrapped, depth = 0) {
    if (depth > 12) return null;
    const data =
      wrapped?.exportMetaType && Object.hasOwn(wrapped, "data")
        ? wrapped.data
        : wrapped;
    if (typeof data !== "string" || !/^~\d+$/.test(data)) return data;
    const path = model.legend[Number(data.slice(1))];
    if (!Array.isArray(path) || path.length > 32) return null;
    let result = model.main;
    for (const key of path) {
      if (
        ["__proto__", "prototype", "constructor"].includes(key) ||
        !result ||
        typeof result !== "object" ||
        !Object.hasOwn(result, key)
      )
        return null;
      result = result[key];
    }
    return unwrap(result, depth + 1);
  };
}

function rendition(photo, unwrap, source) {
  const sizes = unwrap(photo.sizes);
  if (!sizes || typeof sizes !== "object") return null;
  const candidates = [];
  for (const [name, wrapped] of Object.entries(sizes)) {
    if (["sq", "q"].includes(name)) continue; // Cropped square thumbnails.
    const size = unwrap(wrapped);
    if (!size || !(size.width > 0 && size.height > 0)) continue;
    try {
      const url = publicURL(size.url || size.displayUrl, source);
      if (
        url.protocol !== "https:" ||
        !url.hostname.endsWith(".staticflickr.com") ||
        !/\.(jpe?g|png|gif|webp)(?:$|[?#])/i.test(url.href)
      )
        continue;
      candidates.push({
        url: url.href,
        width: Number(size.width),
        height: Number(size.height),
        original: name === "o",
      });
    } catch {
      /* Ignore unusable renditions. */
    }
  }
  const rendered = candidates.filter((s) => !s.original);
  const choices = rendered.length ? rendered : candidates;
  // Smallest rendition that still covers the largest panel; otherwise the biggest.
  const edge = (s) => Math.max(s.width, s.height);
  const enough = choices.filter((s) => edge(s) >= MIN_IMAGE_EDGE);
  const chosen = (enough.length ? enough : choices).sort((a, b) =>
    enough.length ? edge(a) - edge(b) : edge(b) - edge(a),
  )[0];
  if (!chosen) return null;
  const { original, ...image } = chosen;
  return image;
}

export function flickrPhotostream(html, source) {
  const kind = flickrSource(source);
  if (!kind || kind.album) return null;
  const model = exportedModel(html);
  const unwrap = model && reader(model);
  const stream = unwrap?.(model.main["photostream-models"]?.[0]);
  const list = unwrap?.(stream?.photoPageList);
  const rows = unwrap?.(list?._data);
  if (!Array.isArray(rows))
    throw new Error(
      "Flickr did not expose its public photo list. Retry, configure the Flickr API, or upload photos.",
    );
  const owner = unwrap(stream.owner);
  const author = owner?.realname || owner?.username || "Flickr";
  const title = `${author} — Flickr photostream`;
  const items = [],
    seen = new Set();
  let skipped = false;
  for (const row of rows) {
    if (items.length >= MAX_ITEMS) break;
    const photo = unwrap(row);
    if (
      !photo ||
      photo._flickrModelRegistry !== "photo-models" ||
      !/^\d+$/.test(photo.id)
    ) {
      skipped = true;
      continue;
    }
    if (seen.has(photo.id)) continue;
    seen.add(photo.id);
    const image = rendition(photo, unwrap, source);
    if (!image) {
      skipped = true;
      continue;
    }
    const creator = unwrap(photo.owner);
    items.push({
      id: String(photo.id),
      ...image,
      title: photo.title || `Photo ${items.length + 1}`,
      credit: creator?.realname || creator?.username || author,
      source,
      kind: "photo",
      provider: "flickr",
      license: photo.license,
    });
  }
  const total = Number(list.totalItems ?? stream.totalItems);
  const complete =
    list.fetchedStart === true &&
    list.fetchedEnd === true &&
    Number.isFinite(total) &&
    total === items.length &&
    !skipped;
  return {
    title,
    fields: { title, author },
    items,
    completeness: complete ? "complete" : "partial",
    warnings: [
      "Flickr public page extraction is best effort. Album references retain photo IDs for rediscovery.",
      ...(!complete
        ? [
            "This page contains only part of the photostream (up to 100 photos).",
          ]
        : []),
    ],
  };
}
