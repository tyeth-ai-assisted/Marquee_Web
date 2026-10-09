// Public deployment settings; no credentials live here.
// The photo importer Worker this copy of the app uses for URL imports when the page
// is not served by that Worker (or by `npm start`, which proxies /api/albums itself).
// Users can override it under Album -> Importer connection.
export const albumWorkerUrl = "https://adafruit-marquee-web.tyeth.workers.dev";
