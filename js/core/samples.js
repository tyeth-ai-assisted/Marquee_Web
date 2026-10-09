/**
 * Which parts of a serialized element are a READING, and which are the design.
 *
 * The distinction did not need a name until something started re-reading feeds on its
 * own. serialize() bakes the last sample of every bound element into the document —
 * deliberately, because that is what makes a state change part of the pushed take rather
 * than a live-only detail (see the notes in doc.js) — and for as long as a refresh only
 * ever followed a click, "the document changed" and "the user changed something" were the
 * same sentence.
 *
 * device.js now refreshes the bindings on the board's own cycle, and they stop being the
 * same sentence. Two places downstream were quietly built on them being one:
 *
 *   countQueuedChanges()  counts elements that differ from what was published, and would
 *                         report "3 changes queued" about three thermometers nobody
 *                         touched, inviting a push of something already sent.
 *   canvasfeed.js         mirrors the scene to {group}.canvas-state, and would put a
 *                         fresh copy of the whole document — embedded images and all — on
 *                         IO once per board cycle, forever, per open tab.
 *
 * Both ask the same question, so the answer lives here once. Bottom of the module graph,
 * on purpose and for two reasons: state.js imports it and imports nothing else, and a pure
 * module with no DOM and no Konva is one `node --test` can actually reach — which matters
 * more here than usual, because every failure mode of this file is silent. Strip too
 * little and the phantom counts come back; strip too much and a real edit is swallowed.
 *
 * The table is doc.js#serialize() read backwards: every key named below is written by
 * applyFeedValue() or refreshChart() and by nothing a user can reach.
 */

/**
 * The sampled keys, by etype.
 *
 * `label` is the subtle one and the one worth reading twice. A linked label's `text` is
 * not authored — applyFeedValue() recomputes it from the reading through
 * linkedLabelText(), so it moves every time the feed does. An UNLINKED label's `text` is
 * the most authored thing on the canvas, so this key can only be stripped when there is a
 * feedKey to have derived it, which is why stripSamples() below is a function rather than
 * a lookup. `feedPrefix`/`feedSuffix` stay: they are how the user chose to wrap the value.
 *
 * `datetime` gives up `timeValue`, the string IO last rendered. Its `text` is never
 * serialized (the factory derives it), so there is nothing else to strip.
 *
 * `linechart` gives up `series` (the fetched points) and keeps `feeds` (which feeds are
 * bound, which is a design decision) and `data` (the authored sample series, written only
 * when nothing is bound).
 *
 * `feedimage` gives up the picture — `src` and the natural size that came with it — on
 * the same terms as the label's `text`: only while a feedKey says a feed put it there.
 * Unlinked, the picture it kept is the one the user chose to keep. The frame (`w`, `h`,
 * `fit`) is the design and always stays.
 */
export const SAMPLE_KEYS = {
  label: ['feedValue', 'text'],
  indicator: ['value'],
  battery: ['feedValue'],
  gauge: ['gaugeValue'],
  linechart: ['series'],
  // The time IS the reading, and it changes on every take. Format and zone stay.
  datetime: ['timeValue'],
  feedimage: ['src', 'natW', 'natH'],
  carousel: ['src', 'natW', 'natH', 'slideIndex', 'shownAt'],
};

/**
 * The keys above that are only a reading when the element is bound — see the notes on
 * `label` and `feedimage`. Everything else in the table is a reading unconditionally.
 */
const LINKED_ONLY = new Set(['text', 'src', 'natW', 'natH']);

/**
 * One element with its readings dropped, as a new object — never a mutation. Callers pass
 * the live serialize() output straight through on its way to localStorage and to IO, and
 * a stripper that edited it in place would quietly delete the samples the take is
 * supposed to carry.
 *
 * An etype this table has never heard of is returned untouched. Guessing at the samples of
 * a widget added after this was written would strip authored data, and the failure mode of
 * being too cautious here is a phantom change count — visible, and merely annoying.
 */
export function stripSamples(el) {
  if (!el || typeof el !== 'object') return el;
  const keys = SAMPLE_KEYS[el.etype];
  if (!keys) return el;
  const out = { ...el };
  for (const k of keys) {
    // The one conditional in the file: see the notes on `label` and `feedimage` above.
    if (LINKED_ONLY.has(k) && out.etype !== 'carousel' && !out.feedKey) continue;
    delete out[k];
  }
  return out;
}

/** A whole document with every element's readings dropped. */
export function withoutSamples(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  if (!Array.isArray(doc.elements)) return { ...doc };
  return { ...doc, elements: doc.elements.map(stripSamples) };
}

/**
 * Are these two documents the same SCENE — same elements, same panel, differing in
 * nothing but what the feeds happened to be saying?
 *
 * Null-safe in both directions, and two absent documents are deliberately NOT "the same":
 * every caller is asking "may I skip this work", and skipping on the strength of having
 * nothing to compare is how a first publish gets lost.
 */
export function sameDesign(a, b) {
  if (!a || !b) return false;
  return JSON.stringify(withoutSamples(a)) === JSON.stringify(withoutSamples(b));
}
