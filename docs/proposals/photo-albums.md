# Photo album importing and carousel widgets

Proposal dated 8 October 2026. This feature follows [PR #22](https://github.com/adafruit/Marquee_Web/pull/22), which adds an image frame bound to an Adafruit IO feed. The follow-up adds collection discovery through Cloudflare Workers, an album builder, and a carousel that renders one album image within the existing canvas and bitmap pipeline.

The main interaction is **paste an album or webpage link, select pictures, then add a carousel**. Local uploads and a simple JSON manifest give users equally useful routes when a source cannot be scraped. Downloaded pictures become local image assets; the canvas never depends on cross-origin image loading.

## Goals and deployment boundary

- Accept links people actually have: shared Google Photos and iCloud Photos albums, Flickr albums, ordinary galleries, direct images, feeds and manifests. Users do not need to find the underlying image URLs.
- Let users combine sources, select and reorder pictures, inspect captions and credits, and preview the result on their display palette.
- Reuse PR #22's frame fitting, image decoding, asynchronous cancellation and distinction between authored design and sampled content.
- Preserve a useful picture through network failures and refresh without counting playback as a design edit.
- Keep the Worker responsible for discovery and byte transport; keep Konva rendering, dithering and bitmap publishing in the existing browser app.

The existing project is a static browser app. Its live-take publisher runs in the browser in response to board status. Consequently, unattended playback initially requires that browser app to remain running. A Worker scraper alone cannot advance the device when the browser is closed. Browser-independent scheduled rendering and publishing is a separate extension requiring a server renderer, device authorization, durable playback state and scheduling. The interface must state this plainly.

## User experience

Add **Photo album** beside Image and Linked image in the toolbox. It opens a builder with three entry points: **Paste a link**, **Upload photos**, and **Import album JSON**. Multiple links and multiple files can be added to the same album. Example collection suggestions should include family albums, NASA mission photography, artwork, historical photographs and maker project pictures.

Discovery shows thumbnails progressively and labels the result **Complete**, **More available**, or **Partial**. An Open Graph title and image preview is a valid single-item result, including a tweet or quote page. A preview does not imply that all collection images have been enumerated. Errors explain the next useful action: retry, load more, choose another link or upload files. The user can cancel discovery and close the builder without late responses changing their canvas.

The grid supports select all, clear, individual selection, selected count, thumbnail enlargement, accessible keyboard controls, and drag ordering with Move up and Move down alternatives. The album editor supports removing items, changing the album name, captions and credit text, selecting a cover, and adding more sources. Reopening it preserves existing selections and order. Save and Cancel are transactional: only Save changes the document. Excluded source items remain excluded across a later refresh.

The carousel inspector offers Edit album, Previous, Next, pause/resume, a position counter, Fit inside/Fill frame/Stretch, frame dimensions, sequential/shuffled order, and time per picture. The default is a ten-minute hold, a contained image, sequential ordering and title plus attribution. Title and author or username attribution display is on by default for all sources and can be switched off; attribution metadata remains in exports even when hidden. Per-image crop/focal point, rotation, background colour and contrast are desirable subsequent controls rather than silently assumed features.

E-ink playback uses still frames, without transitions or unnecessary redraws. Preview navigation never publishes to IO. Playback chooses the due slide on the existing publish/take path and awaits decode before the bitmap is captured. A slow image keeps the previous frame. A late browser timer does not rapidly publish all missed slides. The picture interval and device wake interval are separate settings: a one-minute wake can hold a picture for ten minutes.

## Source support

Every carousel item accepts a URL, including a JPEG URL or a Twitter/X post. The builder can dump discovered items into an editable list in two forms: **album references** (`album-url#marquee-photo=1`, a one-based entry selector) or **direct image URLs** (which may expire or break). Album references rediscover the collection before selecting the entry; store a stable provider photo ID when available so insertion or reordering does not silently select another image. A bare page URL resolves its available images; a per-item selector chooses one. Generic pages and Twitter/X are best effort, not a promise to bypass sign-in or access restrictions. Unresolvable items retain the previous image and expose a Retry or Replace URL action.

Put preparation guidance beside import: **For the best result, crop to the frame and pre-dither to your display palette before uploading.** Existing browser conversion still handles ordinary photos. For more permanent hosting, offer saving a prepared image to an Adafruit IO feed or hosting on GitHub, Flickr or a public Google Photos or iCloud Photos shared album. Feed storage must respect PR #22's history-off requirement and value-size ceiling; public hosting does not guarantee permanent image URLs. Store source references for rediscovery and explain that shared-link contents are accessible to holders of the link.

Add nightly GitHub Actions checks of the public Google Photos and iCloud Photos example albums, extracting three and nine photo records respectively and verifying every JPEG download. On failure, open or update one repair issue with diagnostics, then assign GitHub Copilot where the repository supports its coding agent. The expected output is a repair PR for review, never an automatic merge. Retry a transient failure once, distinguish upstream/network failures from parser regressions, and avoid issue storms. Cron schedules are best effort; live-test results and workflow artifacts show last success. The workflow must exist on the default branch to run on its nightly schedule; a stacked draft PR alone does not activate it. Copilot repair depends on enabled repository access and permissions.

| Source | Discovery route | Release expectation |
|---|---|---|
| Direct image URL | Inspect HTTP response and verify raster bytes | Initial implementation |
| Ordinary gallery page | Open Graph, Schema.org and HTML images together | Initial implementation, best effort |
| Google Photos shared album | Parse photo records in embedded page data | Initial implementation, explicitly best effort |
| iCloud Photos public shared album | Anonymous CloudKit resolve/query; JPEG renditions, stable photo IDs and contributor credits | Included for `photos.icloud.com/shared/album/...`; best effort, first 100 photos |
| JSON album manifest | Versioned list of image records | Initial implementation |
| Local photos | Multi-file import, browser resize and embedding | Initial implementation |
| Flickr public album | API adapter using album and owner IDs; paginate | Included adapter, API key configuration required; first page is bounded |
| NASA image collections | Search/album API plus asset manifests | Included adapter; collection search rather than a single daily image |
| RSS and Atom | Image enclosures and media fields | Next adapter |
| Museum and archive collections | Provider APIs where available; generic scraper otherwise | Incremental adapters |
| Private cloud folders | Explicit OAuth adapters | Later; generic scraping does not grant access |

The supplied Google Photos example was tested without sign-in: its HTML contained three ordered photo records and original dimensions. One base URL with `=w1600-h1600` returned a 1201 by 1600 JPEG of approximately 568 KB. Open Graph exposed only the cover. This establishes a working public-page extraction path, not guaranteed pagination or permanent URLs. Re-fetch the source when links expire; test larger albums before claiming complete enumeration.

## Scraper behaviour

Use provider adapters first where they offer collection semantics. Generic extraction combines all useful representations rather than stopping after finding one Open Graph image.

- Open Graph: repeated `og:image` entries, URL, dimensions and alternative text; preserve associations between image entries and their properties.
- Schema.org: JSON-LD, Microdata and RDFa; handle arrays, `@graph`, nested `ImageObject`, `image`, `contentUrl`, `thumbnailUrl`, `associatedMedia` and ordered `ItemList` records. Resolve local `@id` references with bounded traversal. A webpage `url` is not automatically image bytes.
- HTML: `img` sources, responsive `srcset`, `picture` source alternatives, common lazy-load attributes and direct-image links. Resolve relative URLs against the final page URL and its valid `base` element. Group responsive alternatives into one image instead of duplicate slides.
- Google Photos: locate the embedded callback payload and parse only the bounded JSON data portion, without evaluating JavaScript. Distinguish photo records from album covers and avatars. Detect a continuation marker or ambiguous enumeration and return partial status.

Retain provider-neutral title, description, author and structured metadata for a future stacked PR supporting non-image cards and JSON fields in card templates. This image-only PR renders images and optional title/attribution.

Keep provenance and available size variants for each candidate. Preserve provider order or DOM order unless an explicit ordered collection supplies a better sequence. Deduplicate by provider ID and exact asset identity; do not strip arbitrary query strings because they may distinguish signed URLs or different pictures. Rank content images above logos, icons, trackers and cover previews, but keep a Show all option so a heuristic never permanently hides a wanted image.

Prefer an uncropped provider rendition large enough for the authored frame, with a modest oversampling allowance for crop and dithering. Use tested Google dimension suffixes only within that adapter. Never rewrite arbitrary image URLs with invented resize parameters. Browser resizing is the default fallback; Cloudflare Images can be an optional configured optimization.

## Worker API and safety

Suggested interfaces are `POST /api/albums/discover`, `POST /api/albums/import`, and `GET /api/albums/image?token=...`. Discovery accepts a source URL and bounded page/item limits. It returns a title, source type, ordered candidates, provenance, warnings and explicit completeness status. Candidate image URLs are wrapped in short-lived signed capability tokens; the image route must not be an unauthenticated arbitrary URL proxy. Public URL discovery needs rate limits and a request origin policy; origin headers alone are not authentication.

Use Workers HTMLRewriter for element extraction and a bounded parser for script payloads and structured data. Follow redirects manually, validating every destination. Permit HTTP(S) public destinations only, reject credential-bearing URLs and private/local IP literals and names, and account for DNS rebinding before describing the generic fetcher as fully SSRF resistant. Provider allowlists offer a stricter deployment option. Never forward browser cookies or authorization headers to arbitrary origins.

Apply deadlines, redirect limits, maximum HTML bytes, image bytes, candidate count and traversal depth. Stream byte transport where possible. Validate actual raster signatures, reject HTML responses and unsupported active formats such as SVG, and enforce decoded dimensions in the browser before placing an image. Do not execute remote scripts or insert remote markup into the UI. Error text, captions and titles are rendered as text.

Shared album URLs are access capabilities: redact their keys and signed image URLs in logs. Avoid public caches of private/share-link results. Secrets belong in Worker configuration, not canvas documents. Cancelled or superseded requests must not add slides. Large collection processing must paginate rather than fetch the entire album and every original in one request.

## Album assets and document model

An album has a version, stable item IDs, a name, ordered items and source references. Each item can carry title, caption, credit, source page, provider ID, source image variants, imported data URL and natural dimensions. Source URLs are discovery provenance; downloaded data is the render input.

Keep the initial implementation self-contained: bounded, resized embedded assets survive a reload and canvas export without a new account or storage service. Provide a total embedded-size budget and clear guidance before browser storage or IO canvas-state limits are exceeded. An album manifest containing remote URLs is a portable source list, not an offline backup; exports with embedded assets are the offline form. Shared-link provenance should be omitted from a public export unless deliberately included.

For larger albums, add IndexedDB with content-addressed assets and optional private R2 storage. Reference-only canvas documents need a defined asset portability strategy before being enabled. Sending every slide's base64 bytes into `canvas-state` is unsuitable for substantial collections, even though the final bitmap feed only holds one frame.

The new `carousel` element stores frame `w`, `h`, `fit`, album items, playback order, interval and caption policy. Current slide ID, last sampled data URL, natural dimensions and playback timing are runtime/sample state. Serialization restores the visible image, while design comparison ignores sample changes. Authored edits to slide order, membership or settings remain real design changes. Import validation and panel fitting must recognize the new element type.

Reuse the feed-image frame renderer where practical without pretending a carousel has an IO image-feed binding. Unlink/Convert to image freezes the visible frame using PR #22's contain/cover semantics. Duplication copies authored album settings; each element owns its playback state. Rebinding an album or deleting a widget invalidates pending decodes.

## Playback and refresh

Use stable IDs and a deterministic sequential cursor or seeded shuffle. Shuffle visits each selected item once per cycle. Persist enough state to resume after reload. Empty albums show a useful placeholder; one-item albums behave like a static picture. Broken slides are skipped with a visible problem indication; if all fail, retain the previous successful frame.

Advance only on a successful decode and do not consume a slide because an unrelated preview refresh ran. Device publishing must await the image settlement alongside existing feed reads. Repeated refreshes in one due interval select the same slide. Device/tab switching cannot publish a late image to another board. Multiple browser publishers require explicit coordination or a single active-publisher rule before unattended use is advertised as robust.

Source updates are independent from picture rotation. Default to a frozen curated album. An optional Check for new photos action reconciles by stable ID without changing the user's existing order or restoring excluded photos. Scheduled source refresh, append-new policy, deletion policy and background publishing are later extensions with visible status and last-success time.

## Implementation stages and acceptance

1. **Stack and proposal.** Open a draft PR against PR #22's head branch in its fork. Attach this document in the repository and link it from the PR body. No deployment or merge is implied.
2. **Worker and extraction.** Add generic structured-data/HTML discovery, public Google Photos extraction, manifest support, safe image import and local fixture tests. Verify the supplied live Google album and one resized download.
3. **Builder and widget.** Add transactional album editing, local import, selection/order, bounded embedding, carousel frame, playback settings and persistence. Integrate sample stripping, canvas import fitting, decode settlement and the existing bitmap path.
4. **Verification.** Run the existing suite plus meaningful extraction, malformed-input, redirect/token, album order, cancellation, playback and save/reload tests. Verify the builder and inspector at desktop/mobile widths, keyboard navigation, palette preview and export without Canvas taint. Keep live IO writes opt-in.
5. **Provider expansion.** Image feeds and fuller pagination; then museum adapters, larger asset storage and optional unattended rendering. Track these separately from the initial implemented slice.

Initial release acceptance: a user can paste the supplied Google album, select all three images, reorder them, save a contained carousel, move between pictures, reload, and export/import the canvas with pictures intact. An ordinary page with Open Graph, JSON-LD and responsive HTML contributes deduplicated candidates from all three. A failed import leaves the original design intact; playback does not create false queued edits or repeated canvas-state publications. The interface identifies partial discovery and the browser-running requirement.

Feature completeness means these states are coherent and recoverable, not that every public or private website can be scraped. Each subsequent adapter uses the same builder and carousel rather than adding a different user workflow.

## Current implementation and verification

The stacked draft PR includes the Worker, generic metadata extraction, Google Photos/iCloud Photos/NASA/Flickr adapters, mixed URL and upload builder, special-reference/direct-URL exports, frame fitting, title/attribution display, sequential/shuffled playback, serialization and a nightly canary with conditional Copilot repair assignment. Metadata extraction is provider-neutral for the planned non-image cards PR.

Verified locally: 371 tests pass and eight existing opt-in tests are skipped. The public canaries check three Google Photos and nine iCloud Photos records and download every JPEG rendition. The suite includes actual Worker HTMLRewriter execution and stale-result/playback tests. Browser visual review remains outstanding because the cloud browser cannot reach the local preview server. No live IO writes or production deployment have been performed.

Deployment requires a Worker secret and origin/route configuration; Flickr additionally needs an API key. Nightly scheduling requires the workflow on the default branch; automatic Copilot PRs additionally require enabled agent access and the configured user-token secret. Google/iCloud/Twitter public access remains best effort. Albums currently embed at most 300 KB; larger storage, source reconciliation, full pagination, image-feed adapters, per-photo editing and browser-independent publishing remain follow-ups. This implementation does not claim all the roadmap acceptance steps are already complete.

## References

- [PR #22 and its current implementation](https://github.com/adafruit/Marquee_Web/pull/22), inspected at head `ada8c254b5963e2edf8ed83454788430149908ea`.
- [Open Graph protocol](https://ogp.me/) and [Schema.org ImageObject](https://schema.org/ImageObject).
- [Google Photos API changes](https://developers.google.com/photos/support/updates) and [Picker image access](https://developers.google.com/photos/picker/guides/media-items). Public-page scraping is a separate, undocumented route.
- [Flickr album enumeration](https://www.flickr.com/services/api/flickr.photosets.getPhotos.html).
- [NASA image library API](https://images.nasa.gov/docs/images.nasa.gov_api_docs.pdf), including search, asset manifests and albums.
- [Cloudflare HTMLRewriter](https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/), [Worker limits](https://developers.cloudflare.com/workers/platform/limits/) and [Images binding](https://developers.cloudflare.com/images/optimization/binding/).

## iCloud Photos addition — 8 October 2026

The supplied public Apple album resolves to nine photos. Its HTML Open Graph metadata provides only the cover; the adapter uses Apple's anonymous public CloudKit resolve/query protocol to enumerate the collection. No sign-in, share acceptance or Apple API key is required. It pairs asset and master records by ID, preserves provider order and stable photo IDs, returns captions/filenames with contributor or owner display names, and prefers JPEG copies over HEIC originals. Participant email addresses and public-access API tokens are not exported. Album references rediscover expiring CDN links.

Apple sends these JPEGs with `application/octet-stream`, so the download path verifies raster signatures and returns the correct image MIME type. API requests use the existing DNS/size/time guards, limit partition hosts to Apple CloudKit and refuse POST redirects. No remote scripts execute. Private/invite-only albums and legacy `icloud.com/sharedalbum/#...` links remain outside this adapter; unsupported items or collections beyond 100 photos are labelled partial.

The GitHub nightly canary now checks both supplied albums through the Worker's discovery/download code, independently retries each provider, checks photo counts and attribution, and verifies all twelve JPEG downloads. Failure of either provider follows the existing repair-issue/Copilot-PR path. Local regression fixtures contain synthetic names and IDs, plus a Miniflare test covering signed image import.
