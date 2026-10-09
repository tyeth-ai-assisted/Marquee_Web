import {
  $,
  escapeHtml,
  escapeAttr,
  openModal,
  closeModal,
  wireModal,
  onModalClose,
  toast,
} from "../core/util.js";
import {
  normalizeAlbum,
  ALBUM_MAX_ITEMS,
  ALBUM_MAX_BYTES,
} from "../core/album.js";
import {
  importerBase,
  discoverAlbum,
  importCandidate,
  prepareImage,
} from "../core/album-client.js";
import {
  addCarousel,
  feedImageGen,
  decodeImage,
  applyFeedImage,
  rebuildWidget,
} from "../canvas/elements.js";
import { select } from "../canvas/selection.js";
let target = null,
  draft = [],
  seq = 0,
  controller = null,
  busy = false,
  targetGen = 0;
const status = (s) => {
  $("albumStatus").textContent = s;
};
function ref(source, index, id) {
  const u = new URL(source);
  u.hash = `marquee-photo=${index + 1}${id ? "&id=" + encodeURIComponent(id) : ""}`;
  return u.href;
}
function render() {
  $("albumGrid").innerHTML = draft
    .map(
      (
        item,
        i,
      ) => `<article class="album-item" data-index="${i}" draggable="true">
    <label><input type="checkbox" data-action="select" ${item.selected !== false ? "checked" : ""}> Picture ${i + 1}</label>
    ${item.src || item.importUrl ? `<button type="button" data-action="enlarge" aria-label="Enlarge picture ${i + 1}"><img loading="lazy" alt="${escapeAttr(item.title || "Photo")}" src="${escapeAttr(item.src || importerBase() + item.importUrl)}"></button>` : '<p class="hint">Resolve on save</p>'}
    <label>Title<input data-field="title" value="${escapeAttr(item.title || "")}"></label>
    <label>Attribution<input data-field="credit" value="${escapeAttr(item.credit || "")}"></label>
    <label>Source URL<input data-field="url" value="${escapeAttr(item.url || "")}" placeholder="Uploaded photo"></label>
    <div class="prop-row"><button type="button" class="btn btn-sm" data-action="up" ${i === 0 ? "disabled" : ""}>Move up</button><button type="button" class="btn btn-sm" data-action="down" ${i === draft.length - 1 ? "disabled" : ""}>Move down</button><button type="button" class="btn btn-sm" data-action="remove">Remove</button></div>
    ${item.error ? `<p role="alert">${escapeHtml(item.error)}</p>` : ""}</article>`,
    )
    .join("");
  $("albumCount").textContent =
    `${draft.filter((x) => x.selected !== false).length} selected of ${draft.length} · ${Math.ceil(draft.reduce((n, x) => n + (x.src?.length || 0), 0) / 1024)} / 300 KB embedded`;
}
function activity(on) {
  busy = on;
  $("albumSave").disabled = on;
  $("albumDiscover").disabled = on;
  $("albumUploads").disabled = on;
  $("albumManifest").disabled = on;
}
function begin() {
  controller?.abort();
  controller = new AbortController();
  return ++seq;
}
function configure() {
  const raw = $("albumWorker").value.trim();
  if (raw) {
    const u = new URL(raw);
    if (
      u.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(u.hostname)
    )
      throw new Error("Importer address must use HTTPS.");
    localStorage.setItem("marquee-album-worker", u.origin);
  } else localStorage.removeItem("marquee-album-worker");
}
export function openAlbumBuilder(node = null) {
  target = node;
  targetGen = node ? feedImageGen(node) : 0;
  begin();
  activity(false);
  draft = (node?.getAttr("items") || []).map((i) => ({ ...i, selected: true }));
  $("albumName").value = node?.getAttr("albumName") || "Photo album";
  $("albumWorker").value = importerBase();
  $("albumUrls").value = "";
  $("albumMode").value = "references";
  status("Paste image, album or webpage URLs, or upload photos.");
  render();
  openModal("albumModal", { trap: true, focus: "albumUrls" });
}
async function discover() {
  const turn = begin();
  activity(true);
  try {
    configure();
    const urls = $("albumUrls")
      .value.split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (!urls.length) throw new Error("Paste at least one URL.");
    for (const url of urls.slice(0, ALBUM_MAX_ITEMS)) {
      status(`Finding pictures (${draft.length} found)…`);
      try {
        const result = await discoverAlbum(url, controller.signal);
        if (turn !== seq) return;
        const u = new URL(url);
        const selector = /^#marquee-photo=(\d+)(?:&id=(.*))?$/.exec(u.hash);
        let found = result.items;
        if (selector)
          found = selector[2]
            ? found.filter((i) => i.id === decodeURIComponent(selector[2]))
            : found.slice(+selector[1] - 1, +selector[1]);
        for (const item of found) {
          if (draft.length >= ALBUM_MAX_ITEMS) break;
          const index = result.items.indexOf(item);
          const entry = {
            ...item,
            providerId: item.id,
            id: crypto.randomUUID(),
            directUrl: item.url,
            referenceUrl: ref(
              item.source || url,
              index,
              item.provider ? item.id : null,
            ),
            url: selector
              ? url
              : ref(item.source || url, index, item.provider ? item.id : null),
            selected: true,
          };
          if (!draft.some((x) => x.url === entry.url)) draft.push(entry);
        }
        status(
          `${result.title || "Collection"}: ${found.length} images · ${result.completeness}. ${(result.warnings || []).join(" ")}`,
        );
      } catch (e) {
        if (turn !== seq) return;
        // A valid source can be temporarily unavailable. Keep the URL editable.
        if (!/^https?:\/\//i.test(url)) throw e;
        draft.push({
          id: crypto.randomUUID(),
          url,
          title: "",
          credit: new URL(url).hostname,
          selected: true,
          error: e.message,
        });
        status(e.message);
      }
      render();
    }
  } catch (e) {
    if (turn === seq) status(e.message);
  } finally {
    if (turn === seq) activity(false);
  }
}
async function save() {
  const turn = begin();
  activity(true);
  try {
    configure();
    const items = [];
    for (const entry of draft.filter((x) => x.selected !== false)) {
      status(`Preparing picture ${items.length + 1}…`);
      let item = { ...entry };
      try {
        if (!item.src) {
          if (!item.importUrl) {
            const result = await discoverAlbum(item.url, controller.signal);
            const u = new URL(item.url);
            const m = /^#marquee-photo=(\d+)(?:&id=(.*))?$/.exec(u.hash);
            const c = m?.[2]
              ? result.items.find((x) => x.id === decodeURIComponent(m[2]))
              : result.items[m ? +m[1] - 1 : 0];
            if (!c) throw new Error("No image preview found for this item.");
            item = {
              ...item,
              ...(await importCandidate(c, controller.signal)),
              title: item.title || c.title,
              credit: item.credit || c.credit || new URL(item.url).hostname,
            };
          } else
            item = {
              ...item,
              ...(await importCandidate(item, controller.signal)),
            };
        }
      } catch (e) {
        entry.error = e.message;
        render();
        throw new Error(
          `Picture ${items.length + 1}: ${e.message} Remove or deselect it, or retry.`,
        );
      }
      if (turn !== seq) return;
      items.push(item);
    }
    if (!items.length) throw new Error("Select at least one picture.");
    const normalized = normalizeAlbum(items);
    const img = await decodeImage(normalized[0].src);
    if (!img) throw new Error("First image could not be decoded.");
    if (turn !== seq) return;
    if (target && (!target.getLayer() || feedImageGen(target) !== targetGen))
      throw new Error("The original frame changed. Reopen its album editor.");
    const node =
      target ||
      addCarousel({ items: normalized, albumName: $("albumName").value });
    if (target) {
      node.setAttrs({
        items: normalized,
        albumName: $("albumName").value,
        feedGen: targetGen + 1,
        slideIndex: 0,
        shownAt: Date.now(),
      });
    }
    applyFeedImage(node, img, normalized[0].src);
    select(node);
    closeModal("albumModal");
    toast("Photo album saved");
  } catch (e) {
    if (turn === seq) status(e.message);
  } finally {
    if (turn === seq) activity(false);
  }
}
function download(name, data, type = "application/json") {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function initAlbumBuilder() {
  wireModal("albumModal", ["albumClose", "albumCancel"]);
  onModalClose("albumModal", () => {
    ++seq;
    controller?.abort();
    target = null;
    activity(false);
  });
  $("albumDiscover").onclick = discover;
  $("albumSave").onclick = save;
  $("albumSelectAll").onclick = () => {
    draft.forEach((x) => (x.selected = true));
    render();
  };
  $("albumSelectNone").onclick = () => {
    draft.forEach((x) => (x.selected = false));
    render();
  };
  $("albumMode").onchange = () => {
    const direct = $("albumMode").value === "direct";
    draft.forEach((x) => {
      if (x.directUrl) {
        x.url = direct ? x.directUrl : x.referenceUrl;
      }
    });
    render();
  };
  $("albumExportList").onclick = () => {
    const list = draft
      .filter((x) => x.selected !== false)
      .map((x) => x.url)
      .filter(Boolean);
    download("carousel-urls.txt", list.join("\n"), "text/plain");
    status(
      "URL list exported. Direct image URLs can expire; album references rediscover the selected photo.",
    );
  };
  $("albumExportJson").onclick = () =>
    download(
      "photo-album.json",
      JSON.stringify(
        {
          version: 1,
          title: $("albumName").value,
          items: draft
            .filter((x) => x.selected !== false)
            .map(({ url, title, credit, src, natW, natH }) => ({
              url,
              title,
              credit,
              src,
              natW,
              natH,
            })),
        },
        null,
        2,
      ),
    );
  $("albumGrid").oninput = (e) => {
    const card = e.target.closest("[data-index]");
    if (!card) return;
    const item = draft[+card.dataset.index];
    if (e.target.dataset.field) {
      item[e.target.dataset.field] = e.target.value;
      if (e.target.dataset.field === "url") {
        item.importUrl = null;
        item.src = null;
        item.error = "";
        item.directUrl = null;
        item.referenceUrl = null;
      }
    } else if (e.target.dataset.action === "select") {
      item.selected = e.target.checked;
      $("albumCount").textContent =
        `${draft.filter((x) => x.selected !== false).length} selected of ${draft.length}`;
    }
  };
  $("albumGrid").onclick = (e) => {
    const b = e.target.closest("[data-action]");
    const card = e.target.closest("[data-index]");
    if (!b || !card) return;
    const i = +card.dataset.index;
    if (b.dataset.action === "enlarge") {
      const image = card.querySelector("img");
      const dialog = $("albumEnlarge");
      dialog.querySelector("img").src = image.src;
      dialog.showModal();
      return;
    }
    if (b.dataset.action === "up" && i > 0)
      [draft[i - 1], draft[i]] = [draft[i], draft[i - 1]];
    if (b.dataset.action === "down" && i < draft.length - 1)
      [draft[i + 1], draft[i]] = [draft[i], draft[i + 1]];
    if (b.dataset.action === "remove") draft.splice(i, 1);
    if (b.dataset.action !== "select") render();
  };
  let dragged = -1;
  $("albumGrid").ondragstart = (e) => {
    if (["INPUT", "BUTTON"].includes(e.target.tagName)) {
      e.preventDefault();
      return;
    }
    dragged = +e.target.closest("[data-index]").dataset.index;
  };
  $("albumGrid").ondragover = (e) => e.preventDefault();
  $("albumGrid").ondrop = (e) => {
    e.preventDefault();
    const c = e.target.closest("[data-index]");
    if (c && dragged >= 0) {
      const [item] = draft.splice(dragged, 1);
      draft.splice(+c.dataset.index, 0, item);
      dragged = -1;
      render();
    }
  };
  $("albumUploads").onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    const turn = begin();
    activity(true);
    try {
      for (const file of files) {
        if (draft.length >= ALBUM_MAX_ITEMS) break;
        const image = await prepareImage(file);
        if (turn !== seq) return;
        draft.push({
          id: crypto.randomUUID(),
          ...image,
          title: file.name,
          credit: "",
          url: "",
          selected: true,
        });
        render();
      }
      status("Uploads ready. Save to add the carousel.");
    } catch (e) {
      status(e.message);
    } finally {
      if (turn === seq) activity(false);
    }
  };
  $("albumManifest").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const turn = seq;
    try {
      if (file.size > ALBUM_MAX_BYTES + 100000)
        throw new Error("Album manifest is too large.");
      const data = JSON.parse(await file.text());
      if (turn !== seq) return;
      if (data.version !== 1) throw new Error("Unsupported album version.");
      const items = normalizeAlbum(data.items);
      draft.push(...items.map((i) => ({ ...i, selected: true })));
      if (draft.length > ALBUM_MAX_ITEMS) {
        draft.splice(ALBUM_MAX_ITEMS);
        status("Only the first 100 pictures were added.");
      } else status("Album imported.");
      $("albumName").value = data.title || "Photo album";
      render();
    } catch (e) {
      status(e.message);
    }
  };
  $("albumEnlargeClose").onclick = () => $("albumEnlarge").close();
}
