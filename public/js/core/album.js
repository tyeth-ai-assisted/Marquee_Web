/** Album schema and playback calculations; deliberately independent of DOM/Konva. */
export const ALBUM_MAX_ITEMS = 100;
export const ALBUM_MAX_BYTES = 300 * 1024;
export function normalizeAlbum(items) {
  if (!Array.isArray(items) || items.length > ALBUM_MAX_ITEMS)
    throw new Error("Albums support up to 100 pictures.");
  const seen = new Set();
  let size = 0;
  const out = items.map((item, i) => {
    if (!item || typeof item !== "object")
      throw new Error(`Picture ${i + 1} is invalid.`);
    const url = String(item.url || "");
    const src = String(item.src || "");
    if (url && !/^https?:\/\//i.test(url))
      throw new Error(`Picture ${i + 1} needs an HTTP or HTTPS URL.`);
    if (url) {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`Picture ${i + 1} has an invalid URL.`);
      }
      if (parsed.username || parsed.password)
        throw new Error("Do not include credentials in photo URLs.");
    }
    if (
      src &&
      !/^data:image\/(png|jpeg|gif|bmp|webp);base64,[A-Za-z0-9+/=]+$/.test(src)
    )
      throw new Error(`Picture ${i + 1} has invalid embedded data.`);
    if (!url && !src)
      throw new Error(`Picture ${i + 1} needs a URL or uploaded photo.`);
    size += src.length;
    if (size > ALBUM_MAX_BYTES)
      throw new Error(
        "This album is too large for portable canvas storage (300 KB). Use fewer or smaller prepared pictures.",
      );
    let id = String(item.id || `photo-${i + 1}`);
    while (seen.has(id)) id += "-copy";
    seen.add(id);
    return {
      id,
      url,
      src: src || null,
      title: String(item.title || "").slice(0, 500),
      credit: String(item.credit || "").slice(0, 500),
      natW: +item.natW || null,
      natH: +item.natH || null,
    };
  });
  return out;
}
export function captionFor(item) {
  return [item?.title, item?.credit].filter(Boolean).join(" · ");
}
export function playbackIndex(
  items,
  {
    index = 0,
    shownAt = 0,
    interval = 600,
    paused = false,
    order = "sequence",
    seed = 1,
  } = {},
  now = Date.now(),
) {
  if (!items.length) return -1;
  index = Math.max(0, Math.min(items.length - 1, Math.floor(index) || 0));
  if (
    paused ||
    !shownAt ||
    now - shownAt < Math.max(60, +interval || 600) * 1000
  )
    return index;
  // At most one change per take; waking late never bursts through missed frames.
  if (order !== "shuffle") return (index + 1) % items.length;
  const ids = items.map((_, i) => i);
  let n = Number(seed) || 1;
  for (let i = ids.length - 1; i > 0; i--) {
    n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
    const j = n % (i + 1);
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids[(ids.indexOf(index) + 1) % ids.length];
}
