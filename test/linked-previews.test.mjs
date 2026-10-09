import test from "node:test";
import assert from "node:assert/strict";
import { Miniflare } from "miniflare";
import { mastodonPreview } from "../worker/social.js";
import { discover, downloadImage } from "../worker/index.js";

test("real HTMLRewriter extracts social preview bytes and creator attribution from escaped Open Graph tags", async () => {
  const mf = new Miniflare({
    modules: true,
    scriptPath: "test/helpers/linked-preview-worker.mjs",
    modulesRules: [{ type: "ESModule", include: ["**/*.js", "**/*.mjs"] }],
    compatibilityDate: "2026-07-30",
  });
  const fixtures = [
    {
      url: "https://x.com/maker/status/123",
      title: "A maker (@maker) on X",
      author: "@maker",
      image: "https://pbs.twimg.com/media/fixture?format=webp&amp;name=large",
    },
    {
      url: "https://bsky.app/profile/maker.example/post/fixture",
      title: "A maker (@maker.example)",
      author: "A maker (@maker.example)",
      structuredAuthor: "A maker",
      image: "https://video.bsky.app/watch/fixture/thumbnail.jpg",
    },
  ];
  try {
    for (const fixture of fixtures) {
      const page = `<meta property="og:title" content="${fixture.title}"><meta property="og:description" content="A maker project."><meta property="og:image" content="${fixture.image}">${fixture.structuredAuthor ? `<script type="application/ld+json">${JSON.stringify({ "@type": "SocialMediaPosting", author: { name: fixture.structuredAuthor } })}</script>` : ""}<script>throw new Error('must not execute');</script>`;
      const network = async (url) =>
        new URL(url).hostname === "cloudflare-dns.com"
          ? Response.json({ Answer: [{ type: 1, data: "8.8.8.8" }] })
          : new Response(page, { headers: { "content-type": "text/html" } });
      const extract = async (html, source) =>
        (
          await mf.dispatchFetch(
            "http://localhost/extract?source=" + encodeURIComponent(source),
            { method: "POST", body: html },
          )
        ).json();
      const d = await discover(fixture.url, {}, network, extract);
      assert.equal(d.fields.title, fixture.title);
      assert.equal(d.fields.description, "A maker project.");
      assert.equal(d.fields.author, fixture.author);
      assert.equal(d.items[0].credit, fixture.author);
      assert.equal(d.items[0].kind, "preview");
      assert.ok(!d.items[0].url.includes("&amp;"));
      const image = await downloadImage(d.items[0], {}, async (url) =>
        new URL(url).hostname === "cloudflare-dns.com"
          ? Response.json({ Answer: [{ type: 1, data: "8.8.8.8" }] })
          : new Response(new Uint8Array([255, 216, 255, 224]), {
              headers: { "content-type": "image/jpeg" },
            }),
      );
      assert.equal(image.mime, "image/jpeg");
    }
  } finally {
    await mf.dispose();
  }
});

const source = "https://mastodon.social/@maker/123";
function status(extra = {}) {
  return {
    id: "123",
    visibility: "public",
    content: "<p>A project &amp; a link</p>",
    account: { display_name: "Maker", acct: "maker" },
    media_attachments: [],
    ...extra,
  };
}

test("Mastodon uses the linked-card image when there is no attachment or Open Graph image", async () => {
  const d = await mastodonPreview(source, async () =>
    status({
      card: {
        title: "A linked article",
        description: "Article summary",
        url: "https://example.com/article",
        image: "https://files.mastodon.social/cache/preview_cards/fixture.png",
        width: 662,
        height: 348,
      },
    }),
  );
  assert.equal(d.items.length, 1);
  assert.equal(d.items[0].id, "123:card");
  assert.equal(d.items[0].kind, "preview");
  assert.equal(d.items[0].credit, "Maker (@maker@mastodon.social)");
  assert.equal(d.fields.title, "A linked article");
  assert.equal(d.fields.description, "A project & a link");
  assert.equal(d.fields.linkUrl, "https://example.com/article");
});

test("Mastodon attachment images and video stills take priority over unrelated link cards", async () => {
  const d = await mastodonPreview(source, async () =>
    status({
      media_attachments: [
        {
          id: "i1",
          type: "image",
          url: "https://files.mastodon.social/media/photo.jpg",
          description: "Photo caption",
          meta: { original: { width: 1000, height: 1124 } },
        },
        {
          id: "i2",
          type: "video",
          url: "https://files.mastodon.social/media/video.mp4",
          preview_url: "https://files.mastodon.social/media/still.jpg",
        },
      ],
      card: { image: "https://files.mastodon.social/cache/card.png" },
    }),
  );
  assert.deepEqual(
    d.items.map((i) => i.id),
    ["i1", "i2"],
  );
  assert.equal(d.items[0].height, 1124);
  assert.equal(d.items[0].title, "Photo caption");
  assert.ok(d.items[1].url.endsWith("still.jpg"));
});

test("Mastodon retains text-only metadata and rejects non-public or mismatched status responses", async () => {
  const d = await mastodonPreview(source, async () => status());
  assert.equal(d.items.length, 0);
  assert.ok(d.fields.title);
  assert.ok(d.warnings.length);
  for (const extra of [{ visibility: "private" }, { id: "456" }])
    await assert.rejects(
      () => mastodonPreview(source, async () => status(extra)),
      /public preview/,
    );
  assert.equal(
    await mastodonPreview("https://example.com/@maker/123", () =>
      assert.fail(),
    ),
    null,
  );
});

test("Mastodon preview adapter is integrated with Worker discovery and guarded download", async () => {
  const imageURL =
    "https://files.mastodon.social/cache/preview_cards/fixture.png";
  const network = async (url) => {
    const u = new URL(url);
    if (u.hostname === "cloudflare-dns.com")
      return Response.json({ Answer: [{ type: 1, data: "8.8.8.8" }] });
    if (u.pathname.startsWith("/api/v1/statuses/"))
      return Response.json(
        status({ card: { title: "Card", image: imageURL } }),
      );
    assert.equal(url, imageURL);
    return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
      headers: { "content-type": "image/png" },
    });
  };
  const d = await discover(source, {}, network);
  assert.equal(d.items[0].provider, "mastodon");
  assert.equal(
    (await downloadImage(d.items[0], {}, network)).mime,
    "image/png",
  );
});
