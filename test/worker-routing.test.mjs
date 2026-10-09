import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index.js";
const secret = "routing-test-only-secret-at-least-32-characters";
test("one Worker serves the app from assets and the importer under /api/albums/", async () => {
  const served = [];
  const env = {
    IMPORT_SECRET: secret,
    ASSETS: { fetch: async (r) => (served.push(new URL(r.url).pathname), new Response("app")) },
  };
  for (const path of ["/", "/index.html", "/js/core/album.js", "/api/other"]) {
    const r = await worker.fetch(new Request("https://example.test" + path), env);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "app");
  }
  assert.deepEqual(served, ["/", "/index.html", "/js/core/album.js", "/api/other"]);
  const api = await worker.fetch(new Request("https://example.test/api/albums/nope"), env);
  assert.equal(api.status, 404);
  assert.equal((await api.json()).error, "Not found.");
  assert.equal(api.headers.get("access-control-allow-origin"), "https://example.test");
});
test("without an assets binding only the importer exists, and it still reports a missing secret", async () => {
  const page = await worker.fetch(new Request("https://example.test/"), {});
  assert.equal(page.status, 404);
  const api = await worker.fetch(new Request("https://example.test/api/albums/discover", { method: "POST" }), {});
  assert.equal(api.status, 503);
  assert.match((await api.json()).error, /IMPORT_SECRET/);
});
