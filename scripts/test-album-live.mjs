/** Public integration canaries. Never print shared-link keys or CDN capabilities. */
import assert from "node:assert/strict";
import { discover, downloadImage } from "../worker/index.js";
const albums = [
  {
    name: "Google Photos",
    provider: "google-photos",
    url:
      process.env.ALBUM_TEST_URL ||
      "https://photos.app.goo.gl/n2MTqopAw9bjLRXKA",
    count: Number(process.env.ALBUM_TEST_COUNT || 3),
  },
  {
    name: "iCloud Photos",
    provider: "icloud-photos",
    url:
      process.env.ICLOUD_ALBUM_TEST_URL ||
      "https://photos.icloud.com/shared/album/04bbOkVUmSU7P2jQ2F2GXsW0g",
    count: Number(process.env.ICLOUD_ALBUM_TEST_COUNT || 9),
  },
];
let failed = false;
for (const album of albums) {
  let passed = false;
  for (let attempt = 0; attempt < 2 && !passed; attempt++) {
    let step = "discover album";
    try {
      const d = await discover(album.url);
      step = "verify photo count and metadata";
      assert.ok(album.count > 0 && album.count <= 100);
      assert.equal(d.items.length, album.count);
      assert.equal(new Set(d.items.map((i) => i.id)).size, album.count);
      assert.ok(
        d.items.every(
          (i) => i.provider === album.provider && i.credit && i.title,
        ),
      );
      let size = 0;
      for (const [index, item] of d.items.entries()) {
        step = `download photo ${index + 1}`;
        const { bytes, mime } = await downloadImage(item);
        assert.equal(mime, "image/jpeg");
        assert.ok(bytes.length > 100);
        size += bytes.length;
        console.log(
          `${album.name}: verified photo ${index + 1}/${d.items.length}.`,
        );
      }
      console.log(
        `${album.name} canary passed: ${d.items.length} photos; all JPEG downloads verified (${size} bytes).`,
      );
      passed = true;
    } catch (e) {
      // Third-party error strings may include signed URLs; report a safe stage.
      const detail = /^Source returned HTTP \d+\.$/.test(e.message)
        ? ` ${e.message}`
        : e.name === "TimeoutError"
          ? " Request timed out."
          : e.code === "ERR_ASSERTION"
            ? " Unexpected photo count, metadata or image bytes."
            : " Public-source request or parsing failed.";
      console.error(
        `${album.name} attempt ${attempt + 1} failed at: ${step}.${detail}`,
      );
    }
  }
  if (!passed) failed = true;
}
if (failed)
  console.error(
    "Public album canary failed. Check upstream public access, expected counts and provider parsing.",
  );
process.exitCode = failed ? 1 : 0;
