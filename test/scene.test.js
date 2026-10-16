/**
 * The headless scene — public/js/lib/scene.js.
 *
 * Every element type is built here with no editor, stage or page, which is how another
 * host (Adafruit IO's editor, a server renderer) will build them. The round trip is the
 * contract that matters: what a factory is handed, serializeElement() hands back, so a
 * document survives being opened, drawn and saved anywhere.
 *
 * Konva runs from the vendored bundle, as in zorder.test.js. Konva.Text measures its
 * glyphs on a 2D context, so the page gets a canvas stub with a monospace-ish
 * measureText — enough to build nodes, not to draw them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';

const fakeContext = () => new Proxy({}, {
  get: (ctx, prop) => (prop in ctx ? ctx[prop]
    : prop === 'measureText' ? (text) => ({ width: String(text).length * 6 })
    : prop === 'getImageData' ? () => ({ data: new Uint8ClampedArray(4) })
    : () => {}),
  set: (ctx, prop, value) => { ctx[prop] = value; return true; },
});
globalThis.document = { createElement: () => ({ style: {}, getContext: fakeContext }) };

runInThisContext(readFileSync(new URL('../public/js/vendor/konva.js', import.meta.url), 'utf8'));
const { Konva } = globalThis;

const {
  createElement, createImage, serializeElement, buildScene, rebuildWidget, feedImagePlaceholderColors,
} = await import('../public/js/lib/scene.js');

const display = { width: 128, height: 296, rotation: 0, panel: 'magtag', type: 'tricolor', background: '#F2F4EF' };
const INK = '#2F2429', RED = '#D72627';

/** One fully specified element of every type, as canvas.json saves it. */
const ELEMENTS = [
  { etype: 'label', x: 4, y: 6, fill: INK, text: '21.5C', fontSize: 16, fontFamily: 'IBM Plex Mono', align: 'left',
    width: 90, feedKey: 'temp', feedName: 'Temp', feedPrefix: '', feedSuffix: 'C', feedDecimals: 1,
    feedValue: '21.47', background: RED, padding: 3 },
  { etype: 'datetime', x: 8, y: 4, timeFmt: '%H:%M', timeTz: 'America/New_York', timeValue: '14:05',
    fill: INK, fontSize: 14, fontFamily: 'IBM Plex Mono', align: 'left' },
  { etype: 'divider', x: 10, y: 40, fill: INK, width: 200, height: 2 },
  { etype: 'linechart', x: 120, y: 60, w: 160, h: 58, ink: INK, title: 'Temp',
    feeds: [{ key: 'temp', name: 'Temp', color: INK }, { key: 'hum', name: 'Humidity', color: RED }],
    series: { temp: [{ t: '2026-10-12T10:00:00Z', v: 20 }, { t: '2026-10-12T11:00:00Z', v: 22 }], hum: [] },
    hours: 24, xLabel: '', yLabel: 'C', yMin: '', yMax: 30, yScale: 'linear', decimals: 1,
    rawOnly: false, stepped: true, gridLines: true, keyLegend: false, axisFontSize: 8, axisFontFamily: 'IBM Plex Serif' },
  { etype: 'gauge', x: 200, y: 10, w: 80, ink: INK, title: 'Wind', min: 0, max: 50, ringWidth: 10,
    gaugeLabel: 'mph', lowWarn: '', highWarn: 40, decimals: 0, showIcon: true, icon: 'wind',
    warnColor: RED, alarmColor: RED, feedKey: 'wind', feedName: 'Wind', gaugeValue: '12' },
  { etype: 'indicator', x: 250, y: 100, w: 16, ink: INK, onColor: RED, offColor: '#F2F4EF',
    op: 'gt', cmp: '30', feedKey: 'temp', feedName: 'Temp', value: '31' },
  { etype: 'battery', x: 250, y: 4, w: 30, ink: INK, showPct: true,
    conds: [{ op: 'lt', cmp: '20', color: INK }], defaultShade: INK,
    feedKey: 'bat', feedName: 'Battery', feedValue: '80' },
  { etype: 'feedimage', x: 6, y: 70, w: 90, h: 50, fit: 'cover', feedKey: 'alice/doorbell', feedName: 'Doorbell',
    src: 'feed:alice/doorbell' },
];

for (const el of ELEMENTS) {
  test(`${el.etype}: serializeElement gives back what createElement was handed`, () => {
    const node = createElement(Konva, el, display);
    assert.equal(node.getAttr('etype'), el.etype);
    assert.deepEqual(serializeElement(node), el);
  });
}

test('an image round-trips from an already-decoded image', () => {
  const el = { etype: 'image', x: 3, y: 5, src: 'data:image/png;base64,AAAA', w: 40, h: 20, natW: 80, natH: 40 };
  const node = createImage(Konva, { width: 80, height: 40 }, el, display);
  assert.deepEqual(serializeElement(node), el);
});

