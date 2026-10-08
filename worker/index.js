import { providerCollection } from "./providers.js";
import { flickrPhotostream } from "./flickr.js";
import {
  publicURL,
  reference,
  rasterType,
  googleAlbum,
  discoverRecords,
  manifest,
  decodeHTMLText,
} from "./discovery.js";
const MAX_HTML = 2 * 1024 * 1024,
  MAX_IMAGE = 12 * 1024 * 1024;
export async function bounded(response, limit) {
  if (+response.headers.get("content-length") > limit) {
    await response.body?.cancel();
    throw new Error("Remote file is too large.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty remote response.");
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("Remote file is too large.");
      parts.push(value);
    }
  } catch (e) {
    await reader.cancel();
    throw e;
  }
  const b = new Uint8Array(size);
  let p = 0;
  for (const v of parts) {
    b.set(v, p);
    p += v.length;
  }
  return b;
}
export async function remote(value, env = {}, fetcher = fetch, jsonBody) {
  let u = publicURL(value);
  const allowed = (env.ALLOWED_HOSTS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  for (let n = 0; n < 6; n++) {
    if (allowed.length && !allowed.includes(u.hostname))
      throw new Error("This source host is not enabled by the importer.");
    // Resolve and validate public addresses before fetch; repeat after each redirect.
    const dns = await fetcher(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(u.hostname)}&type=A`,
      {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!dns.ok) throw new Error("Cannot verify source hostname.");
    const answers =
      (await dns.json()).Answer?.filter((a) => a.type === 1).map(
        (a) => a.data,
      ) || [];
    if (!answers.length || answers.some((ip) => !publicIPv4(ip)))
      throw new Error(
        "Source does not resolve exclusively to public IPv4 addresses.",
      );
    const r = await fetcher(u.href, {
      redirect: "manual",
      credentials: "omit",
      signal: AbortSignal.timeout(30000),
      headers: {
        Accept: "text/html,application/json,image/*;q=0.9",
        ...(jsonBody === undefined ? {} : { "Content-Type": "text/plain" }),
      },
      ...(jsonBody === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(jsonBody) }),
    });
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const next = r.headers.get("location");
      await r.body?.cancel();
      if (jsonBody !== undefined)
        throw new Error("Album API redirects are not supported.");
      if (!next) throw new Error("Invalid remote redirect.");
      u = publicURL(next, u);
      continue;
    }
    if (!r.ok) {
      await r.body?.cancel();
      throw new Error(`Source returned HTTP ${r.status}.`);
    }
    return { response: r, url: u.href };
  }
  throw new Error("Too many redirects.");
}
export function publicIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255))
    return false;
  const [a, b, c] = p;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || b === 2)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}
export async function extractHTML(html, source) {
  const records = [],
    scripts = [];
  let title = "",
    picture = 0,
    currentPicture = null;
  const pictureVariants = new Map();
  const rewrite = new HTMLRewriter()
    .on("picture", {
      element(e) {
        currentPicture = ++picture;
        e.onEndTag(() => {
          currentPicture = null;
        });
      },
    })
    .on("meta, img, source, a, base, [itemprop], [property]", {
      element(e) {
        const r = { tag: e.tagName };
        for (const [k, v] of e.attributes) r[k] = decodeHTMLText(v);
        if (
          currentPicture &&
          e.tagName === "source" &&
          r.srcset &&
          !r.type?.includes("svg")
        )
          pictureVariants.set(currentPicture, r.srcset);
        if (
          currentPicture &&
          e.tagName === "img" &&
          pictureVariants.has(currentPicture)
        )
          r.srcset = pictureVariants.get(currentPicture);
        if (records.length < 5000) records.push(r);
      },
    })
    .on('script[type="application/ld+json"]', {
      element() {
        scripts.push("");
      },
      text(t) {
        scripts[scripts.length - 1] += t.text;
      },
    })
    .on("title", {
      text(t) {
        title += t.text;
      },
    });
  await rewrite.transform(new Response(html)).text();
  return discoverRecords({
    records,
    scripts,
    title: decodeHTMLText(title),
    source,
  });
}
export async function discover(
  value,
  env = {},
  fetcher = fetch,
  extract = extractHTML,
) {
  const ref = reference(value);
  const readJSON = async (u, body) => {
    const { response } = await remote(u, env, fetcher, body);
    return JSON.parse(
      new TextDecoder().decode(await bounded(response, MAX_HTML)),
    );
  };
  const provider = await providerCollection(ref.url, env, readJSON);
  if (provider) return provider;
  const { response, url } = await remote(ref.url, env, fetcher);
  const type = response.headers.get("content-type") || "";
  if (imageResponse(type)) {
    const bytes = await bounded(response, MAX_IMAGE);
    if (!rasterType(bytes)) throw new Error("Unsupported raster image.");
    return {
      title: "Image",
      items: [{ id: url, url, source: url, kind: "image", title: "Image" }],
      fields: {},
      completeness: "complete",
      warnings: [],
    };
  }
  const bytes = await bounded(response, MAX_HTML);
  const text = new TextDecoder().decode(bytes);
  // Short links must reach the same adapter as their final public destination.
  if (url !== ref.url) {
    const redirected = await providerCollection(url, env, readJSON);
    if (redirected) return redirected;
  }
  if (type.includes("json")) return manifest(JSON.parse(text), url);
  const flickr = flickrPhotostream(text, url);
  if (flickr) return flickr;
  const g =
    new URL(url).hostname === "photos.google.com"
      ? googleAlbum(text, url)
      : null;
  const result = g
    ? {
        ...g,
        title: g.title || "Google Photos album",
        fields: { title: g.title, author: g.author },
      }
    : await extract(text, url);
  return result;
}
function imageResponse(type) {
  return /^(?:image\/|application\/octet-stream\b|binary\/octet-stream\b)/i.test(
    type,
  );
}
export async function downloadImage(payload, env = {}, fetcher = fetch) {
  let url = payload.url;
  if (payload.provider === "google-photos")
    url = url.split("=")[0] + "=w1600-h1600";
  const ref = reference(url);
  let response;
  if (!ref.selected) response = (await remote(ref.url, env, fetcher)).response;
  if (!response || !imageResponse(response.headers.get("content-type") || "")) {
    await response?.body?.cancel();
    const d = await discover(url, env, fetcher);
    const item = ref.id
      ? d.items.find((i) => i.id === ref.id)
      : d.items[ref.index];
    if (!item) throw new Error("Selected picture was not found.");
    const imageURL =
      item.provider === "google-photos"
        ? item.url.split("=")[0] + "=w1600-h1600"
        : item.url;
    response = (await remote(imageURL, env, fetcher)).response;
  }
  const bytes = await bounded(response, MAX_IMAGE);
  const mime = rasterType(bytes);
  if (!mime)
    throw new Error("This URL did not return a supported raster image.");
  return { bytes, mime };
}
const enc = new TextEncoder();
async function key(secret) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
function b64(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function unb64(s) {
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
}
export async function sign(payload, secret) {
  const body = b64(enc.encode(JSON.stringify(payload)));
  return (
    body +
    "." +
    b64(
      new Uint8Array(
        await crypto.subtle.sign("HMAC", await key(secret), enc.encode(body)),
      ),
    )
  );
}
export async function verify(token, secret, now = Date.now()) {
  const [body, sig, ...rest] = String(token).split(".");
  if (!body || !sig || rest.length || token.length > 12000)
    throw new Error("Invalid import token.");
  let valid = false,
    p;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      await key(secret),
      unb64(sig),
      enc.encode(body),
    );
    p = JSON.parse(new TextDecoder().decode(unb64(body)));
  } catch {}
  if (!valid || !p || !Number.isFinite(p.exp) || p.exp < now)
    throw new Error("Import link expired. Discover the source again.");
  publicURL(p.url);
  return p;
}
export default {
  async fetch(request, env) {
    const headers = {
      "Access-Control-Allow-Origin":
        env.APP_ORIGIN || new URL(request.url).origin,
      Vary: "Origin",
      "Cache-Control": "private, no-store",
    };
    const json = (data, status = 200) =>
      Response.json(data, { status, headers });
    if (
      request.headers.get("Origin") &&
      env.APP_ORIGIN &&
      request.headers.get("Origin") !== env.APP_ORIGIN
    )
      return json({ error: "This origin is not enabled." }, 403);
    if (request.method === "OPTIONS")
      return new Response(null, {
        headers: {
          ...headers,
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    if (!env.IMPORT_SECRET || env.IMPORT_SECRET.length < 32)
      return json(
        { error: "Importer needs an IMPORT_SECRET of at least 32 characters." },
        503,
      );
    // Deployment rate limiting is mandatory; binding supports Cloudflare's rate limiter.
    if (
      env.RATE_LIMITER &&
      !(
        await env.RATE_LIMITER.limit({
          key: request.headers.get("CF-Connecting-IP") || "unknown",
        })
      ).success
    )
      return json(
        { error: "Too many imports. Please try again shortly." },
        429,
      );
    try {
      const route = new URL(request.url);
      if (
        route.pathname === "/api/albums/discover" &&
        request.method === "POST"
      ) {
        if (+request.headers.get("content-length") > 16384)
          return json({ error: "Request too large." }, 413);
        const raw = await bounded(request, 16384);
        const { url } = JSON.parse(new TextDecoder().decode(raw));
        const result = await discover(url, env);
        for (const item of result.items) {
          const token = await sign(
            {
              url: item.url,
              provider: item.provider,
              exp: Date.now() + 15 * 60 * 1000,
            },
            env.IMPORT_SECRET,
          );
          item.importUrl = `/api/albums/image?token=${token}`;
        }
        return json(result);
      }
      if (route.pathname === "/api/albums/image" && request.method === "GET") {
        const p = await verify(
          route.searchParams.get("token"),
          env.IMPORT_SECRET,
        );
        const { bytes, mime } = await downloadImage(p, env);
        return new Response(bytes, {
          headers: {
            ...headers,
            "Content-Type": mime,
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      return json({ error: "Not found." }, 404);
    } catch (e) {
      return json({ error: e.message || "Import failed." }, 400);
    }
  },
};
