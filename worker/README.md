# Photo importer Worker

This Worker discovers images in public pages, shared Google Photos and iCloud Photos albums, NASA searches/collections, public Flickr photostreams, configured Flickr albums and version 1 JSON manifests. It returns title, description, author and structured metadata for future card templates; this feature only renders images.

## Configure and deploy

The repository root `wrangler.toml` defines one Worker, `adafruit-marquee-web`, that serves the static app from `public/` and this importer at the same-origin `/api/albums/*` route. The browser therefore never makes a cross-origin request and no `APP_ORIGIN` configuration is needed.

1. Install repository development dependencies with `npm ci` (Node 22 or newer; CI uses Node 24).
2. Set a random secret of at least 32 characters with `npx wrangler secret put IMPORT_SECRET`. Secrets survive later deploys; plain variables are replaced from `wrangler.toml` on every deploy.
3. Optionally set `FLICKR_API_KEY` as a Worker secret to enable Flickr album and photostream API access. Public photostreams also work without a key through the page adapter.
4. Deploy with `npx wrangler deploy`, or connect the repository to Workers Builds with the default `npx wrangler deploy` command so pushes to the chosen branch deploy automatically. The Worker URL then serves the whole app.

A separately hosted copy of the app (for example GitHub Pages) uses the Worker named in `public/js/core/deployment.js` by default; users can enter another origin in the album builder's Importer connection section and list that page's origin in `APP_ORIGIN` if you want to restrict callers. No credentials are bundled in public files. Local uploaded albums work without a Worker.

## Run locally

`npm start` serves the app and, when `npm ci` has installed Miniflare, runs this Worker in the real workerd runtime at the same-origin `http://localhost:3000/api/albums/*` route. Leave the album builder's Importer connection blank and paste album, page or image URLs: the public Google Photos, iCloud Photos and Flickr test albums discover and download locally exactly as in production, and the Worker's `HTMLRewriter`, DNS preflight and download guards all run for real. A random `IMPORT_SECRET` is generated per run (set `IMPORT_SECRET` to pin one); `FLICKR_API_KEY` and `ALLOWED_HOSTS` are passed through from the environment. Restart the server after editing Worker code. Without Miniflare, or with `ALBUM_IMPORTER=0`, the route answers 503 and only uploads work.

To exercise the Cloudflare toolchain instead, put `IMPORT_SECRET=<random 32+ characters>` in a root `.dev.vars` file and run `npx wrangler dev`, which serves the app and the importer together on `http://localhost:8787`.

## Limits and public sources

Downloads are capped at 12 MB, pages at 2 MB, redirects at five, and discoveries at 100 pictures. Larger or paginated albums are labelled partial; load-more support is a follow-up. The Cloudflare rate limiter allows 240 requests per minute per IP, including signed thumbnail downloads. Change the namespace ID to a unique value for your Cloudflare account when necessary.

Signed image import capabilities expire after 15 minutes. Every source and redirect is checked for public HTTP(S) hostnames, allowed ports and public IPv4 DNS answers. `ALLOWED_HOSTS` can restrict imports to selected provider and CDN domains. DNS preflight is a mitigation, not IP pinning; use the strict allowlist for deployments that cannot accept DNS rebinding risk. DNS lookups time out after 15 seconds; each upstream request is bounded to 30 seconds. Provider API POSTs refuse redirects. No browser credentials are forwarded upstream. Response caching is private/no-store. Configure normal account-level protection as appropriate for a public service.

Direct image URLs can expire. Album references use `#marquee-photo=N` with a one-based index; official-provider references also carry a stable ID. Google Photos uses undocumented page data. iCloud Photos supports public `https://photos.icloud.com/shared/album/...` collections through Apple's anonymous public CloudKit endpoint; no Apple account or API key is needed. This is an undocumented provider adapter, separate from generic Open Graph discovery. Legacy `icloud.com/sharedalbum/#...` links and private/invite-only albums are not supported by this adapter. For iCloud, the importer prefers available JPEG renditions of HEIC originals, verifies image bytes even when Apple sends `application/octet-stream`, and preserves captions, contributor/owner names and stable photo IDs. It does not export participant contact details or anonymous API tokens. Direct CDN links expire: prefer album references. Albums are limited to 100 photos and incomplete/unsupported renditions are labelled partial. Videos contribute a still preview when available. All three supplied public collections have live canaries. Twitter/X works only when the accessible response contains a usable image preview; there is no browser automation, login bypass or guarantee for every post. Single Open Graph image previews are useful results, not errors.