test('an unsized image fits within 80% of the panel, centred', () => {
  // a MagTag at rotation 0 is landscape: 296×128
  const node = createImage(Konva, { width: 1000, height: 500 }, { src: 'x' }, display);
  assert.deepEqual([node.width(), node.height()], [205, 102]);
  assert.deepEqual([node.x(), node.y()], [Math.round((296 - 205) / 2), Math.round((128 - 102) / 2)]);
});

test('missing attrs default to the panel\'s ink and background, never to random samples', () => {
  const gauge = createElement(Konva, { etype: 'gauge', x: 0, y: 0 }, display);
  assert.equal(gauge.getAttr('ink'), INK);
  assert.equal(serializeElement(gauge).gaugeValue, null);   // Konva drops a null attr; the save keeps it
  const chart = createElement(Konva, { etype: 'linechart', x: 0, y: 0 }, display);
  assert.deepEqual(chart.getAttr('data'), []);
  const lamp = createElement(Konva, { etype: 'indicator' }, { ...display, background: RED });
  assert.equal(lamp.getAttr('offColor'), RED);
  assert.deepEqual([lamp.x(), lamp.y()], [0, 0]);
});

test('a document saved before the fonts were bundled loads in their Plex equivalents', () => {
  const label = createElement(Konva, { etype: 'label', x: 0, y: 0, text: 'a', fontFamily: 'sans-serif' }, display);
  const time = createElement(Konva, { etype: 'datetime', x: 0, y: 0, fontFamily: 'serif' }, display);
  const chart = createElement(Konva, { etype: 'linechart', x: 0, y: 0, axisFontFamily: 'monospace' }, display);
  const unknown = createElement(Konva, { etype: 'label', x: 0, y: 0, text: 'b', fontFamily: 'Comic Sans' }, display);
  assert.deepEqual(
    [label.fontFamily(), time.fontFamily(), chart.getAttr('axisFontFamily'), unknown.fontFamily()],
    ['IBM Plex Sans', 'IBM Plex Serif', 'IBM Plex Mono', 'IBM Plex Mono']);
  assert.equal(serializeElement(label).fontFamily, 'IBM Plex Sans');   // and saves under the new name
});

test('a gauge saved before the gaugeValue rename still loads its reading', () => {
  const gauge = createElement(Konva, { etype: 'gauge', x: 0, y: 0, value: 42 }, display);
  assert.equal(gauge.getAttr('gaugeValue'), 42);
});

test('a linked label recomputes its text from the reading, not the saved string', () => {
  const label = createElement(Konva, { ...ELEMENTS[0], text: 'stale' }, display);
  assert.equal(label.text(), '21.5C');
});

test('the host\'s nodeProps place an element; its own attrs win', () => {
  const props = { x: 50, y: 60, draggable: true, name: 'element', id: 'el1' };
  const placed = createElement(Konva, { etype: 'battery' }, display, props);
  assert.deepEqual([placed.x(), placed.y(), placed.draggable(), placed.id()], [50, 60, true, 'el1']);
  const own = createElement(Konva, { etype: 'label', x: 1, y: 2 }, display, props);
  assert.deepEqual([own.x(), own.y(), own.name()], [1, 2, 'element']);
});

test('an etype this build does not know loads as a label rather than vanishing', () => {
  assert.equal(createElement(Konva, { etype: 'sparkline', x: 0, y: 0 }, display).getAttr('etype'), 'label');
});

test('rebuildWidget redraws from attrs, and says so for an etype with no builder', () => {
  const gauge = createElement(Konva, ELEMENTS[4], display);
  const before = gauge.getChildren().length;
  gauge.setAttr('title', '');
  assert.equal(rebuildWidget(Konva, gauge), true);
  assert.equal(gauge.getChildren().length, before - 1);   // the title text is gone
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(rebuildWidget(Konva, new Konva.Group()), false);
  } finally {
    console.warn = warn;
  }
});

test('buildScene: the page, then every element in saved order', () => {
  const doc = { version: 1, display: { ...display, background: RED }, elements: ELEMENTS };
  const { group, width, height } = buildScene(Konva, doc);
  assert.deepEqual([width, height], [296, 128]);
  const [page, ...elements] = group.getChildren();
  assert.equal(page.fill(), RED);
  assert.deepEqual([page.width(), page.height()], [296, 128]);
  assert.deepEqual(elements.map((n) => n.getAttr('etype')), ELEMENTS.map((e) => e.etype));
});

test('buildScene: the page is snapped to the panel palette, and PAPER when unset', () => {
  const mono = { ...display, type: 'mono' };
  assert.equal(buildScene(Konva, { display: { ...mono, background: RED }, elements: [] }).group
    .getChildren()[0].fill(), INK);   // red is not on a mono panel; ink is nearest
  assert.equal(buildScene(Konva, { display: mono, elements: [] }, { display: mono }).group
    .getChildren()[0].fill(), '#F2F4EF');
});

