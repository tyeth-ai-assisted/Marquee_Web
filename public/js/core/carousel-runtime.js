import { playbackIndex } from "./album.js";
/** One async load per node. The injected IO/decoder keeps race handling testable. */
export function createCarouselRuntime({
  resolve,
  decode,
  apply,
  settle,
  generation,
}) {
  const loads = new WeakMap();
  return async function refresh(
    g,
    { step = null, now = Date.now(), advance = true } = {},
  ) {
    if (loads.has(g)) return loads.get(g);
    const gen = generation(g);
    const task = (async () => {
      await settle(g);
      if (gen !== generation(g) || !g.getLayer()) return false;
      if (!advance && step === null) return !!g.getAttr("imageObj");
      const items = g.getAttr("items") || [];
      if (!items.length) return false;
      const state = {
        index: g.getAttr("slideIndex"),
        shownAt: g.getAttr("shownAt"),
        interval: g.getAttr("interval"),
        paused: g.getAttr("paused"),
        order: g.getAttr("order"),
        seed: g.getAttr("seed"),
      };
      const start =
        step === null
          ? playbackIndex(items, state, now)
          : ((state.index || 0) + step + items.length) % items.length;
      if (step === null && start === state.index && g.getAttr("imageObj"))
        return true;
      for (let n = 0; n < items.length; n++) {
        const index = (start + n) % items.length;
        let item = items[index],
          problem = "";
        try {
          item = await resolve(item);
        } catch (e) {
          problem = e.message;
        }
        if (gen !== generation(g) || !g.getLayer()) return false;
        if (!item.src) continue;
        const img = await decode(item.src);
        if (gen !== generation(g) || !g.getLayer()) return false;
        if (!img) continue;
        g.setAttrs({
          slideIndex: index,
          shownAt: now,
          carouselProblem: problem,
        });
        apply(g, img, item.src);
        return true;
      }
      g.setAttr(
        "carouselProblem",
        "No pictures could be loaded. Edit the album to retry or replace URLs.",
      );
      return false;
    })();
    loads.set(g, task);
    try {
      return await task;
    } finally {
      if (loads.get(g) === task) loads.delete(g);
    }
  };
}
