# The canvas-state feed — `{group}.canvas-state`

The **editable scene** — `canvas.json`, verbatim — parked on Adafruit IO so that the
design stops living only in the browser that drew it.

- **Producer:** the editor, from `scheduleCanvasStatePublish()` in
  `public/js/device/canvasfeed.js`, called by `saveCanvasNow()` in `public/js/core/doc.js`.
- **Consumer:** the editor, from `readCanvasState()` in the same module, called by
  `hydrateFromCanvasFeed()` in `public/js/device/activate.js`.
- **The board never touches it.** It is not part of anything written to the board.

This is the one feed in the group that is editor-to-editor. Everything else on
`{group}` is a conversation with the hardware: `.bitmap` is what it draws, `.sleep` is
how long it waits, `.status` is what it reports back. Those three describe the panel.
This one describes the *document behind* the panel — the elements, their positions,
their feed bindings — which is the only thing in the system a second machine could not
reconstruct.

## Why it exists

The document had two homes and neither of them travelled:

| where | written by | who can read it |
|---|---|---|
| `marquee.canvas.<id>` in localStorage | `saveCanvas()` in `devices.js`, every 400ms | one browser profile on one machine |

So opening a display on a laptop that had never edited it showed an **empty canvas**
for a board that was, at that moment, drawing a dashboard. The bitmap feed had the
picture; nothing anywhere had the scene that made it. Clicking a display on A1 now
fetches this feed, populates the canvas, and caches a render of it as
"On the panel now" — see the sequence below.

## The feed key

`{ADAFRUIT_IO_GROUP}.canvas-state` — `canvasStateFeedKey()` in `public/js/core/api.js`,
derived from the group like every other key here, so renaming a display moves all four
feeds together.

**Keep feed history OFF.** History caps a datum at 1 KB (`IO_MAX_HISTORY`); a scene
with two labels is already past that, and one with an image from before #36 (embedded
rather than on a feed) runs to hundreds of kilobytes. Off, the ceiling is 512 KB (`IO_MAX_NO_HISTORY`), which is what
`flush()` gates on. It is the same reasoning as `.bitmap`, and it has the same
consequence: **the feed holds exactly one datum, the current one.** There is no
history of a design here and there is not meant to be — `/data` returns `[]` and
`/data/last` is the only useful read.

## The payload

The `value` is the `canvas.json` document as a **string**, exactly as `serialize()`
in `doc.js` produced it and exactly as `saveCanvas()` stored it — same convention as
`.sleep` and `.status`, and byte-identical to the localStorage copy on purpose (see
"Who wins"). No wrapper, no envelope, no separate version field: `doc.version` is
already in there, and a second one describing the transport would be a second thing to
keep in step.

```json
{"version":1,"display":{"width":122,"height":250,"rotation":270,"type":"tricolor",…},"elements":[{"etype":"label","x":68,"y":10,…}]}
```

### Element order is stacking order

