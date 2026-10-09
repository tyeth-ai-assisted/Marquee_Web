import test from "node:test";
import assert from "node:assert/strict";
import { flickrPhotostream } from "../worker/flickr.js";
import { providerCollection } from "../worker/providers.js";
import { discover, downloadImage } from "../worker/index.js";
import { albumReference } from "../worker/discovery.js";

const source = "https://www.flickr.com/photos/12345@N01/";
const short = "https://flic.kr/ps/fixture";
const wrap = (data, exportMetaType = "model") => ({ data, exportMetaType });
const size = (url, width, height) => wrap({ url, width, height }, "pojo");
const photo = (id) =>
  wrap({
    _flickrModelRegistry: "photo-models",
    id: String(id),
    title: `Photo ${id} with } and \\"quote\\"`,
    owner: wrap("~0"),
    license: 4,
    sizes: wrap(
      {
        sq: size("//live.staticflickr.com/1/square.jpg", 75, 75),
        m: size(`//live.staticflickr.com/1/${id}_medium.jpg`, 500, 300),
        h: size(`//live.staticflickr.com/1/${id}_large.jpg`, 1600, 960),
        o: size(`//live.staticflickr.com/1/${id}_original.png`, 6000, 3600),
      },
      "pojo",
    ),
  });
function fixture(rows = [photo(301), photo(302)]) {
  return {
    legend: [["photostream-models", "0", "data", "owner", "data"]],
    main: {
      "photostream-models": [
        wrap({
          owner: wrap({
            id: "12345@N01",
            username: "maker",
            realname: "Maker Name",
          }),
          photoPageList: wrap({
            _data: rows,
            totalItems: rows.length,
            fetchedStart: true,
            fetchedEnd: true,
          }),
        }),
      ],
      "photo-models": [photo(999)],
    },
  };
}
const html = (model) =>
  `<script>window.neverExecuteThis(); app({modelExport: ${JSON.stringify(model)}, after: function(){throw 'no';}});</script>`;

test("Flickr photostream parses only JSON, follows model references and preserves collection order and attribution", () => {
  const d = flickrPhotostream(html(fixture()), source);
  assert.deepEqual(
    d.items.map((i) => i.id),
    ["301", "302"],
  );
  assert.equal(d.items[0].credit, "Maker Name");
  assert.equal(d.items[0].license, 4);
  assert.equal(d.items[0].width, 1600);
  assert.ok(d.items[0].url.endsWith("301_large.jpg"));
  assert.ok(d.items[0].title.includes("}"));
  assert.equal(d.completeness, "complete");
  assert.equal(
    flickrPhotostream(html(fixture()), "https://example.com/photos/12345@N01/"),
    null,
  );
});

test("Flickr partial pages, unavailable sizes and larger streams are labelled incomplete", () => {
  const f = fixture();
  f.main["photostream-models"][0].data.photoPageList.data.fetchedEnd = false;
  assert.equal(flickrPhotostream(html(f), source).completeness, "partial");
  const bad = photo(301);
  bad.data.sizes = wrap({
    m: size("https://evil.example/photo.jpg", 800, 600),
  });
  const d = flickrPhotostream(html(fixture([bad, photo(302)])), source);
  assert.deepEqual(
    d.items.map((i) => i.id),
    ["302"],
  );
  assert.equal(d.completeness, "partial");
  const large = flickrPhotostream(
    html(fixture(Array.from({ length: 101 }, (_, i) => photo(i)))),
    source,
  );
  assert.equal(large.items.length, 100);
  assert.equal(large.completeness, "partial");
});

test("Flickr malformed, cyclic and prototype-path model references fail safely", () => {
  assert.throws(
    () =>
      flickrPhotostream(
        "<script>modelExport: {main: execute()}</script>",
        source,
      ),
    /public photo list/,
  );
  const cycle = fixture();
  cycle.main["photostream-models"] = [wrap("~0")];
  cycle.legend = [["photostream-models", "0"]];
  assert.throws(
    () => flickrPhotostream(html(cycle), source),
    /public photo list/,
  );
  const proto = fixture();
  proto.main["photostream-models"] = [wrap("~0")];
  proto.legend = [["__proto__", "stream"]];
  assert.throws(
    () => flickrPhotostream(html(proto), source),
    /public photo list/,
  );
});

test("Flickr API supports public photostreams as well as albums when a key is configured", async () => {
  const methods = [];
  const d = await providerCollection(
    source,
    { FLICKR_API_KEY: "fixture" },
    async (url) => {
      const u = new URL(url);
      methods.push(u.searchParams.get("method"));
      return methods.length === 1
        ? { stat: "ok", user: { id: "12345@N01" } }
        : {
            stat: "ok",
            photos: {
              pages: 2,
              photo: [
                {
                  id: "301",
                  title: "Photo",
                  ownername: "Maker",
                  url_l: "https://live.staticflickr.com/1/301_large.jpg",
                },
              ],
            },
          };
    },
  );
  assert.deepEqual(methods, [
    "flickr.urls.lookupUser",
    "flickr.people.getPublicPhotos",
  ]);
  assert.equal(d.items[0].credit, "Maker");
  assert.equal(d.completeness, "partial");
  assert.equal(
    await providerCollection(source, {}, () =>
      assert.fail("No API key means page discovery"),
    ),
    null,
  );
});

test("Flickr short URLs use final photostream discovery and stable IDs resolve after reordering", async () => {
  const downloads = [];
  const network = async (url) => {
    const u = new URL(url);
    if (u.hostname === "cloudflare-dns.com")
      return Response.json({ Answer: [{ type: 1, data: "8.8.8.8" }] });
    if (u.hostname === "flic.kr")
      return new Response(null, { status: 302, headers: { location: source } });
    if (u.hostname === "www.flickr.com")
      return new Response(html(fixture([photo(302), photo(301)])), {
        headers: { "content-type": "text/html" },
      });
    downloads.push(u.pathname);
    return new Response(new Uint8Array([255, 216, 255, 224]), {
      headers: { "content-type": "image/jpeg" },
    });
  };
  const d = await discover(short, {}, network);
  assert.equal(d.items.length, 2);
  assert.equal(d.items[0].source, source);
  const image = await downloadImage(
    { url: albumReference(short, 0, "301") },
    {},
    network,
  );
  assert.equal(image.mime, "image/jpeg");
  assert.deepEqual(downloads, ["/1/301_large.jpg"]);
});

test("Flickr short URLs are re-dispatched to the configured album API after redirects", async () => {
  const canonical = source + "albums/123/";
  let calls = 0;
  const d = await discover(
    short,
    { FLICKR_API_KEY: "fixture" },
    async (url) => {
      const u = new URL(url);
      if (u.hostname === "cloudflare-dns.com")
        return Response.json({ Answer: [{ type: 1, data: "8.8.8.8" }] });
      if (u.hostname === "flic.kr")
        return new Response(null, {
          status: 302,
          headers: { location: canonical },
        });
      if (u.hostname === "www.flickr.com")
        return new Response("<html>Album</html>", {
          headers: { "content-type": "text/html" },
        });
      return Response.json(
        ++calls === 1
          ? { stat: "ok", user: { id: "12345@N01" } }
          : {
              stat: "ok",
              photoset: {
                title: "Album",
                pages: 1,
                photo: [
                  {
                    id: "301",
                    url_m: "https://live.staticflickr.com/1/301.jpg",
                  },
                ],
              },
            },
      );
    },
  );
  assert.equal(d.title, "Album");
  assert.equal(d.items[0].provider, "flickr");
  assert.equal(calls, 2);
});
