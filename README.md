# Marquee Web

A browser-based canvas editor for **Adafruit IO Marquee** e-ink displays. It turns
what you draw into epaper-ready bitmaps entirely in the browser and publishes them
to Adafruit IO feeds. It is a static site: no server, no build step, and everything
it remembers lives in your browser's localStorage.

## Requirements

* Browser must be capable of Web Serial (Chrome, Edge, Firefox)

## Development
### Running Locally

There is nothing to install, this repo has no runtime or dev
dependencies. 

Bring up Marquee Web:
```sh
git clone https://github.com/adafruit/Marquee_Web.git
cd Marquee_Web
npm start
```

## Bitmap Rendering

Everything you draw on the canvas is rendered and palette-remapped by
`public/js/canvas/bitmap.js`. Only pictures are dithered: each one is dithered on its
own, at the size it is drawn, with the panel's default or its own setting
(`public/js/canvas/imagedither.js`). The whole panel is then snapped to the nearest
palette colour, so text, charts and shapes are never dithered.

Text under 8 px in the editor's Mono, Sans or Serif is drawn from bitmap fonts rather
than by the browser: Tom Thumb 3×5 for 4–6 px and the classic Adafruit GFX 5×7 for 7 px
(`public/js/canvas/pixelfont.js`, generated from the Adafruit GFX Library by
`scripts/gen-pixelfonts.mjs`). Every pixel is ink or paper, and the result is the same
on every operating system, where the browser's generic fonts are not.

`bitmap.js` is a pure-JS port of a subset of the ImageMagick CI pipeline and implements the following `magick` (ImageMagick) command only:
```
magick in.png -dither FloydSteinberg -define dither:diffusion-amount=N% \
  -remap eink-<type>.png gif:- | magick gif:- -compress none BMP3:-
```

## Credential Storage

Your Adafruit IO Key and Wi-Fi credentials are stored in your browser's `localStorage` and written to the hardware's USB MSC volume.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Adafruit Industries.