test('buildScene: images come from the host, by element index', () => {
  const doc = { display, elements: [
    { etype: 'label', x: 0, y: 0, text: 'a' },
    { etype: 'image', x: 0, y: 0, src: 'data:,', w: 10, h: 10, natW: 10, natH: 10 },
    { etype: 'image', x: 0, y: 0, src: 'data:,', w: 10, h: 10, natW: 10, natH: 10 },
  ] };
  const kinds = (images) => buildScene(Konva, doc, { images }).group.getChildren().slice(1)
    .map((n) => n.getAttr('etype'));
  assert.deepEqual(kinds({}), ['label']);   // undecoded images are left out
  assert.deepEqual(kinds({ 2: { width: 10, height: 10 } }), ['label', 'image']);
});

// ---- feed image (#36) ----

const frame = { etype: 'feedimage', x: 0, y: 0, w: 60, h: 40, fit: 'contain', feedKey: 'cam', feedName: 'Cam', src: 'feed:cam' };
const childTypes = (g) => g.getChildren().map((c) => c.getClassName());

test('feedimage: the saved src names the feed, never the picture', () => {
  const pic = { width: 120, height: 60 };
  const node = createElement(Konva, { ...frame, src: 'data:image/png;base64,iVBORw0KGgoAAAA', natW: 120, natH: 60, imageObj: pic }, display);
  assert.equal(node.getAttr('imageObj'), pic);
  const saved = serializeElement(node);
  assert.equal(saved.src, 'feed:cam');
  assert.equal('natW' in saved, false);
  assert.equal('natH' in saved, false);
  assert.deepEqual(saved, frame);
});

test('feedimage: with a picture it draws the picture fitted to the frame', () => {
  const node = createElement(Konva, { ...frame, imageObj: { width: 120, height: 40 } }, display);
  assert.deepEqual(childTypes(node), ['Rect', 'Image']);
  const img = node.getChildren()[1];
  // 120x40 inside 60x40, contained: 60x20, centred vertically
  assert.deepEqual([img.x(), img.y(), img.width(), img.height()], [0, 10, 60, 20]);
});

test('feedimage: without a picture it draws the outlined question mark (#24)', () => {
  const node = createElement(Konva, frame, display);
  assert.deepEqual(childTypes(node), ['Rect', 'Rect', 'Text']);
  const [, outline, mark] = node.getChildren();
  assert.equal(mark.text(), '?');
  assert.equal(outline.stroke(), INK);
  assert.equal(mark.fill(), RED, 'red where the panel has red');
  // Too small for a legible mark: the outline alone.
  assert.deepEqual(childTypes(createElement(Konva, { ...frame, w: 6, h: 6 }, display)), ['Rect', 'Rect']);
});

test('feedimage placeholder: always contrasts with the page, whatever its colour', () => {
  assert.deepEqual(feedImagePlaceholderColors({ type: 'tricolor', background: '#F2F4EF' }), { outline: INK, mark: RED });
  // A black page: the outline goes paper-white, so the frame cannot vanish into it.
  assert.deepEqual(feedImagePlaceholderColors({ type: 'mono', background: INK }), { outline: '#F2F4EF', mark: '#F2F4EF' });
  // A red page: the mark is not drawn red-on-red.
  const onRed = feedImagePlaceholderColors({ type: 'tricolor', background: RED });
  assert.notEqual(onRed.mark, RED);
  assert.notEqual(onRed.outline, RED);
  // gray4 has no red; a dark grey page gets the paper.
  assert.equal(feedImagePlaceholderColors({ type: 'gray4', background: '#70696B' }).outline, '#F2F4EF');
});

test('buildScene: a feed image is always drawn, with its picture when the host decoded one', () => {
  const doc = { display, elements: [frame, { ...frame, x: 70 }] };
  const els = buildScene(Konva, doc, { images: { 1: { width: 10, height: 10 } } }).group.getChildren().slice(1);
  assert.deepEqual(els.map((n) => n.getAttr('etype')), ['feedimage', 'feedimage']);
  assert.ok(!els[0].getAttr('imageObj'));
  assert.deepEqual(childTypes(els[1]), ['Rect', 'Image']);
});

test('feedimage: an unsized frame is a third of the panel, centred', () => {
  const node = createElement(Konva, { etype: 'feedimage', feedKey: 'cam' }, display);
  // 296x128 landscape: 99 wide, 74 high
  assert.deepEqual([node.getAttr('w'), node.getAttr('h')], [99, 74]);
  assert.deepEqual([node.x(), node.y()], [Math.round((296 - 99) / 2), Math.round((128 - 74) / 2)]);
});
