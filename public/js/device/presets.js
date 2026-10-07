/**
 * The supported-panel catalog.
 *
 * One entry per board Marquee knows how to fill in. Each carries both halves of
 * what the flow needs: the marketing side A4 shows on a product card (label,
 * spec line, search terms) and the wiring side the Settings modal writes into the
 * display descriptor (resolution, rotation, color mode, driver, panel id, SPI pins).
 *
 * Rotation and resolution are the UNROTATED framebuffer as the firmware sees it,
 * with `rotation` as the clockwise 90° step the device applies on top. That
 * distinction matters for every panel whose native buffer is portrait — the two bare
 * 2.13" entries and the MagTag — because an EPD driver is constructed from exactly
 * that native pair: (122, 250), (128, 296), (400, 300), (800, 480). Storing the
 * rotated geometry at rotation 0 instead would build a driver with its width and
 * height transposed, so `preset` here is always the datasheet scan order and
 * `rotation` is the step written into cfg-marquee.json on top of it.
 */

export const DISPLAY_PRESETS = {
  // Adafruit MagTag: 2.9" e-ink, SSD1680. The panel scans portrait —
  // Adafruit_SSD1680(128, 296) — and the config ships rotation 0: the firmware's
  // magtag panel entry already presents that buffer as the 296×128 landscape
  // the product is used in, so the file states the native buffer and no step on
  // top of it. palette.js lists the panel in LANDSCAPE_AT_ZERO_PANELS so the
  // editor's canvas is landscape at 0 too.
  //
  // The EPD is soldered to the board (EPD_CS=8, EPD_DC=7, EPD_RESET=6, EPD_BUSY=5),
  // spelled here as D<n> because that is the only form parsePin() accepts. There is
  // no external SRAM, and MOSI/SCK are -1: the panel is on the board's own SPI bus,
  // which the firmware already knows, so nothing is stated for them.
  //
  // Four greys by default. The MagTag's panel is a grayscale4 part (the firmware's older
  // MagTag entry already runs it in grayscale4 even when asked for mono), and the greys
  // are what let a chart's grid and a gauge's track read as grey rather than as a
  // stipple, and anti-aliased lines land on a real shade. The cost is a 4-bit BMP (about
  // 25 KB as base64, well inside the firmware's 80 KB) and a slower refresh.
  magtag: {
    label: 'MagTag 2.9"',
    spec: '296×128 · 4 greys · SSD1680',
    cardLabel: 'MagTag 2.9"',
    cardMeta: '296×128 · 4 greys · SSD1680',
    terms: 'magtag 2.9 esp32-s2 mono gray grey grayscale ssd1680',
    photo: 'img/panels/magtag.jpg',   // adafruit.com product 4800
    preset: '128x296', rotation: '0', mode: 'gray4',
    name: 'epd0', driver: 'SSD1680', panel: 'magtag',
    pins: { busy: 'D5', dc: 'D7', rst: 'D6', cs: 'D8', sramCs: '-1', mosi: '-1', sck: '-1', bus: 0 },
  },

  // Adafruit 2.13" HD Tri-Color eInk / ePaper FeatherWing: RW, SSD1683. Unlike the
  // portrait-native entries below, this one states the 250×122 LANDSCAPE geometry the
  // FeatherWing is used in, at rotation 0 and with no column offset: the firmware's
  // 213-tricolor-MFGNR panel entry owns the scan order and the glass offset, so the
  // config states the geometry the artwork is drawn at and asks for no step on top.
  // Because those are the same numbers, the panel is NOT in
  // palette.js's LANDSCAPE_AT_ZERO_PANELS — the editor's canvas is already 250×122
  // at rotation 0 without a swap.
  // EPD pins per the FeatherWing #defines (EPD_CS=9, EPD_DC=10, SRAM_CS=6,
  // RESET/BUSY shared → -1). MOSI/SCK are -1 as well, like the MagTag: the wing sits
  // on the Feather's own hardware SPI bus, which the firmware already knows, so the
  // file states nothing for them rather than naming the host's pins (35/36).
  // Pins are D-prefixed because the device's parsePin() only accepts "D<n>";
  // "-1" is left bare so parsePin() resolves it to -1 ("pin not used").
  tricolorFW: {
    label: '2.13" Tri-Color FeatherWing',
    spec: '250×122 · black/white/red · SSD1683',
    cardLabel: '2.13" Tri-Color FeatherWing + ESP32-S3',
    // The FeatherWing is a panel, not a board, so this line names the pairing it is
    // offered as — which is why it ends in a host-board fact (PSRAM) rather than the
    // driver chip `spec` gives.
    cardMeta: '250×122 · black/white/red · 2MB PSRAM',
    terms: '2.13 tricolor tri-color featherwing red ssd1683 4814',
    photo: 'img/panels/tricolor-featherwing.jpg',   // adafruit.com product 4814
    preset: '250x122', rotation: '0', mode: 'tricolor',
    name: 'epd0', driver: 'SSD1683', panel: '213-tricolor-MFGNR',
    pins: { busy: '-1', dc: 'D10', rst: '-1', cs: 'D9', sramCs: 'D6', mosi: '-1', sck: '-1', bus: 0 },
  },

  // Adafruit 2.13" 250x122 Tri-Color eInk / ePaper Display with SRAM (#4947) — the
  // bare breakout of the same RW glass as the FeatherWing above, but described very
  // differently, because there is no firmware panel entry standing in front of it:
  //   · geometry is the native 122×250 portrait buffer with rotation 270 on top,
  //     the datasheet-scan-order form the rest of this catalog uses, rather than the
  //     landscape-at-0 shorthand the FeatherWing's panel entry allows;
  //   · the wiring is the standard Adafruit_EPD breakout pinout (DC=10, CS=9,
  //     BUSY=7, SRAM_CS=6, RESET=8) rather than the FeatherWing's shared RESET/BUSY —
  //     the breakout brings both out, so neither is -1 — and the SPI bus is stated
  //     (35/36) rather than left to the firmware, since nothing here is soldered down;
  //   · colstart is stated here, -8, because this descriptor has to carry the glass
  //     offset itself. Adafruit's product page calls it out directly: as of
  //     2025-08-14 the breakout ships the SSD1680Z and "has a different 'offset'
  //     than previous panels".
  // `driver` is SSD1680 because the Z is the same controller programming model —
  // there is no separate SSD1680Z driver — and the offset is exactly what colstart
  // carries instead. The panel id uses the adafruit-{product} form so the two 2.13"
  // tri-colors are never confused for one another.
  tricolorBO: {
    label: '2.13" Tri-color Breakout',
    spec: '250×122 · black/white/red · SSD1680Z',
    terms: '2.13 tricolor tri-color breakout bare red sram ssd1680 ssd1680z 4947',
    preset: '122x250', rotation: '270', mode: 'tricolor',
    name: 'epd0', driver: 'SSD1680', panel: 'adafruit-4947',
    colstart: -8,
    pins: { busy: 'D7', dc: 'D10', rst: 'D8', cs: 'D9', sramCs: 'D6', mosi: 'D35', sck: 'D36', bus: 0 },
  },

  // Adafruit 2.13" Quad-Color eInk / ePaper bare display: 250×122 BWRY, JD79661
  // (ThinkInk_213_Quadcolor_AJHE5 — Adafruit_JD79661(122, 250, ...)). The panel
  // size here is the UNROTATED framebuffer (122×250 portrait), because that's
  // what ships as DisplayProperties.width/height and what the device's
  // setRotation() is applied on top of. Rotation 270° (index 3) therefore lands
  // on a 250×122 landscape canvas — the same shape as the library's own begin()
  // default of setRotation(1), just flipped 180°.
  // EPD pins per the board's #defines (EPD_DC=6, EPD_CS=5, EPD_BUSY=12,
  // EPD_RESET=11); no SRAM chip, so SRAM_CS is -1.
  quad213: {
    label: '2.13" Quad-Color',
    spec: '250×122 · black/white/red/yellow · JD79661',
    terms: '2.13 quad quadcolor bwry yellow jd79661 6373',
    preset: '122x250', rotation: '270', mode: 'quadcolor',
    name: 'epd0', driver: 'JD79661', panel: '213-quad-AJHE5',
    pins: { busy: 'D12', dc: 'D6', rst: 'D11', cs: 'D5', sramCs: '-1', mosi: 'D35', sck: 'D36', bus: 0 },
  },

  // Adafruit 4.2" Tri-Color eInk / ePaper bare display: 400×300 RW, SSD1683
  // (ThinkInk_420_Tricolor_MFGNR). EPD pins per the board's #defines
  // (EPD_DC=10, EPD_CS=9, EPD_BUSY=7, SRAM_CS=6, EPD_RESET=8) — unlike the 2.13"
  // FeatherWing this panel breaks out real BUSY and RESET pins, so neither is -1.
  tricolor42: {
    label: '4.2" Tri-Color',
    spec: '400×300 · black/white/red · SSD1683',
    terms: '4.2 420 tricolor tri-color red ssd1683',
    preset: '400x300', rotation: '0', mode: 'tricolor',
    name: 'epd0', driver: 'SSD1683', panel: '420-tricolor-MFGNR',
    pins: { busy: 'D7', dc: 'D10', rst: 'D8', cs: 'D9', sramCs: 'D6', mosi: 'D35', sck: 'D36', bus: 0 },
  },

  // 4.2" Tri-Color eInk paired with a Feather ESP32-S3. Reuses the FeatherWing's
  // firmware and hardware SPI bus, with RESET/BUSY unused. This configuration
  // names the ThinkInk panel in both driver and panel; keep the bare-panel wiring
  // above available separately for existing devices.
  tricolor42S3: {
    label: '4.2" Tri-Color eInk + ESP32-S3',
    spec: '400×300 · black/white/red · 420-tricolor-MFGNR',
    cardMeta: '4.2" 300x400 Tri-Color eInk',
    terms: '4.2 420 tricolor tri-color eink epaper red ssd1683 feather esp32-s3',
    photo: 'img/panels/420-tricolor.jpg',
    preset: '400x300', rotation: '90', mode: 'tricolor',
    name: 'epd0', driver: '420-tricolor-MFGNR', panel: '420-tricolor-MFGNR',
    pins: { busy: '-1', dc: 'D10', rst: '-1', cs: 'D9', sramCs: 'D6', mosi: '-1', sck: '-1', bus: 0 },
  },

  // Adafruit 4.2" Grayscale eInk / ePaper bare display: 400×300 4-level gray,
  // SSD1683 (ThinkInk_420_Grayscale4_MFGN). BUSY and RESET aren't wired here, so
  // both are -1 ("pin not used") like the 2.13" FeatherWing.
  gray42: {
    label: '4.2" Grayscale',
    spec: '400×300 · 4 grays · SSD1683',
    terms: '4.2 420 grayscale gray 4-level ssd1683',
    preset: '400x300', rotation: '0', mode: 'gray4',
    name: 'epd0', driver: 'SSD1683', panel: '420-gray-MFGN',
    pins: { busy: '-1', dc: 'D10', rst: '-1', cs: 'D9', sramCs: 'D6', mosi: 'D35', sck: 'D36', bus: 0 },
  },

  // Adafruit 7.5" Mono eInk / ePaper bare display: 800×480 mono, UC8179
  // (ThinkInk_750_Mono_AAAMFGN). Same SPI EPD wiring as the 4.2" grayscale above,
  // BUSY and RESET included (-1, i.e. not wired). No SRAM chip either.
  mono75: {
    label: '7.5" Mono',
    spec: '800×480 · mono · UC8179',
    terms: '7.5 750 mono uc8179 large',
    preset: '800x480', rotation: '0', mode: 'mono',
    name: 'epd0', driver: 'UC8179', panel: '750-mono-AAAMFGN',
    pins: { busy: '-1', dc: 'D10', rst: '-1', cs: 'D9', sramCs: '-1', mosi: 'D35', sck: 'D36', bus: 0 },
  },

  // Adafruit 7.5" Tri-Color eInk / ePaper bare display: 800×480 RW, UC8179.
  // Same panel family and SPI EPD wiring as the 7.5" mono above — only the color
  // mode differs.
  tri75: {
    label: '7.5" Tri-Color',
    spec: '800×480 · black/white/red · UC8179',
    terms: '7.5 750 tricolor tri-color red uc8179 large',
    preset: '800x480', rotation: '0', mode: 'tricolor',
    name: 'epd0', driver: 'UC8179', panel: '750-tricolor-AABMFGNR',
    pins: { busy: '-1', dc: 'D10', rst: '-1', cs: 'D9', sramCs: '-1', mosi: 'D35', sck: 'D36', bus: 0 },
  },

  // Xteink X4 Pro Pocket eReader: 800x480 mono, UC8279. The first entry in this
  // catalog that is a whole product rather than a panel wired to a Feather, which
  // shows up in three places:
  //
  //   * the pinout is the device's own ESP32-S3 GPIOs, not the Feather bus every
  //     other entry shares. D<n> here is GPIO n — the only spelling parsePin()
  //     accepts — so EPD_SCLK=12 becomes 'D12' and so on. The panel is write-only
  //     (EPD_MISO = -1) and there is no external SRAM chip (EPD_SRCS = -1); MISO
  //     has no field in either serialiser, so only sramCs is stated as '-1'. Keep it
  //     that way: any miso value in the file gets claimed as an input.
  //   * the panel id is 'xteink-x4-pro' — the {vendor}-{product} form the
  //     'adafruit-{product_id}' entries use, because like them this names a
  //     product, and unlike the ThinkInk entries there is no part suffix to name.
  //   * the panel is soldered down, but unlike the MagTag there is no firmware
  //     panel entry that owns the bus, so MOSI/SCK are stated explicitly.
  //
  // 800x480 is already the landscape orientation the device is read in, so
  // rotation is 0 and the framebuffer is the datasheet scan order unchanged. The
  // height is 480, not 400: the controller scans 600 gates and shows a 480-gate
  // window from gate 120 (marquee-x4pro EPD_HEIGHT). A shorter canvas leaves a
  // blank band along the bottom of the panel.
  //
  // BUSY is active-HIGH on this panel, which EPD drivers assume anyway — but the
  // descriptor has no field for it either way, so it is recorded here.
  x4pro: {
    label: 'Xteink X4 Pro',
    spec: '800×480 · mono · UC8279',
    cardLabel: 'XTeink X4 Pro Pocket eReader',
    // TO CONFIRM: the design calls this grayscale, and `mode` below says mono. 4.3"
    // and 800×480 are consistent (that is roughly a 4.3" diagonal), but grayscale and
    // mono are not the same panel. The card says what the design says; `mode` and
    // `spec` say what this descriptor actually drives. One of the two is wrong.
    cardMeta: '4.3" · grayscale',
    terms: 'xteink x4 pro pocket ereader 800x480 mono uc8279 esp32-s3',
    photo: 'img/panels/xteink-x4-pro.jpg',   // xteink.com product shot
    preset: '800x480', rotation: '0', mode: 'mono',
    name: 'epd0', driver: 'UC8279', panel: 'xteink-x4-pro',
    pins: { busy: 'D6', dc: 'D18', rst: 'D14', cs: 'D13', sramCs: '-1', mosi: 'D11', sck: 'D12', bus: 0 },
  },
};

