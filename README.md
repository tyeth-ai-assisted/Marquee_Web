# Marquee Web

A browser-based canvas editor for **Adafruit IO Marquee** e-ink displays. It turns
what you draw into epaper-ready bitmaps entirely in the browser and publishes them
to Adafruit IO feeds. It is a static site: no server, no build step, and everything
it remembers lives in your browser's localStorage.

## Requirements

* Browser must be capable of Web Serial (Chrome, Edge, Firefox)

## Development
### Running Locally

The app itself has no runtime dependencies and no build step.

Bring up Marquee Web:
```sh
git clone https://github.com/adafruit/Marquee_Web.git
cd Marquee_Web
npm ci     # optional: installs Miniflare so URL photo imports work locally
npm start
```

`npm start` serves `public/` and, when Miniflare is installed, also runs the photo
importer Worker from `worker/` on the same origin so pasted album and image URLs
work locally. See [worker/README.md](worker/README.md#run-locally).

## Bitmap Rendering

Everything you draw on the canvas is rendered, dithered, palette-remapped by
`public/js/canvas/bitmap.js`. 

`bitmap.js` is a pure-JS port of a subset of the ImageMagick CI pipeline and implements the following `magick` (ImageMagick) command only:
```
magick in.png -dither FloydSteinberg -define dither:diffusion-amount=N% \
  -remap eink-<type>.png gif:- | magick gif:- -compress none BMP3:-
```

## Credential Storage

Your Adafruit IO Key and Wi-Fi credentials are stored in your browser's `localStorage` and written to the hardware's USB MSC volume.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Adafruit Industries.
