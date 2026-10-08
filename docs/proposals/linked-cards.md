# Open Graph and linked cards

Follow-up to [photo albums and carousel frames, PR #5](https://github.com/tyeth-ai-assisted/Marquee_Web/pull/5), stacked on `feature/photo-albums`. The three Google Photos, iCloud Photos and Flickr collection fixtures stay in the image importer job. Social posts belong to this follow-up, and their preview images must work as downloadable images as well as providing text for future cards.

## Scope of this draft

This draft establishes the source fixtures, preview extraction fixes, Mastodon attachment/link-card image fallback, and nightly image-download checks. It does **not yet add the linked-card editor/widget or JSON template binding UI**. Those remain the implementation steps below. The existing image importer/carousel can use the preview images provided by these changes.

## User experience and data

Paste a public webpage or social-post URL to preview its title, description or post text, author/username and image. Offer a linked card with those fields, or an image-only frame/carousel entry. Title and author attribution are shown by default for every source, with a switch to hide their display while retaining the metadata in exports. A video contributes its still preview, not video playback on an e-ink display.

Reuse the Worker’s discovery and guarded byte download paths. Card rendering consumes normalized `title`, `description`, `author`, source URL and image candidates; provider-specific fields remain metadata. Prefer explicit author metadata, with recognized creator handles in social titles as a fallback. Mastodon supplies public attachment and link-card metadata via its status API, including a cached card image that its HTML may omit. API responses are restricted to public/unlisted posts, and all image requests retain the same host/DNS/redirect/size checks.

The later template editor should map named fields, including selected JSON fields, into text/image slots with defaults and a preview. Bindings should select data paths without executing source scripts, HTML or arbitrary JavaScript. A text-only page remains a useful card. An image-only entry with no image must explain that it cannot be imported as a picture; a logo or avatar does not count as the requested post image.

Crop to the display and pre-dither prepared images for best results. Image refresh failures should retain the last valid image and explain how to retry or replace the source. Card refreshes follow the existing authored-design versus sampled-content distinction, so refreshed metadata does not produce spurious edits or repeated canvas-state publications. Keep source attribution separate from image fit/cropping.

## Required social fixtures

The order below is intentional: bagder is above freediverx. The executable inventory is [`test/fixtures/linked-card-sources.json`](../../test/fixtures/linked-card-sources.json).

| Source | Exact test URL | Expected image route |
|---|---|---|
| X / Adafruit | <https://x.com/adafruit/status/2107911602292879422> | Open Graph post image from `pbs.twimg.com/media/` |
| Bluesky / Pimoroni | <https://bsky.app/profile/pimoroni.com/post/3mxenyskbe22h> | Open Graph video thumbnail from `video.bsky.app/watch/` |
| Mastodon / bagder | <https://mastodon.social/@bagder/117403995474031993> | Public status API `card.image`, cached under `files.mastodon.social/cache/preview_cards/` |
| Mastodon / freediverx | <https://mastodon.social/@freediverx/117405588561786202> | Public status API image attachment under `files.mastodon.social/media_attachments/` |

The live checks must verify a nonempty title, the expected author/username, an actual post/link-preview image from the expected location, and downloaded raster bytes. They must not pass on a platform logo, profile avatar, HTML error page, video playlist, empty metadata or merely finding an `og:image` string. X/Bluesky use the real Workers HTMLRewriter; Mastodon exercises its public status API and the same image transport. Common HTML entities in metadata URLs must be decoded once so parameters such as `&amp;name=large` work correctly.

`npm run test:previews:live` checks all four in order, retries each once and continues checking the others after a failure. Supply one or more fixture IDs to reproduce a specific failure, for example `npm run test:previews:live -- mastodon-bagder`. Optional `PREVIEW_TEST_OUTPUT_DIR` saves downloaded previews for local inspection. No raw source links, capability URLs or third-party error bodies appear in normal canary logs.

## Nightly CI and repair

The follow-up extends the existing GitHub Actions nightly workflow to run both the three album checks and these four social-preview checks, retaining separate diagnostic logs. Failure of either set opens/updates the existing repair issue and requests a Copilot fix PR when agent access and `COPILOT_AGENT_TOKEN` are configured. Nothing auto-merges. This is a GitHub CI job, with no ChatGPT scheduled task. Cron starts when the workflow is on the default branch.

Network/provider availability and public sharing are part of the live test. A deleted/private post, a changed preview, or a lost image must fail visibly; the repair should distinguish upstream availability from parser breakage. It must not bypass sign-in or turn a failing preview assertion into an unconditional skip. For deterministic PR CI, synthetic fixtures cover Open Graph decoding, creator attribution, Mastodon link-card fallback, attached images, video stills, unavailable/text-only posts and guarded downloads.

## Remaining implementation steps

1. Add the linked-card document element and editor: selectable image/text slots, source URL, show-attribution toggle (on), refresh controls and a clear text-only state.
2. Add safe field selection for generic JSON and structured metadata, previewing resolved values before adding a card.
3. Integrate layout, overflow, image fit, serialization, refresh cancellation and bitmap publishing with the existing canvas pipeline; retain the browser-running requirement until a separate publisher exists.
4. Verify the four live sources in image-only and card layouts, including narrow e-ink dimensions, reload/export/import, attribution visibility and last-good-content behavior.

Mastodon support in this draft targets `mastodon.social`; other instances can follow through host-aware adapters. Public-page scraping remains best effort. This PR proves metadata and image transport; it does not claim that the remaining card UI is already implemented.

## Verification — 8 October 2026

All four supplied sources passed live metadata and preview-download checks after fixing escaped URL parameters and preserving Bluesky's creator handle alongside its display name. The downloaded files also decoded successfully with an image decoder: X WebP 400×601, Bluesky JPEG 1920×1080, bagder PNG 662×348, and freediverx JPEG 1000×1124. The full local suite reports 382 passing tests and eight existing opt-in skips. Some initial live attempts timed out and were retried; checks remain strict about missing metadata or image bytes.

The image PR separately verifies all seven Flickr JPEGs and keeps the three album fixtures in its nightly job. The linked-card UI and JSON-field binding work remain proposed, as listed above.
