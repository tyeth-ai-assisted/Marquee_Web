# The sleep feed — `{group}.sleep`

How the editor tells the board how long to sleep. Three fields on an Adafruit IO
feed, and nothing else.

- **Producers:** two, sharing one payload builder (`sleepPayloadFor()` in
  `public/js/device/schedule.js`).
  - `pushToDisplay()` / `queueForNextTake()` in `public/js/device/device.js`, via
    `currentSleepPayload()`. Fired by "Push to display" in Act II.
  - The schedule picker on each display's tile in A1 (`changeSchedule()` in
    `public/js/screens/a1.js`), for any display, active or not. It publishes the sleep
    feed only — the image feed is untouched — and saves the interval as that display's
    own setting so the next push agrees with it.
- **Consumer:** the board's firmware. **Not yet implemented** — see Known gaps.

A feed rather than a field in the panel descriptor: timing is not a property of the
panel, and nothing about changing the interval should require reconfiguring the
board. Before this feed, the editor's "Wake and redraw" control had no route to the
board at all — the sleep window was a constant compiled into the firmware.

## The feed key

`{ADAFRUIT_IO_GROUP}.sleep` — the `sleep` feed inside the device's Adafruit IO
group, in IO's group-qualified form. With the default group `marquee`, that is
`marquee.sleep`.

Derived, not configured (`sleepFeedKey()` in `public/js/core/api.js`). Two independently
settable keys is two ways for a board to end up reading one feed and not the
other, and the pairing is not a decision anyone needs to make. Renaming the group
to `kitchen` moves the sleep window to `kitchen.sleep` with it, along with
`kitchen.bitmap` and `kitchen.status`.

**Both feeds must already exist on the account.** The IO data API 404s on an
unknown feed key; it does not create one for you. A5b (`public/js/screens/a5b.js`)
is what creates them, which is why it runs before the board is flashed.

## Worked example

```json
{"alarm_type": "timer", "sleep_mode": "deep", "sleep_time": 900}
```

Published as the feed's `value`, so the consumer reads a **string** and parses it:

```python
resp = session.get(".../feeds/marquee.sleep/data/last", headers={"X-AIO-Key": key})
cfg = json.loads(resp.json()["value"])
```

## Fields

### `alarm_type` — `"timer"`

What the board arms before it sleeps. **The editor always sends `"timer"`:** one
time alarm at `sleep_time` seconds. There is no wake-on-button choice in the UI any
more — the interval is the only sleep control — so the field is a constant on the
producer side. It stays in the payload so the feed keeps one shape for a consumer
that already parses it, and so a future value has a slot to land in.

A consumer should still treat the field as a string it may not recognise (see
Fallbacks) rather than assuming the constant.

### `sleep_mode` — `"light"` | `"deep"`

**Derived from `sleep_time`, not chosen.** There is no sleep-mode control in the
editor: the interval already determines the right answer, and a second author for
one decision is how the editor and the board end up disagreeing — a 15-second
refresh set to Deep paid a full boot, re-provision and redraw every fifteen
seconds, and nothing in the UI said so.

| `sleep_time` | `sleep_mode` | why |
|---|---|---|
| < 60 s | `light` | under the MQTT keepalive the connection survives the nap outright — free |
| 60 s – 300 s | `light` | the reconnect is MQTT-only, still cheaper than boot + re-provision + redraw |
| ≥ 300 s | `deep` | past here the boot stops dominating, and holding RAM and a radio that long is the worse trade |

The first two rows agree, so the implementation is a single comparison at 300 s —
`sleepModeFor()` in `public/js/device/schedule.js` (re-exported by `core/config.js`), which returns these two spellings
directly so the label a user sees and the value the board gets cannot drift. The
60 s row is the reasoning, not a value read from anywhere: nothing in the editor
reads a keepalive off the board.

The two are not interchangeable for the consumer: a deep sleep never returns, while
a light sleep resumes in place — so firmware that supports `light` needs its take
wrapped in a loop. Both spellings are reachable from the
editor's own interval picker, so a consumer has to implement both rather than
treating `light` as an exotic case.

### `sleep_time` — integer seconds

The timer duration. Same value as the editor's refresh interval — the
`#sleepDuration` field, surfaced as "Wake and redraw" in A7 and read through
`refreshInterval()`.

**Always present.** `0` means a time alarm in the past, so a consumer should treat
it as "do not sleep on the timer" rather than passing it through.

It now carries two facts rather than one — the duration *and*, through the table
above, the mode. `0` lands in the light band, which is the harmless answer for a
timer that is not going to be slept on anyway.

## What is deliberately not here

**A wake pin, or any wake-on-button option.** The editor used to offer "Button
press" and "Timer or button" alarms; both are gone, and with them any question of
which pin a board wakes on. If a pin alarm ever comes back, the pin itself is a
fact about how the board is wired rather than about this take, so it belongs on
the board with the rest of its configuration, not on this feed.

**Credentials and the group key itself** — written to the board at flash time
(A1-C collects the account, A5b the group, A5C the network, A6-A writes them), as with the image feed.

**Anything about the panel** — the display descriptor, which this file does not
touch. It travels with the layout in `canvas.json`; see
[`marquee-canvas-state.md`](marquee-canvas-state.md).

## Fallbacks — what an absent feed means

