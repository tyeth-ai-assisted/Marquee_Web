/** Collection adapters. Provider metadata feeds the same image-only builder. */
import { publicURL, MAX_ITEMS } from "./discovery.js";
import { icloudAlbum } from "./icloud.js";
export async function providerCollection(value, env, readJSON) {
  const u = publicURL(value);
  const apple = await icloudAlbum(u.href, readJSON);
  if (apple) return apple;
  if (["images.nasa.gov", "images-api.nasa.gov"].includes(u.hostname)) {
    const q = u.searchParams.get("search") || u.searchParams.get("q");
    const album = /\/album\/([^/]+)/.exec(u.pathname)?.[1];
    if (!q && !album) return null;
    const api = album
      ? `https://images-api.nasa.gov/album/${encodeURIComponent(decodeURIComponent(album))}`
      : `https://images-api.nasa.gov/search?q=${encodeURIComponent(q)}&media_type=image&page_size=100`;
    const d = await readJSON(api);
    const rows = (d.collection?.items || []).filter(
      (i) => i.data?.[0]?.media_type === "image",
    );
    return {
      title: album ? `NASA ${decodeURIComponent(album)}` : `NASA ${q}`,
      fields: { title: q || album, author: "NASA" },
      items: rows
        .slice(0, MAX_ITEMS)
        .map((i) => {
          const data = i.data[0];
          return {
            id: data.nasa_id,
            url: i.links?.find((l) => l.render === "image")?.href,
            title: data.title || "",
            credit:
              data.photographer ||
              data.secondary_creator ||
              `NASA ${data.center || ""}`.trim(),
            source: u.href,
            kind: "image",
            provider: "nasa",
          };
        })
        .filter((i) => i.url),
      completeness: d.collection?.links?.some((l) => l.rel === "next")
        ? "partial"
        : "complete",
      warnings: [],
    };
  }
  const album = /\/photos\/([^/]+)\/(?:albums|sets)\/(\d+)/.exec(u.pathname);
  if (["www.flickr.com", "flickr.com"].includes(u.hostname) && album) {
    if (!env.FLICKR_API_KEY)
      throw new Error(
        "Flickr album API access needs a configured FLICKR_API_KEY. Upload photos or use a direct image URL meanwhile.",
      );
    const call = async (method, params) => {
      const api = new URL("https://api.flickr.com/services/rest/");
      for (const [k, v] of Object.entries({
        method,
        api_key: env.FLICKR_API_KEY,
        format: "json",
        nojsoncallback: "1",
        ...params,
      }))
        api.searchParams.set(k, v);
      const d = await readJSON(api.href);
      if (d.stat !== "ok")
        throw new Error(d.message || "Flickr could not read this album.");
      return d;
    };
    const owner = (
      await call("flickr.urls.lookupUser", {
        url: `https://www.flickr.com/photos/${album[1]}/`,
      })
    ).user.id;
    const d = await call("flickr.photosets.getPhotos", {
      photoset_id: album[2],
      user_id: owner,
      extras: "url_m,url_o,owner_name",
      media: "photos",
      per_page: String(MAX_ITEMS),
    });
    return {
      title: d.photoset.title || "Flickr album",
      fields: { author: d.photoset.ownername || album[1] },
      items: d.photoset.photo
        .map((p) => ({
          id: p.id,
          url: p.url_m || p.url_o,
          title: p.title || "",
          credit: p.ownername || d.photoset.ownername || album[1],
          source: u.href,
          kind: "image",
          provider: "flickr",
        }))
        .filter((i) => i.url),
      completeness: d.photoset.pages > 1 ? "partial" : "complete",
      warnings: [],
    };
  }
  return null;
}
