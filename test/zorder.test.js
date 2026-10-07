/**
 * Stacking order — public/js/canvas/zorder.js, and the order deserialize() rebuilds a
 * document in (public/js/core/doc.js).
 *
 * zorder.js imports nothing and only touches the nodes it is handed, so it runs under
 * plain node against the real vendored Konva: a Konva.Group has the same child list
 * and zIndex() as the content layer, without the <canvas> a Layer would need.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
import { zOrderTarget, restack, canRestack, stackPosition, placeInSavedOrder } from '../public/js/canvas/zorder.js';

// The UMD bundle registers on the global when there is no CommonJS/AMD loader,
// which is exactly how the page's classic <script> tag loads it.
runInThisContext(readFileSync(new URL('../public/js/vendor/konva.js', import.meta.url), 'utf8'));
const { Konva } = globalThis;

/** A stand-in for the content layer: the transformer is added first, as stage.js does. */
function makeLayer() {
  const layer = new Konva.Group();
  layer.add(new Konva.Rect({ name: 'transformer-stand-in' }));
  return layer;
}

const el = (id, etype = 'label') => {
  const n = new Konva.Rect({ id, name: 'element' });
  n.setAttr('etype', etype);
  return n;
};

/** What serialize() writes: the element nodes in tree order. */
const savedOrder = (layer) => layer.find('.element').map((n) => n.id());

/**
 * deserialize()'s build loop, with the decode made explicit: every non-image is built
 * in array order straight away, and the images are built afterwards in `decodeOrder`
 * — the order their onload callbacks happened to fire in.
 */
function load(layer, elements, decodeOrder) {
  layer.find('.element').forEach((n) => n.destroy());
  const slots = new Array(elements.length).fill(null);
  elements.forEach((e, i) => {
    if (e.etype !== 'image') { slots[i] = el(e.id, e.etype); layer.add(slots[i]); }
  });
  decodeOrder.forEach((i) => {
    const node = el(elements[i].id, 'image');
    layer.add(node);                       // addImage() always adds on top
    placeInSavedOrder(node, slots, i);
  });
}

const permutations = (xs) => (xs.length <= 1 ? [xs]
  : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));

// Images interleaved with everything else, including at the very bottom and very top.
const DOC = [
  { id: 'img-bg', etype: 'image' },
  { id: 'title', etype: 'label' },
  { id: 'img-logo', etype: 'image' },
  { id: 'rule', etype: 'divider' },
  { id: 'gauge', etype: 'gauge' },
  { id: 'img-badge', etype: 'image' },
  { id: 'caption', etype: 'label' },
  { id: 'img-top', etype: 'image' },
];
/** The array indices of a document's images — the slots that arrive late. */
const imageSlots = (elements) => elements.map((e, i) => (e.etype === 'image' ? i : -1)).filter((i) => i >= 0);
const IMAGE_SLOTS = imageSlots(DOC);
const byId = (ids) => ids.map((id) => DOC.find((e) => e.id === id));

test('an import keeps the saved order whatever order the images decode in', () => {
  for (const order of permutations(IMAGE_SLOTS)) {
    const layer = makeLayer();
    load(layer, DOC, order);
    assert.deepEqual(savedOrder(layer), DOC.map((e) => e.id), `decode order ${order}`);
  }
});

test('export -> import -> export is stable', () => {
  const layer = makeLayer();
  load(layer, DOC, [...IMAGE_SLOTS].reverse());
  const first = savedOrder(layer);
  const again = makeLayer();
  load(again, byId(first), imageSlots(byId(first)));
  assert.deepEqual(savedOrder(again), first);
});

test('an image that never decodes leaves the others in order', () => {
  const layer = makeLayer();
  // img-logo (index 2) fails: no node, its slot stays null.
  load(layer, DOC, [7, 0, 5]);
  assert.deepEqual(savedOrder(layer), DOC.map((e) => e.id).filter((id) => id !== 'img-logo'));
});

test('a later slot that has been destroyed is not used as an anchor', () => {
  const layer = makeLayer();
  const a = el('a'); const b = el('b');
  layer.add(a); layer.add(b);
  const slots = [a, null, b];
  b.destroy();                              // e.g. deleted before the image decoded
  const img = el('img', 'image');
  layer.add(img);
  placeInSavedOrder(img, slots, 1);
  assert.deepEqual(savedOrder(layer), ['a', 'img']);
});

test('zOrderTarget: front, back, forward, backward and the edges', () => {
  assert.equal(zOrderTarget(5, 2, 'front'), 4);
  assert.equal(zOrderTarget(5, 2, 'back'), 0);
  assert.equal(zOrderTarget(5, 2, 'forward'), 3);
  assert.equal(zOrderTarget(5, 2, 'backward'), 1);
  assert.equal(zOrderTarget(5, 4, 'forward'), 4);
  assert.equal(zOrderTarget(5, 0, 'backward'), 0);
  assert.equal(zOrderTarget(5, 2, 'sideways'), 2);
});

test('restack moves among the elements only, never past the transformer', () => {
  const layer = makeLayer();
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => { const n = el(id); layer.add(n); return n; });

  assert.equal(restack(d, 'back'), true);
  assert.deepEqual(savedOrder(layer), ['d', 'a', 'b', 'c']);
  // One step back from the bottom is a no-op: the transformer below it does not count.
  assert.equal(canRestack(d, 'backward'), false);
  assert.equal(restack(d, 'backward'), false);
  assert.deepEqual(savedOrder(layer), ['d', 'a', 'b', 'c']);

  assert.equal(restack(d, 'forward'), true);
  assert.deepEqual(savedOrder(layer), ['a', 'd', 'b', 'c']);
  assert.equal(restack(a, 'front'), true);
  assert.deepEqual(savedOrder(layer), ['d', 'b', 'c', 'a']);
  assert.equal(restack(c, 'backward'), true);
  assert.deepEqual(savedOrder(layer), ['d', 'c', 'b', 'a']);
  assert.equal(canRestack(a, 'forward'), false);
  assert.equal(restack(a, 'front'), false);

  assert.deepEqual(stackPosition(b), { index: 2, count: 4 });
  assert.deepEqual(stackPosition(d), { index: 0, count: 4 });
});

test('a restacked scene round-trips in its new order', () => {
  const layer = makeLayer();
  load(layer, DOC, IMAGE_SLOTS);
  // The background image to the front, a label to the back.
  restack(layer.findOne('#img-bg'), 'front');
  restack(layer.findOne('#caption'), 'back');
  const edited = savedOrder(layer);
  assert.equal(edited[0], 'caption');
  assert.equal(edited.at(-1), 'img-bg');

  const reloaded = makeLayer();
  load(reloaded, byId(edited), imageSlots(byId(edited)).reverse());
  assert.deepEqual(savedOrder(reloaded), edited);
});