export const PRESET_KEYS = Object.keys(DISPLAY_PRESETS);

/**
 * The panels A4 offers, in the order it offers them.
 *
 * A subset, deliberately: the catalog above is every panel this app can DRIVE, and
 * this is the shortlist it can talk a first-time user through end to end. The rest stay
 * defined and reachable by preset key — a migrated device pointed at a 7.5" tri-color
 * keeps working — they are just not on the menu.
 */
export const FEATURED_KEYS = ['magtag', 'tricolorFW', 'tricolor42S3', 'x4pro'];

/** The name A4 puts on a card, falling back to the catalog label. */
export function presetCardLabel(key) {
  const p = DISPLAY_PRESETS[key];
  return p?.cardLabel || p?.label || key;
}

/** The line under it. `spec` describes the panel this descriptor drives; `cardMeta`
 *  describes the product a buyer recognises, and the two are allowed to differ. */
export function presetCardMeta(key) {
  const p = DISPLAY_PRESETS[key];
  return p?.cardMeta || p?.spec || '';
}

/** The product shot on the A4 card, relative to public/. Empty when a preset has none:
 *  the card then shows its grey placeholder. */
export function presetCardPhoto(key) {
  return DISPLAY_PRESETS[key]?.photo || '';
}

/** Free-text match over the label, spec and the extra search terms. */
export function searchPresets(query, keys = PRESET_KEYS) {
  const q = query.trim().toLowerCase();
  if (!q) return keys;
  return keys.filter((k) => {
    const p = DISPLAY_PRESETS[k];
    return `${p.label} ${p.cardLabel || ''} ${p.spec} ${p.cardMeta || ''} ${p.terms}`
      .toLowerCase().includes(q);
  });
}

/**
 * True when some catalogued panel with this firmware id ships in four greys, i.e. the
 * glass can show them even if this display was set up in mono.
 */
export function panelShowsGreys(panel) {
  return Object.values(DISPLAY_PRESETS).some((p) => p.panel === panel && p.mode === 'gray4');
}