A first boot, a feed that was never created, a malformed value, an offline radio:
all of these are the normal state of affairs at some point, and none of them is
an error worth bricking a take over.

- No value, or one that will not parse → fall back to the firmware's own default
  interval and a plain timer.
- `alarm_type` is a value the firmware does not recognise → ignore it and arm a
  timer at `sleep_time`, which is the only thing the editor ever asks for.
- Nothing left to arm → arm a timer alarm at the default interval anyway. **Never
  deep-sleep with no alarm**; a board with no way back is a board that needs a
  USB cable.

## The editor's side of the push

`pushToDisplay()`, in order:

1. Render in the browser (`render.js` -> `bitmap.js`, the only render path).
2. Publish the base64 BMP to the image feed. **The dashboard goes first:** if only
   one of the two writes lands, a board holding a new image and an old sleep
   window still shows the right thing.
3. Publish this JSON to the sleep feed.
4. Navigate to Act III.

### The live take

A push is a snapshot, and a board on a timer is not. It wakes, refetches whatever datum is
on the image feed, and redraws it — so a dashboard built on feed-bound widgets showed the
readings of the moment somebody last pressed something, for as long as nobody pressed
anything again. Measured on the bench: a source feed publishing every 60s, a board cycling
every 72s, and an image feed untouched for thirteen minutes.

So the editor republishes on the board's own cycle. `device.js` ("the live take") re-reads
every bound element, re-renders, and puts the result on the image feed — **only** the image
feed, because the sleep window belongs to the sleep already running.

| | |
|---|---|
| trigger | the board's own `sleeping` report on `{group}.status`, plus `LIVE_SETTLE_MS` (5s) |
| fallback | a board that never reports gets the armed interval as an estimated clock instead |
| floor | `LIVE_MIN_GAP_MS` (30s) between publishes, whatever asked for one |
| de-dupe | the base64 BMP, byte for byte — an unchanged picture is never republished |
| cost | one read per bound element (one per series on a chart), plus at most one publish |
| off switch | per display — the ▶ / ❚❚ switch on its A1 tile (`livePaused` on the record, refused in `liveBlockedBecause()`) |

**Why `sleeping` and not `awake`.** The report means the alarm is armed, so the whole window
is available and nothing is racing a fetch. It is also the only moment the promotion
bracket can credit: a take published now is older than the next `awake`, so `applyStatus()`
promotes it next cycle rather than holding it. And the firmware stays subscribed to the
image feed while it is up, so publishing on `awake` can land mid-take and buy a second
panel refresh — up to two minutes of one on a driver with BUSY unwired.

It will not publish to a display nobody has pushed to, to a canvas with nothing bound, to
a display whose live updates are paused, or while a drag or a focused inspector field says
someone is mid-edit. Failures are said once per session and then logged, like the
`canvas-state` mirror.

It runs for the **active** display only — the one open in the editor — and only while the
tab is open. The pause switch is stored per display so it can be set from any tile; it
takes effect whenever that display is the active one. Switching it back on re-arms the
take (`syncLiveUpdates()`): at once if a reporting board is asleep right now, otherwise on
its next `sleeping`, or on the estimated clock for a board that never reports.

It does not wait for anything, and there is nothing it could wait for — this feed
carries no acknowledgement. Act III's countdown is therefore a client-side estimate
of the window that was published, not a report of the board's state, until the
sibling `{group}.status` feed says otherwise. (That feed can still report a `pin`
alarm the firmware armed on its own; `wakeSource` in `state.js` carries it, and A8
then runs no clock — see `marquee-status.md`.)

### Reading it back — the A1 tiles

Each display's tile on the list shows the schedule it is on — "Sleeps 15 min · timer ·
deep sleep" — from, in order:

1. the newest datum on this feed (`GET .../data?limit=1`; the feed keeps history), which
   is the schedule as **set**;
2. the board's last `sleeping` report on `{group}.status`, when nothing usable has been
   published here — its own `sleep_time` and `alarm_type`, never a substituted default;
3. the display's own `sleepDuration` setting, marked "not published" (or "not confirmed"
   when the feed could not be read).

The feed outranks the board's report so a change shows the moment it is made — the board
keeps reporting the old interval until it next wakes. When the board reports a sleep
**after** the schedule was published and it differs, the tile adds "board slept 5 min":
the one-line diff described under Known gaps below. `pickSleepSchedule()` in
`public/js/device/schedule.js` is the whole rule.

## Known gaps

- **The firmware does not read this feed yet.** It still sleeps on its own default
  interval and ignores `alarm_type` and `sleep_mode` entirely, so the publisher side
  is complete and the round trip is not. This spec is the only copy of the contract
  for whoever writes the consumer.
- **Nothing configures a sleep-feed key on the board.** Whether the consumer wants
  the key from its own configuration or derived from the group key is its call.
- **Nothing reports the board's real state — yet.** `deviceState` goes to `asleep`
  because we published a sleep window, not because a board said so. The answer is
  the sibling `{group}.status` feed (`docs/marquee-status.md`), which the editor
  already reads and no firmware publishes yet. Until one does, Act III models the
  cycle and says so.

  Note what the round trip is worth once it exists: `sleep_time` coming back on
  `.status` is the same field, in the same units, as the one sent here — so a board
  that ignores this feed and sleeps on its own default stops being invisible and
  becomes a one-line diff.
