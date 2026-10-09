import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAlbum,
  playbackIndex,
  captionFor,
} from "../public/js/core/album.js";
import { sameDesign } from "../public/js/core/samples.js";
import { validateCanvasDoc, fitDoc } from "../public/js/core/canvasimport.js";
import {
  discoverRecords,
  googleAlbum,
  manifest,
  reference,
  albumReference,
  publicURL,
} from "../worker/discovery.js";
import { sign, verify, publicIPv4, bounded, remote } from "../worker/index.js";
const src = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
const items = [
  {
    id: "a",
    url: "https://example.com/a.jpg",
    src,
    title: "Nebula",
    credit: "NASA",
  },
  { id: "b", url: "https://example.com/b.jpg", src },
];
test("album validates embedded fallback, ID uniqueness and storage budget", () => {
  assert.equal(normalizeAlbum(items)[0].credit, "NASA");
  assert.notEqual(
    normalizeAlbum([items[0], items[0]])[0].id,
    normalizeAlbum([items[0], items[0]])[1].id,
  );
  assert.throws(() => normalizeAlbum([{ url: "javascript:alert(1)" }]));
  assert.throws(() =>
    normalizeAlbum([{ src: "data:image/svg+xml;base64,PHN2Zz4=" }]),
  );
  assert.throws(
    () =>
      normalizeAlbum([{ src: "data:image/png;base64," + "A".repeat(400000) }]),
    /large/,
  );
});
test("playback waits, pauses, avoids missed-frame burst and shuffle repeats no slides", () => {
  assert.equal(
    playbackIndex(items, { index: 0, shownAt: 1000, interval: 60 }, 60000),
    0,
  );
  assert.equal(
    playbackIndex(items, { index: 0, shownAt: 1000, interval: 60 }, 61000),
    1,
  );
  assert.equal(
    playbackIndex(items, { index: 0, shownAt: 1000, paused: true }, 1e9),
    0,
  );
  assert.equal(playbackIndex(items, { index: 0, shownAt: 1000 }, 1e9), 1);
  const many = [1, 2, 3, 4, 5];
  let i = 0;
  const visited = new Set();
  for (let n = 0; n < 5; n++) {
    visited.add(i);
    i = playbackIndex(
      many,
      { index: i, shownAt: 1, interval: 60, order: "shuffle", seed: 123 },
      61000,
    );
  }
  assert.equal(visited.size, 5);
  assert.equal(playbackIndex([], {}), -1);
  assert.equal(captionFor(items[0]), "Nebula · NASA");
});
test("carousel playback is a sample, membership and attribution are authored; import fits frame", () => {
  const el = {
    etype: "carousel",
    x: 0,
    y: 0,
    w: 100,
    h: 50,
    items,
    src,
    slideIndex: 0,
    shownAt: 1,
    showCaption: true,
  };
  assert.ok(
    sameDesign(
      { elements: [el] },
      { elements: [{ ...el, slideIndex: 1, src: null, shownAt: 500 }] },
    ),
  );
  assert.ok(
    !sameDesign(
      { elements: [el] },
      { elements: [{ ...el, showCaption: false }] },
    ),
  );
  const result = validateCanvasDoc(
    JSON.stringify({ version: 1, elements: [el] }),
  );
  assert.ok(result.ok);
  assert.equal(
    fitDoc(result.doc, { w: 100, h: 50 }, { w: 200, h: 100 }).elements[0].w,
    200,
  );
  assert.ok(
    !validateCanvasDoc(
      JSON.stringify({
        elements: [{ ...el, items: [{ url: "data:text/html,bad" }] }],
      }),
    ).ok,
  );
});
test("page combines Open Graph, linked Schema.org graphs, Microdata, RDFa and responsive HTML", () => {
  const result = discoverRecords({
    source: "https://example.com/gallery",
    records: [
      { tag: "base", href: "/photos/" },
      { tag: "meta", property: "og:title", content: "Collection" },
      { tag: "meta", property: "twitter:creator", content: "@maker" },
      { tag: "meta", property: "og:image", content: "cover.jpg" },
      { tag: "meta", property: "og:image:width", content: "600" },
      {
        tag: "img",
        src: "small.jpg",
        srcset: "small.jpg 100w, large.jpg 800w",
        alt: "Landscape",
      },
      { tag: "img", src: "large.jpg" },
      { tag: "meta", itemprop: "contentUrl", content: "micro.jpg" },
      { tag: "a", property: "schema:contentUrl", href: "rdfa.jpg" },
      { tag: "meta", property: "og:image", content: "javascript:bad" },
    ],
    scripts: [
      JSON.stringify({
        "@graph": [
          {
            "@id": "#one",
            "@type": "ImageObject",
            contentUrl: "art.jpg",
            creditText: "Artist",
          },
          {
            "@type": "ItemList",
            itemListElement: [{ position: 1, item: { "@id": "#one" } }],
          },
        ],
      }),
      "{broken",
    ],
  });
  assert.equal(result.items.length, 5);
  assert.equal(result.items[0].width, 600);
  assert.equal(result.fields.author, "@maker");
  assert.ok(result.items.every((i) => i.credit));
  assert.ok(
    result.items.some((i) => i.url === "https://example.com/photos/large.jpg"),
  );
  assert.ok(!result.items.some((i) => i.url.endsWith("small.jpg")));
});
test("single preview is a useful item with title attribution", () => {
  const d = discoverRecords({
    source: "https://x.com/maker/status/123",
    records: [
      { tag: "meta", property: "og:title", content: "Maker on X: hello" },
      {
        tag: "meta",
        property: "og:image",
        content: "https://example.com/preview.jpg",
      },
      { tag: "meta", name: "author", content: "Maker" },
    ],
  });
  assert.equal(d.items.length, 1);
  assert.equal(d.items[0].title, "Maker on X: hello");
  assert.equal(d.items[0].credit, "Maker");
});
test("Google callback reads only photo records, not cover and avatar; never executes JS", () => {
  const rows = [
    ["p1", ["https://lh3.googleusercontent.com/pw/one", 800, 600]],
    ["p2", ["https://lh3.googleusercontent.com/pw/two", 600, 800]],
  ];
  const html = `<script>AF_initDataCallback({key: 'ds:1', hash:'2', data:${JSON.stringify([null, rows])}, sideChannel: {}});</script>`;
  const d = googleAlbum(html, "https://photos.google.com/share/example");
  assert.deepEqual(
    d.items.map((i) => i.id),
    ["p1", "p2"],
  );
  assert.equal(d.items[1].height, 800);
  assert.equal(
    googleAlbum(
      "AF_initDataCallback({key: 'x', data:evil(), sideChannel: {}})",
      "https://example.com",
    ),
    null,
  );
});
test("manifest and special references preserve selected provider ID", () => {
  const u = albumReference("https://example.com/album", 2, "photo + 3");
  assert.equal(reference(u).id, "photo + 3");
  assert.equal(reference(u).index, 2);
  assert.throws(() => reference("https://example.com#marquee-photo=0"));
  assert.equal(
    manifest({ version: 1, items: ["a.jpg"] }, "https://example.com/list.json")
      .items[0].url,
    "https://example.com/a.jpg",
  );
});
test("URL and address guards reject credentials, local names, IP literals and non-public DNS", () => {
  for (const u of [
    "http://localhost/a",
    "http://127.0.0.1",
    "http://2130706433",
    "http://[::1]",
    "https://a:b@example.com",
    "file:///tmp/x",
    "http://a.local",
    "http://example.com:8080",
  ])
    assert.throws(() => publicURL(u));
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.20.1.2",
    "192.168.0.1",
    "100.64.0.1",
    "169.254.1.1",
    "198.18.0.1",
    "203.0.113.1",
  ])
    assert.ok(!publicIPv4(ip));
  assert.ok(publicIPv4("8.8.8.8"));
});
test("signed imports reject tampering and expiry", async () => {
  const secret = "test-only-secret-32-characters-minimum";
  const token = await sign(
    { url: "https://example.com/a.jpg", exp: 1000 },
    secret,
  );
  assert.equal(
    (await verify(token, secret, 999)).url,
    "https://example.com/a.jpg",
  );
  await assert.rejects(() => verify(token, secret, 1001));
  await assert.rejects(() => verify(token + "x", secret, 999));
});
test("bounded streaming refuses oversized bodies without trusting Content-Length", async () => {
  await assert.rejects(() => bounded(new Response("123456"), 5));
  assert.equal((await bounded(new Response("12345"), 5)).length, 5);
});
test("remote revalidates redirects and rejects private DNS before fetching", async () => {
  let calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url.startsWith("https://cloudflare-dns.com"))
      return Response.json({ Answer: [{ type: 1, data: "8.8.8.8" }] });
    return new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/internal" },
    });
  };
  await assert.rejects(() => remote("https://example.com", {}, fetcher));
  assert.equal(calls.length, 2);
  await assert.rejects(
    () =>
      remote("https://example.com", {}, async () =>
        Response.json({ Answer: [{ type: 1, data: "10.0.0.1" }] }),
      ),
    /public/,
  );
});
test("NASA collections and Flickr albums supply credit, order and partial status through official adapters", async () => {
  const { providerCollection } = await import("../worker/providers.js");
  const nasa = await providerCollection(
    "https://images.nasa.gov/search?q=nebula",
    {},
    async () => ({
      collection: {
        items: [
          {
            data: [
              {
                media_type: "image",
                nasa_id: "n1",
                title: "Nebula",
                center: "GSFC",
              },
            ],
            links: [{ render: "image", href: "https://example.com/n.jpg" }],
          },
        ],
        links: [{ rel: "next" }],
      },
    }),
  );
  assert.equal(nasa.items[0].credit, "NASA GSFC");
  assert.equal(nasa.completeness, "partial");
  let calls = 0;
  const flickr = await providerCollection(
    "https://www.flickr.com/photos/maker/albums/123",
    { FLICKR_API_KEY: "test-only" },
    async () =>
      ++calls === 1
        ? { stat: "ok", user: { id: "42@N00" } }
        : {
            stat: "ok",
            photoset: {
              title: "Maker album",
              ownername: "Maker",
              pages: 1,
              photo: [
                {
                  id: "f1",
                  title: "Board",
                  url_m: "https://example.com/f.jpg",
                },
              ],
            },
          },
  );
  assert.equal(flickr.items[0].credit, "Maker");
  assert.equal(calls, 2);
  await assert.rejects(
    () =>
      providerCollection(
        "https://www.flickr.com/photos/maker/albums/123",
        {},
        async () => {},
      ),
    /API_KEY/,
  );
});
