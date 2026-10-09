// Test-only bridge to the real Workers HTMLRewriter, used by fixtures and live CI.
import { extractHTML, bounded } from "../../worker/index.js";
import { publicURL } from "../../worker/discovery.js";
export default {
  async fetch(request) {
    const source = publicURL(
      new URL(request.url).searchParams.get("source"),
    ).href;
    const html = new TextDecoder().decode(
      await bounded(request, 2 * 1024 * 1024),
    );
    return Response.json(await extractHTML(html, source));
  },
};
