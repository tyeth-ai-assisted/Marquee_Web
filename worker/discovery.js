/** Provider-neutral discovery. No script evaluation; presentation is a separate concern. */
/** Panels top out at 800x480: ask providers for the smallest rendition covering
 * that, and never more than MAX_IMAGE_EDGE, to keep Worker memory and time low. */
export const MIN_IMAGE_EDGE = 800;
export const MAX_IMAGE_EDGE = 1200;
export const MAX_ITEMS = 100;
// HTMLRewriter exposes raw attribute/text entities. Decode once before URL use.
export function decodeHTMLText(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(value).replace(
    /&(?:#(x[0-9a-f]+|\d+);?|(amp|lt|gt|quot|apos|nbsp);)/gi,
    (whole, numeric, name) => {
      if (!numeric) return named[name] ?? whole;
      const code =
        numeric[0].toLowerCase() === "x"
          ? parseInt(numeric.slice(1), 16)
          : Number(numeric);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : "\ufffd";
    },
  );
}
export function publicURL(value, base) {
  const u = new URL(value, base);
  const h = u.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    (u.port && !["80", "443"].includes(u.port)) ||
    !h.includes(".") ||
    h.includes(":") ||
    /^(localhost|.*\.(local|internal|localhost))$/.test(h) ||
    /^\d+\.\d+\.\d+\.\d+$/.test(h)
  )
    throw new Error(
      "Use a public HTTP or HTTPS URL (IP addresses are not supported).",
    );
  return u;
}
export function reference(value) {
  const u = publicURL(value);
  const m = /^#marquee-photo=(\d+)(?:&id=(.*))?$/.exec(u.hash);
  if (u.hash.startsWith("#marquee-photo=") && !m)
    throw new Error("Invalid album item reference.");
  if (m && (+m[1] < 1 || +m[1] > MAX_ITEMS))
    throw new Error("Album item number must be between 1 and 100.");
  u.hash = "";
  return {
    url: u.href,
    index: m ? +m[1] - 1 : 0,
    id: m?.[2] ? decodeURIComponent(m[2]) : null,
    selected: !!m,
  };
}
export function albumReference(url, index, id) {
  const u = publicURL(url);
  u.hash = `marquee-photo=${index + 1}${id ? "&id=" + encodeURIComponent(id) : ""}`;
  return u.href;
}
export { rasterType } from "../public/js/core/image-bytes.js";
export function googleAlbum(html, source) {
  // The callback's data is JSON, while its surrounding JavaScript is not.
  for (const match of html.matchAll(
    /AF_initDataCallback\(\{key:\s*'[^']+'[\s\S]*?\bdata:([\s\S]*?),\s*sideChannel:/g,
  )) {
    let data;
    try {
      data = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (!Array.isArray(data?.[1])) continue;
    const rows = data[1].filter(
      (r) =>
        typeof r?.[0] === "string" &&
        /^https:\/\/lh\d\.googleusercontent\.com\/pw\//.test(r?.[1]?.[0]),
    );
    if (!rows.length) continue;
    const author =
      typeof data[3]?.[5]?.[11]?.[0] === "string"
        ? data[3][5][11][0]
        : "Google Photos";
    const title =
      typeof data[3]?.[1] === "string" ? data[3][1] : "Google Photos album";
    return {
      title,
      author,
      items: rows.slice(0, MAX_ITEMS).map((r, i) => ({
        id: r[0],
        url: r[1][0],
        width: r[1][1],
        height: r[1][2],
        title: `Photo ${i + 1}`,
        credit: author,
        source,
        kind: "photo",
        provider: "google-photos",
      })),
      completeness:
        rows.length >= MAX_ITEMS || data[0] != null || !!data[2]
          ? "partial"
          : "complete",
      warnings: [
        "Google Photos page extraction is best effort. Large albums may require further pages.",
      ],
    };
  }
  return null;
}
export function discoverRecords({
  records = [],
  scripts = [],
  title = "",
  source,
}) {
  let base = source;
  const items = [];
  const seen = new Set();
  const fields = { title, description: "", author: "", structuredData: [] };
  const push = (url, attrs = {}) => {
    try {
      url = publicURL(url, base).href;
    } catch {
      return;
    }
    if (seen.has(url) || items.length >= MAX_ITEMS) return;
    seen.add(url);
    items.push({
      id: attrs.id || url,
      url,
      title: attrs.title || "",
      source,
      ...attrs,
    });
  };
  for (const r of records)
    if (r.tag === "base" && r.href) {
      try {
        base = publicURL(r.href, source).href;
      } catch {}
      break;
    }
  let og = null;
  for (const r of records) {
    const p = r.property || r.name;
    if (p === "og:title" || p === "twitter:title")
      fields.title = r.content || fields.title;
    if (p === "twitter:creator" || p === "author" || p === "article:author")
      fields.author = r.content || fields.author;
    if (p === "og:description" || p === "description")
      fields.description = r.content || fields.description;
    if (
      p === "og:image" ||
      p === "og:image:url" ||
      p === "og:image:secure_url" ||
      p === "twitter:image"
    ) {
      push(r.content, { kind: "preview", title: fields.title });
      try {
        og = items.find((i) => i.url === new URL(r.content, base).href);
      } catch {
        og = null;
      }
    }
    if (og && p === "og:image:width") og.width = +r.content;
    if (og && p === "og:image:height") og.height = +r.content;
    if (og && p === "og:image:alt") {
      og.title = r.content;
      og.hasAlt = true;
    }
  }
  const objects = new Map();
  for (const script of scripts) {
    try {
      const d = JSON.parse(script);
      fields.structuredData.push(d);
    } catch {}
  }
  let visited = 0;
  const index = (v, depth = 0) => {
    if (!v || typeof v !== "object" || depth > 20 || visited++ > 5000) return;
    if (v["@id"]) objects.set(v["@id"], v);
    for (const x of Object.values(v))
      if (typeof x === "object")
        Array.isArray(x)
          ? x.forEach((a) => index(a, depth + 1))
          : index(x, depth + 1);
  };
  fields.structuredData.forEach((d) => index(d));
  visited = 0;
  const traversed = new Set();
  const walk = (v, depth = 0) => {
    if (
      !v ||
      typeof v !== "object" ||
      depth > 20 ||
      visited++ > 5000 ||
      traversed.has(v)
    )
      return;
    traversed.add(v);
    if (Array.isArray(v)) {
      v.forEach((x) => walk(x, depth + 1));
      return;
    }
    if (v["@id"] && objects.has(v["@id"]) && objects.get(v["@id"]) !== v)
      walk(objects.get(v["@id"]), depth + 1);
    if (!fields.author && v.author) {
      const a = Array.isArray(v.author) ? v.author[0] : v.author;
      fields.author = typeof a === "string" ? a : a?.name || "";
    }
    const type = []
      .concat(v["@type"] || [])
      .map((t) => String(t).split("/").pop());
    if (type.includes("ImageObject"))
      push(v.contentUrl || v.url, {
        title: v.caption || v.name || "",
        width: +v.width || undefined,
        height: +v.height || undefined,
        credit: typeof v.creditText === "string" ? v.creditText : "",
        kind: "image",
      });
    for (const k of ["image", "contentUrl", "thumbnailUrl"])
      for (const val of [].concat(v[k] || []))
        if (typeof val === "string")
          push(val, {
            title: v.name || "",
            kind: k === "thumbnailUrl" ? "preview" : "image",
          });
    const ordered = Array.isArray(v.itemListElement)
      ? [...v.itemListElement].sort(
          (a, b) => (a.position || 0) - (b.position || 0),
        )
      : null;
    if (ordered) ordered.forEach((x) => walk(x, depth + 1));
    for (const [k, x] of Object.entries(v))
      if (k !== "itemListElement") walk(x, depth + 1);
  };
  fields.structuredData.forEach((d) => walk(d));
  // Some social pages put the creator handle only in the title, alongside a name.
  if (["bsky.app", "x.com", "twitter.com"].includes(new URL(source).hostname)) {
    const handle = /\((@[^\s()]+)\)(?: on (?:X|Twitter))?$/.exec(fields.title);
    if (handle && !fields.author.includes(handle[1]))
      fields.author = fields.author
        ? `${fields.author} (${handle[1]})`
        : handle[1];
  }
  // Responsive alternatives belong to one photo, not several carousel slides.
  for (const r of records) {
    if (r.tag === "img") {
      const sizes = (r["data-srcset"] || r.srcset || "")
        .split(",")
        .map((x) => x.trim().split(/\s+/))
        .filter((x) => x[0]);
      sizes.sort((a, b) => parseFloat(b[1] || 0) - parseFloat(a[1] || 0));
      const url =
        sizes[0]?.[0] ||
        r["data-src"] ||
        r["data-lazy-src"] ||
        r["data-original"] ||
        r.src;
      push(url, {
        title: r.alt || "",
        width: +r.width || undefined,
        height: +r.height || undefined,
        kind: "image",
      });
    }
    if (r.tag === "source" && r.srcset) {
      /* paired img supplies the fallback; adapters can add picture variants */
    }
    if (
      r.tag === "a" &&
      /\.(jpe?g|png|gif|webp|bmp)(?:[?#]|$)/i.test(r.href || "")
    )
      push(r.href, { kind: "image" });
    const prop = r.itemprop || r.property;
    if (prop && /(?:^|[\s:/])(image|contentUrl|thumbnailUrl)$/.test(prop))
      push(r.content || r.src || r.href || r.resource, { kind: "image" });
  }
  items.forEach((i) => {
    if (!i.title || (i.kind === "preview" && !i.hasAlt)) i.title = fields.title;
    delete i.hasAlt;
    if (!i.credit) i.credit = fields.author || new URL(source).hostname;
  });
  return {
    items,
    fields,
    title: fields.title,
    completeness: items.length >= MAX_ITEMS ? "partial" : "page",
    warnings: items.length
      ? [
          "Images found on this page; this may not include the whole collection.",
        ]
      : [
          "No usable image preview was found. Try another URL or upload a picture.",
        ],
  };
}
export function manifest(data, source) {
  if (data?.version !== 1 || !Array.isArray(data.items))
    throw new Error(
      "Expected an album manifest with version 1 and an items array.",
    );
  const items = data.items.slice(0, MAX_ITEMS).map((item, i) => {
    const v = typeof item === "string" ? { url: item } : item;
    return {
      id: String(v.id || i),
      url: publicURL(v.url, source).href,
      title: String(v.title || ""),
      credit: String(v.credit || ""),
      source,
      kind: "image",
    };
  });
  return {
    title: String(data.title || "Photo album"),
    items,
    fields: { title: String(data.title || "Photo album") },
    completeness: data.items.length > MAX_ITEMS ? "partial" : "complete",
    warnings: [],
  };
}