There is no `z` field. `elements` is written bottom-first, in the order the nodes sit in
the editor's content layer, so the array order **is** the z-order and a reader that
draws them in sequence gets the same overlap the editor showed. `deserialize()` keeps
it: an embedded image is only built once its data URL decodes, after everything else, so
`placeInSavedOrder()` (`public/js/lib/zorder.js`) slots each one back down beneath
the first later element already on the canvas instead of leaving it on top. The editor
reorders with the inspector's **Layer** row, the right-click menu, or
<kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>]</kbd> / <kbd>[</kbd> (add <kbd>Shift</kbd> for
front / back); each is an ordinary edit, so it autosaves and mirrors like any other.

### The `datetime` element

The toolbox's **Date & time** prop. A text block showing Adafruit IO's time
(`/api/v2/time/millis`, read by `public/js/device/iotime.js`) formatted in the browser by
`strftime()` in `public/js/lib/timefmt.js`. It is read through the same
`refreshFeedElements()` funnel as every feed binding, one request however many there are.

Why not IO's own `/integrations/time/strftime`: its successful authenticated responses carry
`Access-Control-Allow-Origin: https://io.adafruit.com`, so a browser on any other origin
(localhost, Pages) cannot read them. The preflight and the 401 answer `*`; only the 200 is
pinned. The bare `/api/v2/time/*` endpoints are unauthenticated and answer `*`. So it is re-read before
every push and every live take, and **only** then: the board draws a bitmap, so the panel only
refreshes the time when a new image is pushed.

```json
{"etype":"datetime","x":8,"y":4,"timeFmt":"Last Updated: %Y-%m-%d %H:%M","timeTz":"","timeValue":"Last Updated: 2026-10-02 21:05",
 "fill":"#000000","fontSize":14,"fontFamily":"IBM Plex Mono","align":"left","width":140}
```

| field | meaning |
|---|---|
| `timeFmt` | a strftime string, always one of `TIME_PRESETS` in `public/js/lib/timefmt.js`. Anything else loads as the default (Time). There is no free-form format. |
| `timeTz` | a tz database name, or `""` for the timezone of the browser doing the push |
| `timeValue` | the string IO last returned; `null` before the first read. A **sample** (see `lib/samples.js`), so a new time is not a design change. |
| `fill`, `fontSize`, `fontFamily`, `align` | as on a label |
| `fontFamily` | one of the fonts in `lib/fonts.js`: `IBM Plex Mono`, `IBM Plex Sans`, `IBM Plex Serif`, or a bitmap font, `tom-thumb` (Tom Thumb 3×5) or `gfx-5x7` (Adafruit GFX 5×7), drawn in whole multiples of its 6 or 8 px line (`lib/pixelfont.js`). A document saved before the Plex faces were bundled says `monospace`, `sans-serif` or `serif`, and loads as the matching Plex face |
| `width` | present only when the box width is set; absent means the box auto-sizes to the text |

`text` is not saved: it is `timeValue`, or the preset's example before the first read.
`normalizeDatetimeAttrs()` is shared by the factory and `serialize()`, so the two agree.

### The `feedimage` element

The toolbox's **Image from Adafruit IO Feed** prop, and since #36 the only way a picture gets
onto the canvas. **Every picture lives on an Adafruit IO feed**, never inside this document:
a feed that already holds one (a doorbell or bird-feeder camera's latest frame, anything
published as base64), or a new feed the editor creates and uploads to. The picture is
re-read through `refreshFeedElements()` like every other binding, once per push and per
live take, and decoded by whoever is drawing: the browser in the editor, skia-canvas in the
server renderer (`renderer/`, through `bakeReadings()` in `lib/bindings.js`).

```json
{"etype":"feedimage","x":8,"y":8,"w":120,"h":90,"fit":"contain","feedKey":"drop-image","feedName":"drop-image",
 "src":"feed:drop-image"}
```

| field | meaning |
|---|---|
| `w`, `h` | the **frame**, in panel pixels, which the user sizes. Every picture the feed delivers is placed into this box, so a feed whose pictures swing between portrait and landscape neither ratchets the element smaller nor runs it off the panel. |
| `fit` | how a picture is placed in the frame: `contain` (whole picture, centred, bars where the shape differs; the default), `cover` (fills the frame, trimming the edges) or `stretch`. |
| `feedKey`, `feedName` | as on a label. A feed shared from another account is `owner/key`. |
| `src` | **a feed reference, not a picture:** `feed:` followed by `feedKey` (`FEED_IMAGE_REF` in `lib/feedimage.js`). It tells a reader that only looks at `src` that the picture is on a feed, so it can tell that apart from a missing picture. It is not a URL and nothing ever fetches it. An import replaces whatever `src` a file carries (base64 from an earlier build, a URL) with the reference. |
| `dither`, `diffusion` | optional, on `feedimage` and `image` alike: this picture's own dither (`FloydSteinberg`, `ordered` or `none`, plus a 0–100 `diffusion` for Floyd–Steinberg). Absent means the picture follows the display's `dither`, which is the default for pictures. Only pictures are dithered, each on its own; everything else snaps to the nearest palette colour (`lib/imagedither.js`), in the editor and the server renderer alike. |

The picture's bytes and natural size are readings, so they are not saved. That makes a new
picture on the feed no change to the document at all (`lib/samples.js` has no entry for
this element), and keeps the canvas-state datum small however many pictures it shows.

**The value on the feed** may be raw base64 or a `data:` URL. The format is read off the
first bytes (`parseFeedImage()` in `lib/feedimage.js`), never off a declared type, and only
**PNG, JPEG, GIF and BMP** are accepted. **The feed must have history OFF:** history caps a
datum at 1 KB and no picture fits. With it off the ceiling is 512 KB (`IO_MAX_NO_HISTORY`).
Picking a history-on feed offers to turn its history off, and is refused if the user declines.

**Uploading** (`device/imagefeeds.js`) fits the picture inside the panel, keeps the file's
own bytes when it already fits in an accepted format, and otherwise re-encodes it as PNG,
then JPEG at falling quality, until it is under 512 KB. Only then is a feed created, in the
account's default group with history off, and the picture published to it. IO's own error
text is shown verbatim (the account's feed limit, a name already taken). A feed whose
publish fails is deleted again so it does not count against that limit.

**No picture** (the feed is empty, or holds something that is not a picture) draws as a
dashed outline with a large question mark, on the canvas and on the panel. Both colours are
chosen against the page so the frame stays visible on any background, and the mark is red
where the panel has red. A failed read keeps the previous picture, like every binding.

There is no unlink (#24). A different picture means a different feed (**Change** in the
inspector, which also offers an upload), or a new picture on the same feed (**Replace the
picture on this feed**, which asks first, since everything reading that feed changes too).

**Images from before #36.** An `image` element embeds its picture in the document as a data
URL. Nothing creates one any more, but documents that have them still load, draw and render.
The inspector offers **Move to an Adafruit IO feed**, which uploads the picture (or binds a
feed already holding one) and turns the element into a `feedimage` where it stands.

## Cadence — why it is not the autosave

`doc.js` debounces its save at 400ms, which is right for localStorage and would be one
IO datum per keystroke. `canvasfeed.js` adds its own timing on top:

| knob | value | why |
|---|---|---|
| `DEBOUNCE_MS` | 3000 | a drag, a resize, or a sentence typed into a label is **one** datum |
| `MIN_GAP_MS` | 15000 | a floor between publishes however busy the canvas is — IO's rate limit is an account-wide budget shared with every element binding on the canvas |
| de-dupe | exact payload | a save that serializes identically never reaches the network |
| de-dupe | the **design** | a new feed reading changes the picture, not the scene — see below |

The second de-dupe is what keeps this feed quiet now that the editor refreshes bound
elements on the board's own cycle (see "The live take" in
[`marquee-sleep.md`](marquee-sleep.md)). `serialize()` bakes each bound element's last
reading into the document, so every refresh is a document change — and without this the
feed would carry a fresh copy of the whole scene, embedded images and all, once per board
cycle, forever, per open tab. `lib/samples.js` names the keys that hold a reading rather
than a design decision, and a document differing in nothing else is not published.

What the feed then holds is the scene as of the last real edit. That is the right split —
this feed is the editable scene, the image feed is the rendering of it — and a browser
hydrating from here re-reads the bindings itself.

A failed publish costs nothing: the document is already in localStorage, `lastPublishedJson`
is dropped, and the next edit carries the whole scene up again. The user is told **once**
per session and never again — this is a background mirror, not an action anyone took.

## Who wins when the two disagree

`hydrateFromCanvasFeed()` in `activate.js`, run on every device activation and *not*
awaited, so a slow or unreachable IO never delays the editor opening.

1. **Nothing on the feed** → keep what is here. Includes the honest case of a display
   that has genuinely never been drawn on.
2. **Same scene both ends** → nothing to decide. Compared on the **bytes**, against the
   stored document rather than a fresh `serialize()` — a round trip through Konva can
   differ in a rounded coordinate and would read as a change that is not one. This is
   the ordinary case (a browser reading back its own publish) and it deliberately does
   not depend on any clock.
3. **Nothing saved here** → the feed wins. The case the feed exists for.
4. **Feed newer than the local save** → the feed wins. Somebody edited elsewhere.
5. **Local newer** → keep it; the publish debounce carries it up on its own.

The stamps in 4 and 5 are `marquee.canvasAt.<id>` (this machine's clock, written by
`saveCanvas()`) against the datum's `created_at` (IO's clock). They are two clocks and
there is no third: a datum is stamped by the server, a localStorage write by the
browser. Rule 2 is what keeps the common path off that comparison entirely.

