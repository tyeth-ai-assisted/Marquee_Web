/** Public link previews: metadata AND actual image bytes, without source URL logs. */
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { discover, downloadImage } from "../worker/index.js";
const sources = JSON.parse(
  await readFile(
    new URL("../test/fixtures/linked-card-sources.json", import.meta.url),
    "utf8",
  ),
);
const only = process.argv.slice(2);
if (only.some((id) => !sources.some((s) => s.id === id))) {
  console.error(
    "Use a fixture ID from test/fixtures/linked-card-sources.json or omit selectors to test all previews.",
  );
  process.exit(1);
}
const mf = new Miniflare({
  // Repo-relative under rootPath: URL pathnames gain a stray slash on Windows
  // and workerd rejects absolute module roots there.
  rootPath: fileURLToPath(new URL("..", import.meta.url)),
  modules: true,
  scriptPath: "test/helpers/linked-preview-worker.mjs",
  modulesRules: [{ type: "ESModule", include: ["**/*.js", "**/*.mjs"] }],
  compatibilityDate: "2026-07-30",
});
const extract = async (html, source) => {
  const r = await mf.dispatchFetch(
    "http://localhost/extract?source=" + encodeURIComponent(source),
    { method: "POST", body: html },
  );
  assert.equal(r.status, 200);
  return r.json();
};
let failed = false;
try {
  for (const source of sources.filter(
    (s) => !only.length || only.includes(s.id),
  )) {
    let passed = false;
    for (let attempt = 0; attempt < 2 && !passed; attempt++) {
      let stage = "discover metadata";
      try {
        const d = await discover(source.url, {}, fetch, extract);
        stage = "check title and author";
        assert.ok(d.fields.title);
        assert.ok(d.fields.author.includes(source.authorIncludes));
        stage = "find the post image or linked preview (not a logo/avatar)";
        const images = d.items.filter((item) => {
          const u = new URL(item.url);
          return (
            item.kind === "preview" &&
            u.hostname === source.imageHost &&
            u.pathname.startsWith(source.imagePathPrefix)
          );
        });
        assert.ok(images.length >= source.minimumImages);
        for (const [index, item] of images.entries()) {
          stage = `download preview ${index + 1}`;
          const { mime, bytes } = await downloadImage(item);
          assert.ok(
            ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(
              mime,
            ),
          );
          assert.ok(bytes.length > 100);
          if (process.env.PREVIEW_TEST_OUTPUT_DIR) {
            await mkdir(process.env.PREVIEW_TEST_OUTPUT_DIR, {
              recursive: true,
            });
            await writeFile(
              join(
                process.env.PREVIEW_TEST_OUTPUT_DIR,
                `${source.id}-${index + 1}.${mime.split("/")[1]}`,
              ),
              bytes,
            );
          }
          console.log(
            `${source.name}: verified preview ${index + 1} (${mime}, ${bytes.length} bytes).`,
          );
        }
        passed = true;
        console.log(
          `${source.name}: title, attribution and preview checks passed.`,
        );
      } catch (e) {
        const reason =
          e.name === "TimeoutError"
            ? "Request timed out."
            : e.code === "ERR_ASSERTION"
              ? "Expected metadata or image is missing."
              : "Public source request or parsing failed.";
        console.error(
          `${source.name}, attempt ${attempt + 1}: ${stage}. ${reason}`,
        );
      }
    }
    if (!passed) failed = true;
  }
} finally {
  await mf.dispose();
}
process.exitCode = failed ? 1 : 0;
