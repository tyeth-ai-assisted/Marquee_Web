/** iCloud's public shared-collection protocol; no login or share acceptance. */
import { MAX_ITEMS, publicURL } from "./discovery.js";

const field = (record, name) => record?.fields?.[name]?.value;
const displayName = (identity) =>
  [identity?.nameComponents?.givenName, identity?.nameComponents?.familyName]
    .filter((s) => typeof s === "string")
    .join(" ");
function textField(record, name) {
  const value = field(record, name);
  if (typeof value !== "string" || value.length > 8192) return "";
  try {
    // Public CloudKit responses use base64 even for readable *Enc fields.
    return new TextDecoder("utf-8", { fatal: true })
      .decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0)))
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim();
  } catch {
    return "";
  }
}
function rendition(asset, master, domain) {
  // Prefer rendered edits, then a medium JPEG over an unsupported HEIC original.
  for (const record of [asset, master]) {
    for (const name of [
      "resJPEGMed",
      "resJPEGFull",
      "resJPEGLarge",
      "resJPEGThumb",
      "resOriginal",
    ]) {
      if (
        name === "resOriginal" &&
        ![
          "public.jpeg",
          "public.png",
          "org.webmproject.webp",
          "com.compuserve.gif",
          "com.microsoft.bmp",
        ].includes(field(record, name + "FileType"))
      )
        continue;
      const value = field(record, name + "Res")?.downloadURL;
      if (typeof value !== "string") continue;
      try {
        const u = publicURL(value);
        if (
          u.protocol !== "https:" ||
          !(u.hostname === domain || u.hostname.endsWith("." + domain))
        )
          continue;
        return {
          url: u.href,
          width: field(record, name + "Width"),
          height: field(record, name + "Height"),
        };
      } catch {
        /* Try another safe, supported rendition. */
      }
    }
  }
  return null;
}

export async function icloudAlbum(source, readJSON) {
  const u = publicURL(source);
  if (!["photos.icloud.com", "photos.icloud.com.cn"].includes(u.hostname))
    return null;
  const id = /^\/shared\/album\/([A-Za-z0-9_-]{10,100})\/?$/.exec(
    u.pathname,
  )?.[1];
  if (!id) return null;
  u.hash = "";
  const region = u.hostname.endsWith(".cn") ? ".cn" : "";
  const path = "/database/1/com.apple.photos.cloud/production/";
  const endpoint = (origin, scope, operation, token) => {
    const url = new URL(path + scope + "/records/" + operation, origin);
    url.searchParams.set("remapEnums", "true");
    url.searchParams.set("sharing_url_key", id);
    if (token) url.searchParams.set("publicAccessAuthToken", token);
    return url.href;
  };
  const read = async (url, body) => {
    try {
      return await readJSON(url, body);
    } catch {
      // Never surface anonymous-access tokens or expiring CDN URLs in errors.
      throw new Error(
        "iCloud could not read this public album. Retry or check that its public link still works.",
      );
    }
  };
  const resolved = await read(
    endpoint("https://ckdatabasews.icloud.com" + region, "public", "resolve"),
    { shortGUIDs: [{ value: id }] },
  );
  const share = resolved?.results?.[0];
  const access = share?.anonymousPublicAccess;
  if (
    share?.requireAppleLogin ||
    !access?.token ||
    share?.databaseScope !== "SHARED" ||
    !share?.zoneID?.zoneName
  ) {
    throw new Error(
      "This iCloud album is unavailable for public viewing. Enable public sharing or upload the photos.",
    );
  }
  const partition = publicURL(access.databasePartition);
  const host = partition.hostname;
  if (
    partition.protocol !== "https:" ||
    !new RegExp(
      "^(?:p[0-9]+-)?ckdatabasews\\.icloud\\.com" +
        (region ? "\\.cn" : "") +
        "$",
    ).test(host)
  ) {
    throw new Error("iCloud returned an unsupported album server.");
  }
  const data = await read(
    endpoint(partition.origin, "shared", "query", access.token),
    {
      query: {
        recordType: "CPLAssetAndMasterByAddedDate",
        filterBy: [
          {
            fieldName: "direction",
            comparator: "EQUALS",
            fieldValue: { value: "ASCENDING", type: "STRING" },
          },
        ],
      },
      zoneID: share.zoneID,
      resultsLimit: MAX_ITEMS + 1,
    },
  );
  if (!Array.isArray(data?.records) || data.serverErrorCode) {
    throw new Error(
      "iCloud did not return album photos. Retry or check its public sharing settings.",
    );
  }
  const title = field(share.share, "cloudkit.title") || "iCloud Photos album";
  const author =
    displayName(share.ownerIdentity) ||
    displayName(share.share?.owner?.userIdentity) ||
    "iCloud Photos";
  const names = new Map(
    (share.share?.participants || []).map((p) => [
      p.userIdentity?.userRecordName,
      displayName(p.userIdentity),
    ]),
  );
  const masters = new Map(
    data.records
      .filter((r) => r.recordType === "CPLMaster" && !r.deleted)
      .map((r) => [r.recordName, r]),
  );
  const assets = data.records.filter(
    (r) => r.recordType === "CPLAsset" && !r.deleted && !field(r, "isTrashed"),
  );
  const items = [],
    seen = new Set();
  let skipped = false;
  for (const asset of assets) {
    if (items.length >= MAX_ITEMS) break;
    if (!asset.recordName || seen.has(asset.recordName)) continue;
    seen.add(asset.recordName);
    const master = masters.get(field(asset, "masterRef")?.recordName);
    const image = rendition(asset, master, "icloud-content.com" + region);
    if (!image) {
      skipped = true;
      continue;
    }
    items.push({
      id: asset.recordName,
      ...image,
      title:
        textField(asset, "captionEnc") ||
        textField(master, "filenameEnc") ||
        `Photo ${items.length + 1}`,
      credit: names.get(asset.created?.userRecordName) || author,
      source: u.href,
      kind: "photo",
      provider: "icloud-photos",
    });
  }
  const partial =
    !!data.continuationMarker || assets.length >= MAX_ITEMS || skipped;
  return {
    title,
    fields: { title, author },
    items,
    completeness: partial ? "partial" : "complete",
    warnings: [
      "iCloud public album access is best effort. Use album references to refresh expiring image links.",
      ...(partial
        ? [
            "Some items may be unavailable or beyond the 100-picture limit. Videos use an available still preview.",
          ]
        : []),
    ],
  };
}
