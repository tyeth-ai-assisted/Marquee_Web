import worker, { extractHTML } from "../../worker/index.js";
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/test/extract")
      return Response.json(
        await extractHTML(await request.text(), "https://example.com/gallery"),
      );
    return worker.fetch(request, env);
  },
};
