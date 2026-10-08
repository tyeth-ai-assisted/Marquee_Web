import { rasterType } from "./image-bytes.js";
import { ALBUM_MAX_BYTES } from "./album.js";
export function importerBase() {
  return (localStorage.getItem("marquee-album-worker") || "").replace(
    /\/$/,
    "",
  );
}
export async function discoverAlbum(url, signal) {
  const r = await fetch(importerBase() + "/api/albums/discover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
    signal,
  });
  const result = await r.json();
  if (!r.ok) throw new Error(result.error || "Cannot discover this URL.");
  return result;
}
export async function prepareImage(
  blob,
  { maxSize = 800, quality = 0.72 } = {},
) {
  if (blob.size > 12 * 1024 * 1024)
    throw new Error("Image exceeds 12 MB. Crop or resize it before importing.");
  const mime = rasterType(
    new Uint8Array(await blob.slice(0, 16).arrayBuffer()),
  );
  if (!mime)
    throw new Error(
      "Use a PNG, JPEG, GIF, BMP or WebP image. SVG and HTML are not supported.",
    );
  blob = new Blob([blob], { type: mime });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () =>
        reject(new Error("This browser could not decode the image."));
      i.src = objectUrl;
    });
    if (img.naturalWidth * img.naturalHeight > 80 * 1000 * 1000)
      throw new Error("Image has too many pixels. Please resize it first.");
    const scale = Math.min(
      1,
      maxSize / img.naturalWidth,
      maxSize / img.naturalHeight,
    );
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    c.getContext("2d").fillStyle = "#fff";
    c.getContext("2d").fillRect(0, 0, c.width, c.height);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    // Preserve prepared pixels when a small PNG is already suitable for the panel.
    const src =
      blob.type === "image/png" && scale === 1
        ? await new Promise((resolve) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.readAsDataURL(blob);
          })
        : c.toDataURL("image/jpeg", quality);
    if (src.length > ALBUM_MAX_BYTES)
      throw new Error(
        "Picture is too large for portable storage. Crop, resize or pre-dither it first.",
      );
    return { src, natW: c.width, natH: c.height };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
export async function importCandidate(item, signal) {
  if (!item.importUrl)
    throw new Error("Discover this source again before importing.");
  const r = await fetch(importerBase() + item.importUrl, { signal });
  if (!r.ok) {
    const e = await r.json();
    throw new Error(e.error || "Cannot download this image.");
  }
  return prepareImage(await r.blob());
}
const discoveries = new Map();
export async function resolvePhoto(item, signal) {
  if (!item.url) return { ...item, problem: "" };
  const u = new URL(item.url);
  const m = /^#marquee-photo=(\d+)(?:&id=(.*))?$/.exec(u.hash);
  u.hash = "";
  let d = discoveries.get(u.href);
  if (!d || Date.now() - d.at > 10 * 60 * 1000) {
    d = { at: Date.now(), value: await discoverAlbum(u.href, signal) };
    discoveries.set(u.href, d);
  }
  let candidate = m?.[2]
    ? d.value.items.find((i) => i.id === decodeURIComponent(m[2]))
    : d.value.items[m ? +m[1] - 1 : 0];
  if (!candidate)
    throw new Error(
      "This page no longer contains the selected photo. Edit its URL or choose another picture.",
    );
  return {
    ...item,
    ...(await importCandidate(candidate, signal)),
    problem: "",
  };
}
