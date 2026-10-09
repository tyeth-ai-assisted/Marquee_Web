import test from "node:test";
import assert from "node:assert/strict";
import { Miniflare } from "miniflare";
import { sign } from "../worker/index.js";
const secret = "runtime-test-only-secret-at-least-32-characters";
test("real Worker HTMLRewriter discovers previews, picture sources, lazy HTML and structured data", async () => {
  const mf = new Miniflare({
    modules: true,
    scriptPath: "test/helpers/album-worker.mjs",
    modulesRules: [{ type: "ESModule", include: ["**/*.js", "**/*.mjs"] }],
    compatibilityDate: "2026-07-30",
    bindings: { IMPORT_SECRET: secret },
  });
  try {
    const r = await mf.dispatchFetch("http://localhost/test/extract", {
      method: "POST",
      body: `<title>Gallery &amp; art</title><meta property="og:title" content="A maker"><meta name="author" content="@maker"><meta property="og:image" content="/preview.jpg"><script type="application/ld+json">{"@type":"ImageObject","contentUrl":"/art.jpg"}</script><picture><source srcset="/small.webp 100w, /large.webp 800w" type="image/webp"><img src="/fallback.jpg" alt="Picture"></picture><img data-src="/lazy.jpg"><meta itemprop="contentUrl" content="/micro.jpg">`,
    });
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.items.length, 5);
    assert.ok(d.items.find((i) => i.url.endsWith("/large.webp")));
    assert.equal(d.items[0].credit, "@maker");
    const bad = await mf.dispatchFetch(
      "http://localhost/api/albums/image?token=invalid",
    );
    assert.equal(bad.status, 400);
    const expired = await sign(
      { url: "https://example.com/x.jpg", exp: 1 },
      secret,
    );
    assert.equal(
      (
        await mf.dispatchFetch(
          "http://localhost/api/albums/image?token=" + expired,
        )
      ).status,
      400,
    );
    const invalid = await mf.dispatchFetch(
      "http://localhost/api/albums/discover",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "http://127.0.0.1" }),
      },
    );
    assert.equal(invalid.status, 400);
  } finally {
    await mf.dispose();
  }
});