## What happens after a hydrate

In order, all of it guarded on the active device not having changed underneath:

1. `noteCanvasStateSeen()` — so the save below does not echo the scene straight back up.
2. `cancelCanvasSave()` — the local document's autosave is still pending from the
   deserialize in `rehydrateFor()`, and letting it fire would write the scene being
   replaced back over the record.
3. `deserialize(doc, { keepDisplay: true })` — the panel descriptor is **this** bench's.
   The `display` block inside a document authored elsewhere describes that machine's
   idea of the panel, not the pins in front of the user. The one exception is
   `display.background`, the colour of the page the scene is drawn on: that is part of
   the artwork, so it is always taken from the document (snapped to this panel's
   palette), and a document without one loads on the default paper colour, pure white
   `#FFFFFF`. Documents saved when paper was the tint `#F2F4EF` have every colour of
   that value swapped for white on load (`migrateLegacyPaper()` in `palette.js`).
4. `saveCanvasNow()` — localStorage and the timestamp.
5. `whenCanvasSettled()` — images decode asynchronously, and a feed image reads its feed
   first, so photographing the canvas early caches a panel with holes where the artwork goes.
6. `capturePanelFromCanvas()` in `screens/a8.js` — renders the scene in the browser
   (`render.js` -> `bitmap.js`) and files the BMP under `marquee.panelNow.<id>`, so the A1 tile shows the
   display instead of "Nothing drawn yet" and A8's left-hand glass is not empty.

