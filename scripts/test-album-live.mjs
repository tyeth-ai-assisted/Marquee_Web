/** Public integration canary. Never print shared-link keys or CDN capabilities. */
import assert from "node:assert/strict";
import { googleAlbum, rasterType } from "../worker/discovery.js";
import { bounded } from "../worker/index.js";
const album =
  process.env.ALBUM_TEST_URL || "https://photos.app.goo.gl/n2MTqopAw9bjLRXKA";
const expected = Number(process.env.ALBUM_TEST_COUNT || 3);
let error;
for (let attempt = 0; attempt < 2; attempt++) {
  try {
    const r = await fetch(album, { signal: AbortSignal.timeout(30000) });
    assert.equal(r.status, 200, "Album page did not return HTTP 200");
    const html = new TextDecoder().decode(await bounded(r, 2 * 1024 * 1024));
    const d = googleAlbum(html, r.url);
    assert.ok(d, "No photo records extracted");
    assert.equal(
      d.items.length,
      expected,
      "Public test album photo count changed",
    );
    const image = await fetch(d.items[0].url.split("=")[0] + "=w800-h800", {
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(image.status, 200, "Resized photo did not return HTTP 200");
    const bytes = await bounded(image, 4 * 1024 * 1024);
    assert.ok(rasterType(bytes), "Download is not a supported raster image");
    assert.ok(bytes.length > 100, "Image download is unexpectedly small");
    console.log(
      `Public album canary passed: ${d.items.length} records; resized ${rasterType(bytes)} (${bytes.length} bytes).`,
    );
    process.exit(0);
  } catch (e) {
    error = e;
    console.error(`Attempt ${attempt + 1}: ${e.message}`);
  }
}
console.error(
  "Public album canary failed. Check upstream access, fixture count and callback parsing.",
);
process.exit(1);
