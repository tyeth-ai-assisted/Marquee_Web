/** Public social previews that need more than the page's Open Graph tags. */
import { MAX_ITEMS, publicURL, decodeHTMLText } from "./discovery.js";

function plain(value) {
  return decodeHTMLText(String(value || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
}

export async function mastodonPreview(value, readJSON) {
  const u = publicURL(value);
  if (u.hostname !== "mastodon.social") return null;
  const match = /^\/@[^/]+\/(\d+)\/?$/.exec(u.pathname);
  if (!match) return null;
  const id = match[1];
  const status = await readJSON(
    `https://mastodon.social/api/v1/statuses/${id}`,
  );
  if (status?.id !== id || !["public", "unlisted"].includes(status.visibility))
    throw new Error("This Mastodon post is not available as a public preview.");
  const account = status.account || {};
  const username = account.acct || account.username;
  const handle = username
    ? "@" + username + (username.includes("@") ? "" : "@mastodon.social")
    : "";
  const name = plain(account.display_name);
  const author =
    [name, handle && `(${handle})`].filter(Boolean).join(" ") || "Mastodon";
  const description = plain(status.content);
  const title = plain(status.card?.title) || description || `Post by ${author}`;
  const items = [];
  const add = (url, photoId, alt, dimensions) => {
    if (!url || items.length >= MAX_ITEMS) return;
    try {
      url = publicURL(url, u).href;
      if (items.some((i) => i.url === url)) return;
      items.push({
        id: String(photoId),
        url,
        title: plain(alt) || title,
        credit: author,
        width: dimensions?.width,
        height: dimensions?.height,
        source: u.href,
        kind: "preview",
        provider: "mastodon",
      });
    } catch {
      /* Ignore invalid media URLs; byte downloads use the normal guards. */
    }
  };
  for (const media of status.media_attachments || []) {
    const original = media.type === "image";
    add(
      original ? media.url : media.preview_url,
      media.id,
      media.description,
      original ? media.meta?.original : media.meta?.small,
    );
  }
  if (!items.length)
    add(
      status.card?.image,
      `${id}:card`,
      status.card?.image_description,
      status.card,
    );
  return {
    title,
    fields: {
      title,
      description: description || plain(status.card?.description),
      author,
      siteName: "Mastodon",
      sourceUrl: u.href,
      linkUrl: status.card?.url || "",
    },
    items,
    completeness: "page",
    warnings: items.length
      ? []
      : [
          "This public post has no image preview. A linked card can still show its text and attribution.",
        ],
  };
}
