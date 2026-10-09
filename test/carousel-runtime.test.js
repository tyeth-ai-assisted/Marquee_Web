import test from "node:test";
import assert from "node:assert/strict";
import { createCarouselRuntime } from "../public/js/core/carousel-runtime.js";
const make = () => ({
  attrs: {
    items: [{ src: "first" }, { src: "second" }],
    slideIndex: 0,
    shownAt: 1,
    interval: 60,
    imageObj: {},
  },
  live: true,
  getAttr(k) {
    return this.attrs[k];
  },
  setAttrs(v) {
    Object.assign(this.attrs, v);
  },
  setAttr(k, v) {
    this.attrs[k] = v;
  },
  getLayer() {
    return this.live;
  },
});
function setup(options = {}) {
  return createCarouselRuntime({
    resolve: async (i) => i,
    decode: async (src) => ({ src }),
    apply(g, img, src) {
      g.setAttrs({ imageObj: img, src });
    },
    settle: async () => {},
    generation: (g) => g.attrs.gen || 0,
    ...options,
  });
}
test("preview settles but does not advance; take advances after decode", async () => {
  const g = make(),
    load = setup();
  assert.ok(await load(g, { now: 100000, advance: false }));
  assert.equal(g.attrs.slideIndex, 0);
  assert.ok(await load(g, { now: 100000 }));
  assert.equal(g.attrs.slideIndex, 1);
  assert.equal(g.attrs.src, "second");
});
test("a rebound or removed node discards a late download", async () => {
  let resume;
  const g = make();
  const load = setup({ resolve: () => new Promise((r) => (resume = r)) });
  const p = load(g, { now: 100000 });
  await new Promise((r) => setImmediate(r));
  g.attrs.gen = 1;
  resume({ src: "late" });
  assert.equal(await p, false);
  assert.equal(g.attrs.slideIndex, 0);
  const h = make();
  const next = setup({
    decode: async () => {
      h.live = false;
      return {};
    },
  });
  assert.equal(await next(h, { now: 100000 }), false);
});
test("source failure uses embedded fallback and preserves a visible error", async () => {
  const g = make();
  assert.ok(
    await setup({
      resolve: async () => {
        throw new Error("Source expired");
      },
    })(g, { now: 100000 }),
  );
  assert.equal(g.attrs.src, "second");
  assert.equal(g.attrs.carouselProblem, "Source expired");
});
test("all decode failures retain old image and do not consume a slide", async () => {
  const g = make(),
    image = g.attrs.imageObj;
  assert.equal(
    await setup({ decode: async () => null })(g, { now: 100000 }),
    false,
  );
  assert.equal(g.attrs.imageObj, image);
  assert.equal(g.attrs.slideIndex, 0);
  assert.equal(g.attrs.shownAt, 1);
});
test("concurrent takes share one download and settle before resolving another frame", async () => {
  let resolve,
    count = 0;
  const g = make();
  const load = setup({
    resolve: (i) => {
      count++;
      return new Promise((r) => (resolve = () => r(i)));
    },
  });
  const a = load(g, { now: 100000 }),
    b = load(g, { now: 100000 });
  await new Promise((r) => setImmediate(r));
  assert.equal(count, 1);
  resolve();
  assert.ok(await a);
  assert.ok(await b);
  assert.equal(g.attrs.slideIndex, 1);
});
