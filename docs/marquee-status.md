# The status feed — `{group}.status`

How the board tells the editor what it is actually doing. Two moments, one field
required, and nothing else.

- **Producer:** the board's firmware. **Not yet implemented** — see Known gaps.
- **Consumers:** two, both browser-direct through `readFeedData()` in
  `public/js/device/feeds.js`.
  - The status watch in `public/js/device/device.js` (`pumpStatus`, `applyStatus`,
    `watchForStatus`) polls the **active** display's feed continuously.
  - The display list, `public/js/screens/a1.js` (`sweepStatus`), reads **every other**
    display's feed once per visit. A record carries its own group key, so this needs no
    activation. It exists because those tiles used to render a stored snapshot of flow
    state, which is only ever written for the active device — so every other tile was
    frozen at whatever its board was doing the last time it was open, and a board
    typically freezes just after a push, reading "On air" for good while it slept.
    The same batch's newest `sleeping` report also supplies the board's own `sleep_time`
    and `alarm_type` to the tile's schedule line (`reportedSleep()` in
    `public/js/device/schedule.js`; see `marquee-sleep.md`, "Reading it back").

This exists because nothing else acknowledges anything. Without it the editor is
left inferring the board's entire life from the sleep window it published —
`deviceState` went to `asleep` because we sent something, not because a board said
so. Everything downstream of that was a guess: when the panel would redraw, when the
next wake was due, and whether a queued take had reached the glass.

## The feed key

`{ADAFRUIT_IO_GROUP}.status` — the `status` feed inside the device's Adafruit IO
group, in IO's group-qualified form. With the default group `marquee`, that is
`marquee.status`.

Derived, not configured (`statusFeedKey()` in `public/js/core/api.js`, sharing
`siblingFeed()` with `sleepFeedKey()`), so renaming the image feed to `kitchen` moves
all three feeds together and they cannot drift apart.

**It must be a separate feed from `.sleep`, not a second use of it.** That feed is
read by the firmware as "the last value is my window". A board writing its own status
there would shadow its own config within one cycle — and it would win that race
almost always, because it publishes every cycle while the editor publishes only when
someone pushes. One writer per feed keeps `/data/last` unambiguous in both
directions.

**Keep feed history ON.** The editor reads the last few data points, not just the
last one, so a poll that lands after both transitions can still see them. That caps
the value at 1 KB (`IO_MAX_HISTORY` in `public/js/core/api.js`) — which the payload below
must stay comfortably under.

## Worked example

```json
{"state": "awake", "wake_reason": "timer"}
```

```json
{"state": "sleeping", "sleep_time": 900, "alarm_type": "timer"}
```

Published as the feed's `value`, so the consumer reads a **string** and parses it —
same convention as `.sleep`.

## Fields

### `state` — `"awake"` | `"sleeping"`

**The only required field.** Everything reads this first and ignores what it does not
recognise.

| value | published when | the editor does |
|---|---|---|
| `awake` | the board has connected | stops the countdown, `deviceState` → `online-awake`, Showtime says the display is awake and redrawing |
| `sleeping` | the board is arming its alarm | promotes the queued take, then starts the countdown from this datum's `created_at` |

Those two values are the editor's whole state vocabulary. The chrome shows exactly
three — `Sleeping 💤`, `Awake - Redrawing 🎨`, and `Offline` — where the first two are
this field and the third is the one thing this feed cannot report (see Fallbacks). What
used to be extra states — modelled vs reported, timed vs pin, due-back — are differences
in how far the *numbers* can be trusted, not in what the board is doing, so they show up
in the countdown's caption and prose rather than as states of their own.

`displayState()` in `public/js/device/cycle.js` is the single derivation, imported by the
chrome pill (`router.js`), the Showtime bar (`screens/a8.js`) and the display-list tiles
(`screens/a1.js`). The PARSE and the READING are shared from the same file for the same
reason — `parseStatus()` and `readReport()` turn a batch of data into a flow patch, and
`reportIsOverdue()` is the offline judgement, so the watch and the tile wall cannot grow
separate ideas of what a payload means. It lives in its own
module because `device.js` imports `router.js`, so the reading cannot live in either of
those without closing a cycle — and because two copies of it drifted apart the first
time: the pill read `deviceState` alone and said Sleeping while the countdown beside it
was already showing a redraw.

