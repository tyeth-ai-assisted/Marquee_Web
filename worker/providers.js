/** Collection adapters. Provider metadata feeds the same image-only builder. */
import { publicURL, MAX_ITEMS } from "./discovery.js";
import { icloudAlbum } from "./icloud.js";
import { flickrSource } from "./flickr.js";
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
  const flickr = flickrSource(u.href);
  if (flickr) {
    if (!env.FLICKR_API_KEY)
      if (!flickr.album)
        return null; // Public photostream page data needs no key.
      else
        throw new Error(
          "Flickr album API access needs a configured FLICKR_API_KEY. Use a public photostream link or upload photos meanwhile.",
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
        url: `https://www.flickr.com/photos/${flickr.user}/`,
      })
    ).user.id;
    const d = await call(
      flickr.album
        ? "flickr.photosets.getPhotos"
        : "flickr.people.getPublicPhotos",
      {
        ...(flickr.album ? { photoset_id: flickr.album } : {}),
        user_id: owner,
        extras: "url_l,url_c,url_z,url_m,url_o,owner_name,license",
        media: "photos",
        per_page: String(MAX_ITEMS),
      },
    );
    const collection = flickr.album ? d.photoset : d.photos;
    const author =
      collection.ownername || collection.photo?.[0]?.ownername || flickr.user;
    return {
      title:
        collection.title ||
        (flickr.album ? "Flickr album" : `${author} — Flickr photostream`),
      fields: { author },
      items: collection.photo
        .slice(0, MAX_ITEMS)
        .map((p) => ({
          id: p.id,
          url: p.url_l || p.url_c || p.url_z || p.url_m || p.url_o,
          title: p.title || "Photo",
          credit: p.ownername || author,
          license: p.license,
          source: u.href,
          kind: "image",
          provider: "flickr",
        }))
        .filter((i) => i.url),
      completeness:
        collection.pages > 1 || collection.photo.length > MAX_ITEMS
          ? "partial"
          : "complete",
      warnings: [],
    };
  }
  return null;
}
