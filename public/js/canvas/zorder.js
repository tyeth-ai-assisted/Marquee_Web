/**
 * Stacking order of the canvas elements.
 *
 * There is no `z` attribute anywhere: the order of the element nodes in the content
 * layer IS the stacking order, and serialize() writes them in that order, so the saved
 * `elements` array is the z-order too (first = bottom). Everything here keeps those two
 * in step — the user's Layer controls on the way in, and deserialize()'s late-arriving
 * images on the way back out.
 *
 * Only siblings named 'element' count. The layer also holds the transformer, and an
 * op that "moved backward" past it would change nothing anyone can see.
 *
 * Imports nothing, and takes the nodes it works on as arguments, so it runs under
 * plain node against a real Konva.Group (see test/zorder.test.js).
 */

/**
 * The four Layer controls, topmost first — the order the context menu lists them.
 * `glyph` is the inspector's compact button face; `keys` is the shortcut
 * selection.js binds (⌘ reads as Ctrl off a Mac, as the rest of the hints do).
 */
export const Z_OPS = [
  { op: 'front', label: 'Bring to front', glyph: '⤒', keys: '⇧⌘]' },
  { op: 'forward', label: 'Bring forward', glyph: '↑', keys: '⌘]' },
  { op: 'backward', label: 'Send backward', glyph: '↓', keys: '⌘[' },
  { op: 'back', label: 'Send to back', glyph: '⤓', keys: '⇧⌘[' },
];

/**
 * Where an element at `index` of `count` ends up after `op`. Pure, so the arithmetic
 * is testable without a canvas. Unknown ops leave it where it is.
 */
export function zOrderTarget(count, index, op) {
  if (op === 'front') return count - 1;
  if (op === 'back') return 0;
  if (op === 'forward') return Math.min(count - 1, index + 1);
  if (op === 'backward') return Math.max(0, index - 1);
  return index;
}

/** The element siblings of `node`, bottom first. */
function elementSiblings(node) {
  const parent = node.getParent();
  return parent ? parent.getChildren((n) => n.hasName('element')) : [];
}

/** Where `node` sits: `index` 0 is the bottom, `count - 1` the top. */
export function stackPosition(node) {
  const els = elementSiblings(node);
  return { index: els.indexOf(node), count: els.length };
}

/** Whether `op` would move `node` at all — so a control that can't is shown disabled. */
export function canRestack(node, op) {
  const { index, count } = stackPosition(node);
  return index >= 0 && zOrderTarget(count, index, op) !== index;
}

/**
 * Apply a Layer control to one element. Returns whether anything moved, so a caller
 * can skip the redraw (and the autosave it triggers) on a no-op — "bring forward"
 * on the topmost element, say.
 *
 * One primitive covers all four: zIndex(i) re-inserts the node at the target's
 * current slot, which lands it just above the target when moving up and just below
 * it when moving down.
 */
export function restack(node, op) {
  const els = elementSiblings(node);
  const i = els.indexOf(node);
  if (i < 0) return false;
  const j = zOrderTarget(els.length, i, op);
  if (j === i) return false;
  node.zIndex(els[j].zIndex());
  return true;
}

/**
 * Put a node that arrived late back into its saved slot.
 *
 * `slots` holds the nodes of a document by saved index, null where one has not been
 * built yet (an image still decoding, or one that never will). The newcomer at
 * `index` was added on top; it belongs directly beneath the first LATER slot that is
 * already on the canvas. Everything already placed is in saved order, so that one move
 * keeps it so, whatever order the decodes finish in.
 */
export function placeInSavedOrder(node, slots, index) {
  slots[index] = node;
  for (let j = index + 1; j < slots.length; j++) {
    const above = slots[j];
    if (above && above.getParent() === node.getParent()) {
      node.zIndex(above.zIndex());
      return;
    }
  }
}