Step 6 is the one place that cache is written from something other than a feed datum,
and it is the weaker claim: a real take always outranks it, because `fetchTakes()`
overwrites `lastDrawn` from `.bitmap` on its next pass and only falls back to the cache
when IO has nothing to say.

## Importing a file

`Import JSON` in the editor (`core/doc.js`, validated by `lib/canvasimport.js`) loads a
`canvas.json` onto the canvas and needs nothing from this feed: it ends in the same
`saveCanvasNow()` as any edit, so the imported scene goes to localStorage first and up
here on the usual leash above. Like a hydrate it loads with `keepDisplay: true` — the
file's `display` block is shown to the user against this panel's, the artwork can be
fitted (uniform scale, centered) or placed 1:1, colours are snapped to this panel's
palette, and only the dithering may optionally be adopted from the file. The page
background comes with the artwork, as on a hydrate.

## Displays that predate this feed

A5b creates the whole set at setup and never runs again for a display that is already
configured, so an existing bench has a group with three feeds in it. The first publish
gets a **404**, and `createMissingFeed()` answers it: create the feed, send again, say
nothing. Once per feed per session, on the 404 rather than speculatively — an account
that is out of feeds, or a key without write access, must not have that retried behind
the user's typing.

## What is deliberately not here

**The rendered picture.** That is `.bitmap`, which the board actually reads. Publishing
a render here would put two representations of one scene on one group and invite them
to disagree.

**Any board-side consumer.** A board parsing a Konva document to redraw
it locally is a different product. The board gets a bitmap.

**A history of designs.** Ruled out by the 1 KB history cap before it was ruled out on
taste, but it would be the wrong shape anyway: version history is a repository's job,
and `Export JSON` / `Import JSON` in the editor are the manual doors out and back in.

**Credentials, pins or identity.** The `display` block is geometry, rotation, colour
mode, dither settings and the page background — never a pinout, an Adafruit IO username or a key. That is
what makes the document safe to leave sitting on an account, and the geometry it does
carry is read as advisory anyway: `deserialize(…, { keepDisplay: true })` above keeps
the bench's own descriptor, because a document authored on another machine describes
that machine's idea of the panel.

## Known gaps

- **Last write wins, and nobody is told.** Two browsers editing one display will each
  publish over the other; the loser finds out by watching their canvas change on the
  next activation. There is no merge, no conflict marker and no lock, and for a bench
  tool with one user that is the right amount of machinery.
- **It hydrates on activation only.** Not on a timer and not on a subscription, so a
  scene changed elsewhere while you are sitting in the editor does not arrive until you
  switch displays or reload. Deliberate for now: polling a feed this large on a
  cadence would spend the account's rate limit on a case that almost never happens.
- **A scene over 512 KB is not mirrored.** Since #36 a new picture is on a feed and
  costs the document a few dozen bytes, but a document from before then can still embed
  a large image. Said once, and the document is still saved locally, but that display will
  not open on another machine until its images are moved onto feeds.
- **The clock comparison is best-effort.** See "Who wins": a browser clock hours ahead
  of IO's makes rule 5 swallow a genuine remote edit. Rule 2 covers the common case,
  and closing the rest would mean recording the datum's `created_at` at publish time
  and comparing IO's clock against itself.