Flickr `flic.kr/ps/...` short links resolve through the same guarded redirect handling as other URLs. Public `/photos/USER/` photostreams can be imported without an API key by parsing the page's JSON model data; scripts never execute. Photos retain stable IDs, titles, owner credit and provider order. The importer selects available non-square renditions up to 1600 pixels and excludes profile pictures and unrelated recommendations. Larger or partially loaded photostreams are labelled partial. Configured API access supports both `flickr.people.getPublicPhotos` and Flickr albums.

URL-backed pictures are stored as links only, whichever export format is chosen, and the frame fetches each one through the importer when it is shown; providers are asked for the smallest rendition that covers the largest panel (800 pixels, never above 1,200) to keep Worker memory and time low. Only uploaded photos are embedded, within a total 300 KB budget that leaves space under IO canvas-state's history-off value ceiling. Background rendering is future work. Animated uploads become still pictures. Crop and pre-dither to the panel palette before upload for best results. Attribution is displayed by default.

## Tests and nightly repair

`npm test` includes pure discovery/playback tests and a real Miniflare HTMLRewriter test. `npm run test:albums:live` exercises the same guarded discovery and image-download functions as the Worker against the public Google Photos (three photos), iCloud Photos (nine photos) and Flickr (seven photos) test albums. It verifies stable IDs, title/credit metadata and every photo's JPEG download. Each provider retries once on failure, and every provider is checked even if an earlier one fails. Logs identify the provider and failed stage without printing shared-link keys, tokens or CDN URLs. Override fixtures with `ALBUM_TEST_URL` / `ALBUM_TEST_COUNT`, `ICLOUD_ALBUM_TEST_URL` / `ICLOUD_ALBUM_TEST_COUNT`, and `FLICKR_ALBUM_TEST_URL` / `FLICKR_ALBUM_TEST_COUNT`. To reproduce just one provider, use `npm run test:albums:live -- flickr` (or `google` / `icloud`); the nightly job omits selectors and checks all three. Regression tests also run the real Worker discovery/signing/download routes in Miniflare with synthetic iCloud data.

`.github/workflows/albums.yml` runs unit tests on pushes/PRs and both unit/live checks nightly at 03:17 UTC, with a manual dispatch option. GitHub schedules only run after this workflow is on the default branch. Failure of any provider canary creates or updates one repair issue and records diagnostics in an artifact. Enable GitHub Copilot cloud agent and provide `COPILOT_AGENT_TOKEN` as an Actions secret containing a user token with metadata read and actions, contents, issues and pull-request write access. The normal Actions installation token cannot start Copilot. Without that secret the issue remains actionable and the workflow reports the missing configuration. Copilot's output is a repair PR for review, never an automatic merge.

See [GitHub's Copilot API documentation](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-via-the-api) and the [proposal](../docs/proposals/photo-albums.md).

## Linked-card follow-up

The follow-up adds `npm run test:previews:live` for the exact X, Bluesky and two Mastodon URLs in `test/fixtures/linked-card-sources.json`, with bagder before freediverx. These tests download the actual preview images and verify title/creator metadata; logos and avatars do not satisfy the tests. X/Bluesky use public Open Graph metadata. Mastodon attachment and link-card previews use its public status API, including `card.image` when the page omits `og:image`. No API key or signed-in session is used.

Preview canaries run in the same nightly GitHub workflow and use its existing Copilot repair path. See the [linked-card proposal](../docs/proposals/linked-cards.md) for the remaining card editor and JSON-field mapping work.
