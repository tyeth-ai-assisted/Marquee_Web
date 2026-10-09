import test from "node:test";
import assert from "node:assert/strict";
import { Miniflare, createFetchMock } from "miniflare";
import { icloudAlbum } from "../worker/icloud.js";
import { discover, downloadImage, remote } from "../worker/index.js";
import { albumReference } from "../worker/discovery.js";

const album = "https://photos.icloud.com/shared/album/fixturePublicAlbum";
const value = (value) => ({ value });
const asset = (id, master = id) => ({
  recordType: "CPLAsset",
  recordName: id,
  fields: { masterRef: value({ recordName: "master-" + master }) },
});
const master = (id, extra = {}) => ({
  recordType: "CPLMaster",
  recordName: "master-" + id,
  fields: {
    filenameEnc: value(Buffer.from("Photo " + id + ".HEIC").toString("base64")),
    resOriginalFileType: value("public.heic"),
    resOriginalRes: value({
      downloadURL: "https://cvws.icloud-content.com/original.heic",
    }),
    resJPEGMedRes: value({
      downloadURL: `https://cvws.icloud-content.com/${id}.jpg?temporary=fixture`,
    }),
    resJPEGMedWidth: value(1536),
    resJPEGMedHeight: value(2048),
    ...extra,
  },
});
function fixture(records = [master("b"), master("a"), asset("a"), asset("b")]) {
  return {
    resolve: {
      results: [
        {
          databaseScope: "SHARED",
          zoneID: { zoneName: "SharedCollection-fixture" },
          anonymousPublicAccess: {
            token: "public-fixture-only",
            databasePartition: "https://p192-ckdatabasews.icloud.com:443",
          },
          ownerIdentity: {
            nameComponents: { givenName: "Album", familyName: "Owner" },
            lookupInfo: { emailAddress: "private@example.com" },
          },
          share: {
            fields: { "cloudkit.title": value("Test album") },
            participants: [
              {
                userIdentity: {
                  userRecordName: "contributor",
                  nameComponents: { givenName: "Photo", familyName: "Maker" },
                },
              },
            ],
          },
        },
      ],
    },
    query: { records },
  };
}
function reader(f, calls = []) {
  return async (url, body) => {
    calls.push({ url: new URL(url), body });
    return url.includes("/resolve?") ? f.resolve : f.query;
  };
}
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
function fetcher(f, downloads = []) {
  return async (url, init) => {
    const u = new URL(url);
    if (u.hostname === "cloudflare-dns.com")
      return Response.json({ Answer: [{ type: 1, data: "8.8.8.8" }] });
    if (u.hostname.endsWith("ckdatabasews.icloud.com")) {
      assert.equal(init.method, "POST");
      assert.equal(init.credentials, "omit");
      return Response.json(
        u.pathname.endsWith("/resolve") ? f.resolve : f.query,
      );
    }
    downloads.push(u.pathname);
    return new Response(png, {
      headers: { "Content-Type": "application/octet-stream" },
    });
  };
}

test("iCloud reads all photos, pairs masters by ID, prefers JPEGs, and preserves order and attribution", async () => {
  const f = fixture(),
    calls = [];
  const a = f.query.records[2];
  a.fields.captionEnc = value(Buffer.from("Café display").toString("base64"));
  a.created = { userRecordName: "contributor" };
  const d = await icloudAlbum(album, reader(f, calls));
  assert.equal(d.title, "Test album");
  assert.equal(d.completeness, "complete");
  assert.deepEqual(
    d.items.map((i) => i.id),
    ["a", "b"],
  );
  assert.equal(d.items[0].title, "Café display");
  assert.equal(d.items[0].credit, "Photo Maker");
  assert.equal(d.items[1].credit, "Album Owner");
  assert.equal(d.items[0].height, 2048);
  assert.ok(d.items[0].url.includes("/a.jpg"));
  assert.equal(calls[0].url.hostname, "ckdatabasews.icloud.com");
  assert.equal(
    calls[1].url.searchParams.get("publicAccessAuthToken"),
    "public-fixture-only",
  );
  assert.equal(calls[1].body.query.recordType, "CPLAssetAndMasterByAddedDate");
  assert.ok(!JSON.stringify(d).includes("private@example.com"));
  assert.ok(!JSON.stringify(d).includes("public-fixture-only"));
});

test("iCloud ignores unrelated URLs and rejects inaccessible albums without trying to join them", async () => {
  let calls = 0;
  assert.equal(
    await icloudAlbum(
      "https://example.com/shared/album/fixturePublicAlbum",
      () => calls++,
    ),
    null,
  );
  assert.equal(calls, 0);
  for (const change of [
    (s) => (s.requireAppleLogin = true),
    (s) => delete s.anonymousPublicAccess,
    (s) => (s.databaseScope = "PRIVATE"),
  ]) {
    const f = fixture(),
      req = [];
    change(f.resolve.results[0]);
    await assert.rejects(
      () => icloudAlbum(album, reader(f, req)),
      /public viewing/,
    );
    assert.equal(req.length, 1);
  }
  const f = fixture();
  f.query = { serverErrorCode: "ACCESS_DENIED" };
  await assert.rejects(
    () => icloudAlbum(album, reader(f)),
    /did not return album photos/,
  );
});