The pair is worth more than either message alone, because it **brackets the take**, and
that is what lets the editor move "On the panel now" without the board having to report
which image it drew. **`sleeping` is the acknowledgement**: the producer subscribes to the
bitmap feed and stays subscribed for as long as it is up, and `loop()` draws a pending
image before it acts on a pending sleep — so everything on the image feed at the moment
the board reports sleeping has been drawn, *including* a take published mid-wake.

So the cut is the LATEST report of either kind, not the wake. Reading the wake as the
exact moment of collection — right for a board that polls `/data/last` once on connecting
and is then unreachable — left the ordinary case broken: push while the board is up, and
the take is newer than the last `awake`, so nothing is ever confirmed drawn and the left
panel claims "nothing confirmed on the glass" about the image physically in front of you
until the next wake happens to be reported.

### `sleep_time` — integer seconds

The timer the board **actually armed**, which is not necessarily the one the editor
asked for on `.sleep`. Same name and units as that feed on purpose: a field-by-field
diff between the two feeds' last values is what exposes a board still sleeping on its
own default interval.

Absent means "the board didn't say", and the editor falls back to `refreshInterval()`.
It must never be read as `0` — that is a legal value meaning "do not sleep on the
timer" (see `docs/marquee-sleep.md`).

### `alarm_type` — `"timer"` | `"pin"` | `"timer+pin"`

What the board armed, in the same vocabulary `.sleep` uses to ask for it. Drives
`wakeSource` in `state.js`, which is how the clock decides whether there is a wake
*time* to count down to at all: a `pin` board sleeps until a finger lands on the button,
so `nextWakeAt()` returns null and the readout is `--:--`. Note that this changes the
figure, not the state — the board is asleep either way, and a pin alarm is not a fourth
thing for the chrome to say.

### `wake_reason` — `"timer"` | `"pin"` | `"reset"`

On `awake` only, from whatever the firmware can tell about the alarm that woke it
(absent on a cold boot). Surfaced on the status line. It is what distinguishes a
button press from a scheduled
take, and a first boot from a cycle.

## Extending it

Additive keys only, and **no version field**. Unknown keys are ignored, missing keys
mean "not reported", so a new field is never a breaking change. A version number only
earns its keep if a consumer *rejects* on mismatch, and the right behaviour on both
sides here is always "read what you understand" — a version would only invite a
consumer to refuse a payload it could have used most of.

The next field is likely `wake_pin`, sitting beside `alarm_type` and `wake_reason`:

```json
{"state": "sleeping", "sleep_time": 900, "alarm_type": "timer+pin", "wake_pin": "D15"}
{"state": "awake", "wake_reason": "pin", "wake_pin": "D15"}
```

Note the direction: the editor deliberately does **not** tell the board which pin to
use (`docs/marquee-sleep.md`, "What is deliberately not here"), because that is a fact
about how the board is wired. The board reporting what it armed is the harmless
inverse of that.

## What is deliberately not here

**Whether the board drew.** It is inferable from the `awake`/`sleeping` bracket, and a
`drew` flag would be a second source of truth for a question the pair already answers.

**Battery voltage.** It belongs on its own feed, where `refreshFeedElements()` and
`readFeedHistory()` can already bind it to a battery element and chart it. Inside this
payload it would be unreadable by any of that.

**Anything about the panel** — the display descriptor, which travels with the
layout in `canvas.json`.

**Errors, tracebacks, or anything unbounded.** The 1 KB history-on ceiling is the
budget, and a short code is always enough.

## Fallbacks — what silence means

A board running older firmware publishes nothing, and that has to keep working.

- **No status has ever arrived** → the state and the clock are both modelled from the
  window that was published (`displayState`/`nextWakeAt` in `public/js/device/cycle.js`), and
  the queued take is promoted by `scheduleQueuedWrite`'s timer. All estimates, and the
  sub line says so.
- **A status has arrived at some point, and then the board goes quiet** past
  `TAKE_CEILING_MS` plus a 60s grace (`REPORT_GRACE_MS`) → `deviceState` → `offline`. A board that has
  proved it reports can be judged for not reporting; one that never has, cannot. The clock
  runs from when the board is next due to speak, floored at when the watch started, so a
  tab backgrounded for an hour does not call a healthy board dead the moment it resumes.
- **The feed is unreadable** (missing, no credentials, network down) → unknown, not
  "nothing happened". `readFeedData` resolves `null` and the watch keeps looking,
  matching `readFeedValue`'s contract.
- **The value will not parse** → treated as `{"state": <the trimmed string>}`, so a
  bare `awake` works. An unrecognised state is ignored and does **not** count as a
  report, so it cannot retire the fallback for nothing.

## The editor's side of the read

`pushToDisplay()` seeds the cursor with `resetStatusWatch()` before it publishes —
so a status left over from a previous bench run cannot be credited to this cycle —
and starts `watchForStatus()` once the push lands.

**The seed reads a batch and keeps an open bracket.** If the newest datum is an `awake`,
`adoptOpenTake()` takes it as `lastAwakeAt` before the cursor moves past it. That is not
replaying history, it is reading current state: the last thing the board said was "I am
up". Seeding from a single datum instead threw that away, and a push landing while the
board was mid-take then had no wake to compare a queued take against and nothing for the
watch to wait on but a guess. A `sleeping` at the head is still ignored — that is the case
the seed exists for, and adopting it would start this cycle's clock from a previous alarm.

Polling is confined to the window the board could plausibly be up in: nothing can
arrive during the sleep, and IO's rate limit is a budget shared with every element
binding on the canvas. While a take is in flight the window also **opens late** — nothing
can be published before the redraw physically finishes — which pays for the longer
deadline: a healthy cycle costs about the same handful of reads it always did, and only a
board that has actually died runs the window out.

### There is no countdown

The editor does not predict when the next take will happen, and does not draw a clock. It
reports the state this feed last published, and prints the board's own timestamps beside
it — `board reported · woke 4:39:35 PM · slept 4:41:38 PM · awake 123s`.

That is a deliberate retreat from a modelled cycle, which was tried and did not survive
hardware. Predicting a wake needs a cycle period, a period needs the time a take takes, and
a take is bounded by the driver rather than by the image:

| `EPaperDisplay` parameter | default | when it bites |
|---|---|---|
| `refresh_time` | 40s | **Only when `busy_pin` is None.** With BUSY wired the driver polls it and returns as soon as the glass is done; without it, it sleeps this flat interval. |
| `seconds_per_frame` | 180s | The minimum between refreshes. A take that comes round sooner blocks — awake, at full power — until the frame is old enough. |

Measured on a 2.13" tri-color FeatherWing, whose preset leaves BUSY unwired: an 83.3s
cooldown then a 40.0s draw, 123s of panel work against a fitted estimate of 14s. Every
number downstream of that estimate was wrong, including the one that decided how long to
keep listening — the watch gave up 86s into that take and reported "no report ever" about a
board that was mid-refresh.

Two numbers survive, neither of them shown to anyone:

- `TAKE_CEILING_MS` (5 min) in `cycle.js` — how long the board gets to say
  something before it is called offline. A watchdog, not a model, and generously past the
  worst take this hardware can produce.
- `FALLBACK_TAKE_S` (240s) in `device.js` — used only to promote a queued take onto
  "On the panel now" for a board that reports nothing at all. Being late shows a stale
  image for a moment; being early claims a redraw that never happened.

The consequence worth designing around: **a sleep window shorter than `seconds_per_frame`
does not make the panel redraw faster.** It moves the waiting out of light sleep and into a
blocked refresh. A 30s window on this panel means the board is awake roughly 123s out of
every 153s.

## Known gaps

- **The two surviving estimates are flat constants.** `TAKE_CEILING_MS` and
  `FALLBACK_TAKE_S` are budgeted from the `EPaperDisplay` defaults rather than read from
  the board. They are only ever used to decide when to stop waiting, so being generous
  costs nothing — but if the firmware sets a per-driver refresh time, that is a fact
  about the display setup and belongs in the descriptor beside the pins.
- **The fallback path is still the one most boards are on.** Firmware that publishes
  neither transition keeps working: the state and the clock are modelled, and the sub line
  says so. Everything above assumes the producer is present.
- **No `.status` write from the editor, ever.** If a future feature needs the editor
  to talk to a running board, it needs its own feed; adding a second writer here
  reintroduces exactly the shadowing problem this feed exists to avoid.
- **A reload mid-cycle does not resume the watch.** `statusCursor` and `statusSeen`
  are module state, and `published` is deliberately not persisted either
  (`state.js`), so a reloaded tab is back to the fallback until the next push.
- **Nothing configures a status-feed key on the board.** Same call as `.sleep`:
  whether the producer derives the key or reads it from its own configuration is its
  business.