test("iCloud rejects untrusted partition hosts and hides provider errors containing public access tokens", async () => {
  for (const partition of [
    "https://evil.example",
    "http://p192-ckdatabasews.icloud.com",
    "https://ckdatabasews.icloud.com.evil.example",
  ]) {
    const f = fixture(),
      calls = [];
    f.resolve.results[0].anonymousPublicAccess.databasePartition = partition;
    await assert.rejects(
      () => icloudAlbum(album, reader(f, calls)),
      /unsupported album server/,
    );
    assert.equal(calls.length, 1);
  }
  await assert.rejects(
    () =>
      icloudAlbum(album, () => {
        throw new Error("secret URL");
      }),
    (e) => e.message.includes("Retry") && !e.message.includes("secret"),
  );
});

test("iCloud reports unavailable renditions and bounded albums as partial, and omits deleted photos", async () => {
  const f = fixture();
  f.query.records[2].deleted = true;
  f.query.records[0].fields.resJPEGMedRes = value({
    downloadURL: "https://evil.example/image.jpg",
  });
  const d = await icloudAlbum(album, reader(f));
  assert.equal(d.items.length, 0);
  assert.equal(d.completeness, "partial");
  const large = fixture(
    Array.from({ length: 101 }, (_, i) => [
      master(String(i)),
      asset(String(i)),
    ]).flat(),
  );
  const result = await icloudAlbum(album, reader(large));
  assert.equal(result.items.length, 100);
  assert.equal(result.completeness, "partial");
  const paged = fixture();
  paged.query.continuationMarker = "more";
  assert.equal(
    (await icloudAlbum(album, reader(paged))).completeness,
    "partial",
  );
});

test("Worker discovers iCloud and resolves stable album IDs after reordering, including binary-typed JPEG/PNG copies", async () => {
  const f = fixture(),
    downloads = [],
    network = fetcher(f, downloads);
  const d = await discover(album, {}, network);
  assert.equal(d.items.length, 2);
  const selected = albumReference(album, 0, "b");
  const image = await downloadImage({ url: selected }, {}, network);
  assert.equal(image.mime, "image/png");
  assert.deepEqual(downloads, ["/b.jpg"]);
  assert.equal((await discover(d.items[0].url, {}, network)).items.length, 1);
  await assert.rejects(
    () =>
      downloadImage({ url: albumReference(album, 0, "removed") }, {}, network),
    /not found/,
  );
});

test("binary content requires image signatures and provider POSTs never follow redirects", async () => {
  const bad = async (url) =>
    url.includes("cloudflare-dns.com")
      ? Response.json({ Answer: [{ type: 1, data: "8.8.8.8" }] })
      : new Response("<html>not a photo</html>", {
          headers: { "content-type": "application/octet-stream" },
        });
  await assert.rejects(
    () => downloadImage({ url: "https://example.com/a" }, {}, bad),
    /supported raster/,
  );
  const calls = [];
  await assert.rejects(
    () =>
      remote(
        "https://ckdatabasews.icloud.com/resolve",
        {},
        async (url) => {
          calls.push(url);
          return url.includes("cloudflare-dns.com")
            ? Response.json({ Answer: [{ type: 1, data: "8.8.8.8" }] })
            : new Response(null, {
                status: 307,
                headers: { location: "https://evil.example" },
              });
        },
        { shortGUIDs: [] },
      ),
    /redirects/,
  );
  assert.equal(calls.length, 2);
});

test("actual Worker signs iCloud discoveries and serves octet-stream photos with verified image MIME", async () => {
  const f = fixture(),
    mock = createFetchMock();
  mock.disableNetConnect();
  mock
    .get("https://cloudflare-dns.com")
    .intercept({ path: /.*/ })
    .reply(200, { Answer: [{ type: 1, data: "8.8.8.8" }] })
    .persist();
  mock
    .get("https://ckdatabasews.icloud.com")
    .intercept({ path: /.*/, method: "POST" })
    .reply(200, f.resolve);
  mock
    .get("https://p192-ckdatabasews.icloud.com")
    .intercept({ path: /.*/, method: "POST" })
    .reply(200, f.query);
  mock
    .get("https://cvws.icloud-content.com")
    .intercept({ path: /.*/ })
    .reply(200, png, {
      headers: { "content-type": "application/octet-stream" },
    });
  const mf = new Miniflare({
    modules: true,
    scriptPath: "worker/index.js",
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    compatibilityDate: "2026-07-30",
    bindings: { IMPORT_SECRET: "fixture-import-secret-at-least-32-characters" },
    fetchMock: mock,
  });
  try {
    const r = await mf.dispatchFetch("http://localhost/api/albums/discover", {
      method: "POST",
      body: JSON.stringify({ url: album }),
    });
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.items.length, 2);
    const image = await mf.dispatchFetch(
      "http://localhost" + d.items[0].importUrl,
    );
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  } finally {
    await mf.dispose();
    await mock.close();
  }
});
