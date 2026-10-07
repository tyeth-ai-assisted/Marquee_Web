/**
 * Selection and the inspector.
 *
 * refreshProps() re-renders the whole inspector body from the selected node on
 * every change. That is deliberate — element state lives on the Konva node, not
 * in a parallel view model, so there is exactly one source of truth. The cost is
 * that any handler which fires per-keystroke must NOT call refreshProps(), or it
 * would blow away focus mid-typing; the battery condition rows below are the
 * place that matters and they say so.
 */

import { display, PALETTES, neutralShades } from './palette.js';
import { stage, layer, tr, snap, editorOpts, suspendDitherPreview, scheduleDitherRefresh } from './stage.js';
import {
  isWidget, rebuildWidget, elementColor, setElementColor, wireNode, nextId,
  INDICATOR_OPS, MIN_WIDGET_W, indicatorValueKnown, batteryFraction,
  isFeedLinked, linkedLabelText, feedValueAttr, CHART_RANGES, CHART_RAW_MAX,
  CHART_FONT_MIN, CHART_FONT_MAX, gaugeValue, applyTimeValue, TEXT_PAD_MAX,
} from './elements.js';
import { feedImageToImage, bindFeedImage, MIN_WIDGET_H } from './elements.js';
import { FEED_IMAGE_FITS, FEED_IMAGE_TYPES, sniffImageType } from '../core/feedimage.js';
import { openFeedPicker, refreshFeedElements, refreshChart } from '../device/feeds.js';
import { listTimezones } from '../device/iotime.js';
import { TIME_PRESETS, presetForFmt } from '../core/timefmt.js';
import { GAUGE_ICONS, FA_LINK } from './icons.js';
import { Z_OPS, restack, canRestack, stackPosition } from './zorder.js';
import { $, escapeHtml, escapeAttr, toast, clamp } from '../core/util.js';

export let selected = null;

export function select(node) {
  selected = node;
  if (node) {
    const etype = node.getAttr('etype');
    if (etype === 'divider')
      tr.enabledAnchors(['middle-left', 'middle-right', 'top-center', 'bottom-center']);
    else if (etype === 'gauge' || etype === 'indicator' || etype === 'battery')
      tr.enabledAnchors(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
    else if (etype === 'image' || etype === 'feedimage')
      tr.enabledAnchors(['top-left', 'top-right', 'bottom-left', 'bottom-right',
                         'middle-left', 'middle-right', 'top-center', 'bottom-center']);
    else
      tr.enabledAnchors(['top-left', 'top-right', 'bottom-left', 'bottom-right', 'middle-left', 'middle-right']);
    // An explicit allow-list: an etype omitted here silently gets keepRatio(false),
    // which would let the indicator lamp be dragged into an ellipse. A feed image is
    // deliberately NOT here: its box is a frame the picture is fitted into, so any shape
    // is a legitimate shape for it.
    tr.keepRatio(etype === 'image' || etype === 'label' || etype === 'datetime' || etype === 'gauge'
      || etype === 'linechart' || etype === 'indicator' || etype === 'battery');
    tr.nodes([node]);
  } else {
    tr.nodes([]);
  }
  refreshProps();
}

/**
 * `target` names the node attribute a row writes to (e.g. 'onColor'), for
 * elements that carry more than one color. Omitted = the plain single-ink row,
 * which routes through setElementColor. `colors` narrows the offered set — the
 * battery passes neutralShades() so a grey ramp never offers red or yellow.
 * `none` leads the row with a "no colour" swatch, which writes '' — for a
 * colour that is optional, like a text box's background.
 */
function swatchHTML(current, target, colors = PALETTES[display.type], { none = false } = {}) {
  return `<div class="swatches"${target ? ` data-target="${target}"` : ''}>`
    + (none ? `<button type="button" class="swatch swatch-none" data-active="${!current}" data-color="" aria-label="No color"></button>` : '')
    + colors.map((c) =>
      `<button type="button" class="swatch" data-active="${c === current}" data-color="${c}" style="background:${c}" aria-label="Set color ${c}"></button>`
    ).join('') + '</div>';
}

/** The chainlink that marks every bind control, so one glyph decision lives here. */
const linkGlyph = '<span class="fa-icon" aria-hidden="true">' + FA_LINK + '</span>';

/**
 * The feed binding rows — "which feed" and "what does it read right now".
 *
 * Hoisted because the indicator and the battery each had their own near-identical
 * copy, and the label and the gauge would have made four. `prefix` namespaces the
 * element ids (`pIndFeed`, `pGaugeFeed`, …) so bindFeedRow can wire them without
 * knowing which etype it is looking at. `valueText` is passed in because "what
 * counts as a readable value" is per-element: the battery calls a non-numeric read
 * out as such, the indicator happily compares strings.
 */
function feedRowHTML(n, prefix, valueText) {
  const bound = isFeedLinked(n);
  return `
    <span class="label">Feed</span>
    <div class="prop-row">
      <span class="mono" style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; font-size:12px; ${bound ? '' : 'opacity:.6;'}">${
        bound ? escapeHtml(n.getAttr('feedName') || n.getAttr('feedKey')) : '(not connected)'}</span>
      <button type="button" class="btn btn-sm" id="p${prefix}Feed">${
        linkGlyph} ${bound ? 'Change' : 'Connect'}</button>
    </div>
    <div class="prop-row">
      <span class="label">Value</span>
      <span class="mono" style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; font-size:12px; ${
        valueText.known ? '' : 'opacity:.6;'}">${escapeHtml(valueText.text)}</span>
      <button type="button" class="btn btn-sm" id="p${prefix}Refresh"${bound ? '' : ' disabled'} title="Re-read the feed">↻</button>
    </div>`;
}

// What the Value row says, per element. Each returns { text, known } — `known`
// only dims the row, so a value that IS present but unusable still shows, along
// with why. Silence there is the failure mode worth avoiding: "(unknown)" on a
// feed that is actually returning "ON" to a numeric widget explains nothing.

const rawText = (n) => String(n.getAttr(feedValueAttr(n)) ?? '');

function labelValueText(n) {
  const raw = n.getAttr('feedValue');
  const known = raw !== null && raw !== undefined && String(raw) !== '';
  return { text: known ? String(raw) : '(unknown)', known };
}

function indicatorValueText(n) {
  const known = indicatorValueKnown(n);
  return { text: known ? String(n.getAttr('value')) : '(unknown)', known };
}

function batteryValueText(n) {
  if (batteryFraction(n) !== null) return { text: rawText(n), known: true };
  const raw = n.getAttr('feedValue');
  return raw ? { text: `${raw} (not a number)`, known: false } : { text: '(unknown)', known: false };
}

function gaugeValueText(n) {
  if (gaugeValue(n) !== null) return { text: rawText(n), known: true };
  const raw = n.getAttr('gaugeValue');
  return raw ? { text: `${raw} (not a number)`, known: false } : { text: '(unknown)', known: false };
}

/**
 * A feed image's reading, described rather than shown: the Value row would otherwise
 * hold eighty thousand characters of base64. Size and format are what a user checking
 * "did the new frame arrive" actually wants to see.
 */
function feedImageValueText(n) {
  const src = n.getAttr('src');
  if (!src || !n.getAttr('natW')) return { text: n.getAttr('feedKey') ? '(no image yet)' : '(no picture)', known: false };
  const b64 = src.slice(src.indexOf(',') + 1);
  const mime = sniffImageType(b64);
  const kb = Math.round((b64.length * 3) / 4 / 1024);
  return { text: `${n.getAttr('natW')}×${n.getAttr('natH')} ${FEED_IMAGE_TYPES[mime] || 'image'}, ${kb} KB`, known: true };
}

/** What the refresh toast says a reading was — the Value row's text, per element. */
function readingSummary(n) {
  return n.getAttr('etype') === 'feedimage' ? feedImageValueText(n).text : n.getAttr(feedValueAttr(n));
}

/** Wire what feedRowHTML rendered. */
function bindFeedRow(bind, n, prefix) {
  // The picker checks a feed image's value IS a picture before binding it; the other
  // bindings take any value.
  const mode = n.getAttr('etype') === 'feedimage' ? 'image' : 'bind';
  bind(`p${prefix}Feed`, () => openFeedPicker(n, { mode }));
  bind(`p${prefix}Refresh`, async () => {
    const ok = await refreshFeedElements([n]);
    refreshProps();
    const name = n.getAttr('feedName') || 'Feed';
    toast(ok ? `${name} = ${readingSummary(n)}` : 'Could not read the feed');
  });
}

/**
 * Size, font, box width and alignment — the type rows every Konva.Text element shares.
 * The ids are bound once below (pSize, pFont, pBoxW, pAlign), so the label and the
 * datetime get the same behaviour from the same handlers.
 */
function textStyleRowsHTML(n) {
  return `
    <div class="prop-row">
      <span class="label">Size</span><input type="number" id="pSize" value="${n.fontSize()}" min="4" max="512">
      <select id="pFont" style="flex:1">
        <option value="monospace" ${n.fontFamily() === 'monospace' ? 'selected' : ''}>Mono</option>
        <option value="sans-serif" ${n.fontFamily() === 'sans-serif' ? 'selected' : ''}>Sans</option>
        <option value="serif" ${n.fontFamily() === 'serif' ? 'selected' : ''}>Serif</option>
      </select>
    </div>
    <div class="prop-row">
      <span class="label">Box</span><input type="number" id="pBoxW" min="8"
        value="${n.attrs.width !== undefined ? Math.round(n.width()) : ''}" placeholder="auto">
      <select id="pAlign" style="flex:1">
        <option value="left" ${n.align() === 'left' ? 'selected' : ''}>Left</option>
        <option value="center" ${n.align() === 'center' ? 'selected' : ''}>Center</option>
        <option value="right" ${n.align() === 'right' ? 'selected' : ''}>Right</option>
      </select>
    </div>
    <span class="label">Background</span>${swatchHTML(n.getAttr('background') || '', 'background', undefined, { none: true })}
    <div class="prop-row">
      <span class="label">Padding</span><input type="number" id="pPad" value="${n.padding()}" min="0" max="${TEXT_PAD_MAX}">
    </div>`;
}

/**
 * The timezone <select>'s options. "Auto" is labelled with the zone it actually
 * resolves to, because a bare "Auto" leaves the user to find out what time the panel
 * shows by pushing it. A saved zone missing from the list (a doc from a browser with a
 * newer tz table) is still offered, so the select never silently shows a different
 * value than the element carries.
 */
function tzOptionsHTML(current) {
  const tz = listTimezones();
  const auto = `Auto - ${tz.timezone}`;
  const zones = [...tz.zones];
  if (current && !zones.includes(current)) zones.unshift(current);
  return `<option value=""${current ? '' : ' selected'}>${escapeHtml(auto)}</option>`
    + zones.map((z) => `<option value="${escapeAttr(z)}"${z === current ? ' selected' : ''}>${escapeHtml(z)}</option>`).join('');
}

/**
 * The Layer row: where the element sits in the stack, and the four ways to move it.
 * Bottom-to-top left-to-right, so the buttons read in the direction they push. A
 * control that would do nothing (forward on the topmost) is disabled rather than
 * hidden, so the row never changes shape under the pointer.
 */
function layerRowHTML(n) {
  const { index, count } = stackPosition(n);
  return `
    <div class="prop-row">
      <span class="label">Layer</span>
      <span class="mono" style="flex:1; font-size:12px; opacity:.6;" title="1 is the bottom">${index + 1} of ${count}</span>
      ${[...Z_OPS].reverse().map(({ op, label, glyph, keys }) =>
        `<button type="button" class="btn btn-sm" id="pZ-${op}" title="${label} (${keys})"
          aria-label="${label}"${canRestack(n, op) ? '' : ' disabled'}>${glyph}</button>`).join('')}
    </div>`;
}

/** Re-read one datetime and report a failure — the inspector's half of the refresh. */
async function rereadDatetime(n) {
  const ok = await refreshFeedElements([n]);
  if (selected === n) refreshProps();
  if (!ok) toast('Could not read the time from Adafruit IO');
  return ok;
}

export function refreshProps() {
  const body = $('propBody');
  if (!body) return;

  if (!selected) {
    body.innerHTML = `<span class="label">Nothing selected</span>
      <p class="hint">Drag to move. Double-click a label to rename it. Corner handles scale
      type, side handles resize the text box. Arrow keys nudge, <span class="mono">⌫</span> deletes,
      <span class="mono">⌘D</span> duplicates, <span class="mono">⌘]</span> / <span class="mono">⌘[</span>
      bring forward and send backward (add <span class="mono">⇧</span> for front and back).
      Right-click an element for the same.</p>`;
    return;
  }

  const n = selected;
  const etype = n.getAttr('etype');
  let html = `<span class="label">Selected · ${etype}</span>
    <div class="prop-row">
      <span class="label">X</span><input type="number" id="pX" value="${Math.round(n.x())}">
      <span class="label">Y</span><input type="number" id="pY" value="${Math.round(n.y())}">
    </div>`;

  if (etype === 'label') {
    const linked = isFeedLinked(n);
    html += `
    <span class="label">Text</span>
    <textarea id="pText"${linked ? ' readonly style="opacity:.6; cursor:not-allowed"' : ''}>${escapeHtml(n.text())}</textarea>`
      + (linked
        // Read-only rather than hidden: the composed string is the useful thing to
        // see, and hiding it would leave no way to check what the panel will show.
        ? `<p class="hint">Text comes from <b>${escapeHtml(n.getAttr('feedName') || n.getAttr('feedKey'))}</b>.
           Use the prefix, suffix and decimals to format it, or unlink to type your own.</p>`
           + feedRowHTML(n, 'Lbl', labelValueText(n))
           + `
        <div class="prop-row">
          <span class="label">Before</span>
          <input type="text" id="pLblPrefix" style="flex:1; width:0; min-width:0" value="${escapeAttr(String(n.getAttr('feedPrefix') ?? ''))}" placeholder="e.g. Temp: ">
        </div>
        <div class="prop-row">
          <span class="label">After</span>
          <input type="text" id="pLblSuffix" style="flex:1; width:0; min-width:0" value="${escapeAttr(String(n.getAttr('feedSuffix') ?? ''))}" placeholder="e.g. °F">
        </div>
        <div class="prop-row">
          <span class="label">Decimals</span>
          <input type="number" id="pLblDec" style="flex:1; width:0; min-width:0" min="0" max="10" value="${escapeAttr(String(n.getAttr('feedDecimals') ?? ''))}" placeholder="as sent">
        </div>
        <button type="button" class="btn btn-sm btn-block" id="pLblUnlink">Unlink from feed</button>`
        : `<button type="button" class="btn btn-sm btn-block" id="pLblFeed">${linkGlyph} Connect to IO Feed</button>`)
      + textStyleRowsHTML(n);
  } else if (etype === 'datetime') {
    const preset = presetForFmt(n.getAttr('timeFmt'));
    html += `
    <label class="field"><span class="label">Type</span>
      <select id="pDtFmt">${TIME_PRESETS.map((p) =>
        `<option value="${p.id}"${p.id === preset.id ? ' selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}</select></label>
    <label class="field"><span class="label">Timezone</span>
      <select id="pDtTz">${tzOptionsHTML(n.getAttr('timeTz') || '')}</select></label>`
      + textStyleRowsHTML(n);
  } else if (etype === 'indicator') {
    const bound = isFeedLinked(n);
    html += `
    <div class="prop-row">
      <span class="label">Size</span><input type="number" id="pIndSize" value="${n.getAttr('w')}" min="6" max="512">
    </div>`
      + feedRowHTML(n, 'Ind', indicatorValueText(n))
      + `
    <span class="label">Condition</span>
    <div class="prop-row">
      <select id="pIndOp" style="flex:0 0 64px">${INDICATOR_OPS.map((o) =>
        `<option value="${o.op}"${n.getAttr('op') === o.op ? ' selected' : ''}>${o.label}</option>`).join('')}</select>
      <input type="text" id="pIndCmp" style="flex:1" value="${escapeAttr(String(n.getAttr('cmp') ?? ''))}">
    </div>
    <p class="hint">Lamp is <b>On</b> when the condition holds. Compared as numbers when both
      sides are numeric, otherwise as case-insensitive text.${
      bound ? '' : ' Unbound and unknown values read as <b>Off</b>.'}</p>
    <span class="label">On colour</span>${swatchHTML(n.getAttr('onColor'), 'onColor')}
    <span class="label">Off colour</span>${swatchHTML(n.getAttr('offColor'), 'offColor')}`;
  } else if (etype === 'battery') {
    const shades = neutralShades();
    const conds = n.getAttr('conds') || [];
    html += `
    <div class="prop-row">
      <span class="label">Size</span><input type="number" id="pBatSize" value="${n.getAttr('w')}" min="${MIN_WIDGET_W.battery}" max="512">
    </div>`
      + feedRowHTML(n, 'Bat', batteryValueText(n))
      + `
    <label class="check-row"><input type="checkbox" id="pBatPct"${
      n.getAttr('showPct') ? ' checked' : ''}> Show percentage</label>
    <div class="prop-row" style="margin-top:4px">
      <span class="label" style="flex:1">Conditions</span>
      <button type="button" class="btn btn-sm" id="pBatCondAdd">+ Add</button>
    </div>`
      + (conds.length ? conds.map((c, i) => `
    <div class="prop-row">
      <select id="pBatCondOp${i}" style="flex:0 0 64px">${INDICATOR_OPS.map((o) =>
        `<option value="${o.op}"${c.op === o.op ? ' selected' : ''}>${o.label}</option>`).join('')}</select>
      <input type="text" id="pBatCondCmp${i}" style="flex:1; width:0; min-width:0" value="${escapeAttr(String(c.cmp ?? ''))}">
      <button type="button" class="btn btn-sm btn-danger" id="pBatCondDel${i}" title="Remove condition">×</button>
    </div>
    ${swatchHTML(c.color, 'cond:' + i, shades)}`).join('')
        : '<p class="hint">No conditions — the bar always uses the default shade.</p>')
      + `
    <span class="label">Default (no match)</span>${swatchHTML(n.getAttr('defaultShade'), 'defaultShade', shades)}
    <p class="hint">The value fills the bar as a percentage (0–100). Conditions are checked top to
      bottom and the <b>first</b> one that holds picks the fill shade. A value that isn't a number
      draws an <b>empty</b> bar but can still match a condition.</p>`;
  } else if (etype === 'gauge') {
    html += `
    <div class="prop-grid">
      <label class="field"><span class="label">Size</span>
        <input type="number" id="pW" value="${n.getAttr('w')}" min="40"></label>
      <label class="field"><span class="label">Gauge width</span>
        <input type="number" id="pGaRing" value="${n.getAttr('ringWidth')}" min="1" max="256"></label>
    </div>
    <label class="field"><span class="label">Block title</span>
      <input type="text" id="pTitle" value="${escapeAttr(String(n.getAttr('title') || ''))}" placeholder="optional"></label>`
      + feedRowHTML(n, 'Ga', gaugeValueText(n))
      + `
    <div class="prop-grid">
      <label class="field"><span class="label">Min</span>
        <input type="number" id="pGaMin" value="${escapeAttr(String(n.getAttr('min') ?? 0))}"></label>
      <label class="field"><span class="label">Max</span>
        <input type="number" id="pGaMax" value="${escapeAttr(String(n.getAttr('max') ?? 100))}"></label>
    </div>
    <label class="field"><span class="label">Gauge label</span>
      <input type="text" id="pGaLabel" value="${escapeAttr(String(n.getAttr('gaugeLabel') ?? ''))}"></label>
    <div class="prop-grid">
      <label class="field"><span class="label">Low warning</span>
        <input type="number" id="pGaLow" value="${escapeAttr(String(n.getAttr('lowWarn') ?? ''))}" placeholder="none"></label>
      <label class="field"><span class="label">High warning</span>
        <input type="number" id="pGaHigh" value="${escapeAttr(String(n.getAttr('highWarn') ?? ''))}" placeholder="none"></label>
    </div>
    <div class="prop-row">
      <span class="label">Decimals</span>
      <input type="number" id="pGaDec" value="${n.getAttr('decimals') ?? 2}" min="0" max="10">
    </div>
    <label class="check-row"><input type="checkbox" id="pGaShowIcon"${
      n.getAttr('showIcon') ? ' checked' : ''}> Show icon with the value</label>`
      + (n.getAttr('showIcon')
        ? `<select id="pGaIcon">${GAUGE_ICONS.map((i) =>
             `<option value="${i.id}"${n.getAttr('icon') === i.id ? ' selected' : ''}>${escapeHtml(i.label)}</option>`).join('')}</select>`
        : '')
      + `
    <span class="label">Warning colour</span>${swatchHTML(n.getAttr('warnColor'), 'warnColor')}
    <span class="label">Out-of-range colour</span>${swatchHTML(n.getAttr('alarmColor'), 'alarmColor')}
    <p class="hint">Leave a warning value blank to skip it. A reading outside
      <b>min–max</b> uses the out-of-range colour whether or not warnings are set. An
      unreadable value draws an <b>empty</b> ring.</p>`;
  } else if (etype === 'linechart') {
    const feeds = n.getAttr('feeds') || [];
    html += `
    <div class="prop-grid">
      <label class="field"><span class="label">Width</span>
        <input type="number" id="pW" value="${n.getAttr('w')}" min="40"></label>
      <label class="field"><span class="label">Height</span>
        <input type="number" id="pH" value="${n.getAttr('h')}" min="30"></label>
    </div>
    <label class="field"><span class="label">Block title</span>
      <input type="text" id="pTitle" value="${escapeAttr(String(n.getAttr('title') || ''))}" placeholder="optional"></label>
    <div class="prop-row" style="margin-top:4px">
      <span class="label" style="flex:1">Feeds</span>
      <button type="button" class="btn btn-sm" id="pChAdd">${linkGlyph} Add feed</button>
    </div>`
      + (feeds.length ? feeds.map((f, i) => {
        const pts = ((n.getAttr('series') || {})[f.key] || []).length;
        return `
    <div class="prop-row">
      <span class="mono" style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; font-size:12px">${
        escapeHtml(f.name || f.key)}</span>
      <span class="mono" style="flex:none; font-size:11px; opacity:.6">${pts} pt</span>
      <button type="button" class="btn btn-sm btn-danger" id="pChDel${i}" title="Remove this feed">×</button>
    </div>
    ${swatchHTML(f.color, 'feed:' + i)}`;
      }).join('')
        // Named as the fallback it is, not as an error: an unbound chart is a valid
        // thing to place while laying a panel out.
        : '<p class="hint">No feeds connected — showing sample data.</p>')
      + `
    <div class="prop-row">
      <span class="label">History</span>
      <select id="pChHours" style="flex:1">${CHART_RANGES.map((r) =>
        `<option value="${r.hours}"${(n.getAttr('hours') ?? 24) === r.hours ? ' selected' : ''}>${r.label}</option>`).join('')}</select>
      <button type="button" class="btn btn-sm" id="pChRefresh"${feeds.length ? '' : ' disabled'} title="Re-read every feed">↻</button>
    </div>
    <details class="prop-group">
      <summary>Axes &amp; scale</summary>
      <div class="prop-grid">
        <label class="field"><span class="label">X label</span>
          <input type="text" id="pChX" value="${escapeAttr(String(n.getAttr('xLabel') ?? ''))}"></label>
        <label class="field"><span class="label">Y label</span>
          <input type="text" id="pChY" value="${escapeAttr(String(n.getAttr('yLabel') ?? ''))}"></label>
      </div>
      <div class="prop-row">
        <span class="label">Chart text</span>
        <input type="number" id="pChFontSize" aria-label="Chart text size" value="${n.getAttr('axisFontSize') ?? 7}" min="${CHART_FONT_MIN}" max="${CHART_FONT_MAX}">
        <select id="pChFont" aria-label="Chart font family" style="flex:1">${[['monospace', 'Mono'], ['sans-serif', 'Sans'], ['serif', 'Serif']].map(([v, l]) =>
          `<option value="${v}"${(n.getAttr('axisFontFamily') || 'monospace') === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
      </div>
      <p class="hint" id="pChFontFit"></p>
      <div class="prop-grid">
        <label class="field"><span class="label">Y minimum</span>
          <input type="number" id="pChYMin" value="${escapeAttr(String(n.getAttr('yMin') ?? ''))}" placeholder="auto"></label>
        <label class="field"><span class="label">Y maximum</span>
          <input type="number" id="pChYMax" value="${escapeAttr(String(n.getAttr('yMax') ?? ''))}" placeholder="auto"></label>
      </div>
      <div class="prop-row">
        <span class="label">Y scale</span>
        <select id="pChScale" style="flex:1">
          <option value="linear"${n.getAttr('yScale') !== 'log' ? ' selected' : ''}>Linear</option>
          <option value="log"${n.getAttr('yScale') === 'log' ? ' selected' : ''}>Logarithmic</option>
        </select>
      </div>
      <p class="hint">Leave the bounds blank to detect them from the data. The X axis
        shows the times of the history window, with the X label beneath them.</p>
    </details>
    <details class="prop-group">
      <summary>Data &amp; drawing</summary>
      <div class="prop-row">
        <span class="label">Decimals</span>
        <input type="number" id="pChDec" value="${n.getAttr('decimals') ?? 4}" min="0" max="10">
      </div>
      <label class="check-row"><input type="checkbox" id="pChRaw"${
        n.getAttr('rawOnly') ? ' checked' : ''}> Raw data only</label>
      <label class="check-row"><input type="checkbox" id="pChStep"${
        n.getAttr('stepped') ? ' checked' : ''}> Stepped line</label>
      <label class="check-row"><input type="checkbox" id="pChGrid"${
        n.getAttr('gridLines') ? ' checked' : ''}> Draw grid lines</label>
      <label class="check-row"><input type="checkbox" id="pChKey"${
        n.getAttr('keyLegend') ? ' checked' : ''}> Feed key legend</label>
      <p class="hint">Raw data skips IO's aggregates and shows at most the ${CHART_RAW_MAX}
        most recent points. Stepped suits logic levels. Two or more feeds always get a
        legend; the key option labels each line with its feed key (group included)
        instead of its name.</p>
    </details>
    <p class="hint">Lines are told apart by colour <b>and</b> by dash pattern — on a
      mono panel the colours all collapse to ink.</p>`;
  } else if (etype === 'feedimage') {
    // The Feed and Value rows first, as on every bound element; then the frame. No
    // natural-size reset: the picture changes with every reading, so the frame is the
    // only size the user owns.
    const bound = isFeedLinked(n);
    html += feedRowHTML(n, 'Img', feedImageValueText(n)) + `
    <div class="prop-row">
      <span class="label">W</span><input type="number" id="pFiW" value="${n.getAttr('w')}" min="${MIN_WIDGET_H.feedimage}">
      <span class="label">H</span><input type="number" id="pFiH" value="${n.getAttr('h')}" min="${MIN_WIDGET_H.feedimage}">
    </div>
    <label class="field"><span class="label">Picture</span>
      <select id="pFiFit">${FEED_IMAGE_FITS.map((f) =>
        `<option value="${f.id}"${(n.getAttr('fit') || 'contain') === f.id ? ' selected' : ''} title="${escapeAttr(f.hint)}">${escapeHtml(f.label)}</option>`).join('')}
      </select></label>
    <p class="hint">Each new picture on the feed is placed into this frame. Re-read on every
      push and every live take. Dithered to the panel palette on render — no ink swatch.</p>
    ${bound ? '<button type="button" class="btn btn-sm btn-block" id="pFiUnlink">Unlink from feed</button>' : ''}`;
  } else if (isWidget(n)) {
    // Every widget type above has its own branch, so this is unreachable today. It
    // stays as the backstop the comment on WIDGET_TYPES asks for: without it a newly
    // added widget lands in the DIVIDER branch below and the inspector offers it
    // length and thickness controls that write to attrs it doesn't have.
    html += `
    <div class="prop-grid">
      <label class="field"><span class="label">Width</span>
        <input type="number" id="pW" value="${n.getAttr('w')}" min="40"></label>
    </div>
    <label class="field"><span class="label">Title</span>
      <input type="text" id="pTitle" value="${escapeAttr(String(n.getAttr('title') || ''))}"></label>`;
  } else if (etype === 'image') {
    const natW = n.getAttr('natW'), natH = n.getAttr('natH');
    html += `
    <div class="prop-row">
      <span class="label">W</span><input type="number" id="pImgW" value="${Math.round(n.width())}" min="1">
      <span class="label">H</span><input type="number" id="pImgH" value="${Math.round(n.height())}" min="1">
    </div>
    <label class="check-row"><input type="checkbox" id="pLock" checked> Lock aspect ratio</label>
    <button type="button" class="btn btn-sm btn-block" id="pImgReset">Reset to ${natW}×${natH}</button>
    <p class="hint">Dithered to the panel palette on render — no ink swatch.</p>
    <!-- The same binding "Linked image" in the toolbox offers, from a picture already placed:
         the image becomes a frame this size, and the feed's pictures are fitted into it. -->
    <button type="button" class="btn btn-sm btn-block" id="pImgFeed">${linkGlyph} Connect to IO Feed</button>`;
  } else {
    html += `
    <div class="prop-row">
      <span class="label">L</span><input type="number" id="pLen" value="${Math.round(n.width())}" min="1">
      <span class="label">W</span><input type="number" id="pThick" value="${Math.round(n.height())}" min="1">
    </div>
    <button type="button" class="btn btn-sm btn-block" id="pFlip">Rotate 90°</button>`;
  }

  // Images carry their own colors; everything else gets an ink swatch. For an
  // indicator that ink is the lamp's outline (its fill comes from On/Off above);
  // same for a battery, whose fill comes from the conditions.
  html += (etype === 'image' || etype === 'feedimage' ? ''
    : `<span class="label">${etype === 'indicator' || etype === 'battery' ? 'Outline' : 'Ink'}</span>`
      + swatchHTML(elementColor(n), undefined,
          etype === 'battery' ? neutralShades() : PALETTES[display.type]))
    + `<div class="hr"></div>
    ${layerRowHTML(n)}
    <div class="prop-row">
      <button type="button" class="btn btn-sm" id="pDuplicate" style="flex:1">Duplicate</button>
      <button type="button" class="btn btn-sm btn-danger" id="pDelete" style="flex:1">Delete</button>
    </div>`;

  body.innerHTML = html;

  const bind = (id, fn) => {
    const el = $(id);
    if (el) el.addEventListener(el.tagName === 'BUTTON' ? 'click' : 'input', fn);
  };

  bind('pX', (e) => n.x(+e.target.value || 0));
  bind('pY', (e) => n.y(+e.target.value || 0));
  // Guarded rather than merely readonly: `readonly` stops typing, but a paste via
  // the context menu or an autofill would still fire `input` and overwrite text the
  // next feed read is about to replace anyway.
  bind('pText', (e) => { if (!isFeedLinked(n)) n.text(e.target.value); });
  bind('pSize', (e) => n.fontSize(Math.max(4, +e.target.value || 4)));
  bind('pFont', (e) => n.fontFamily(e.target.value));
  bind('pBoxW', (e) => {
    const v = +e.target.value;
    n.setAttr('width', v >= 8 ? Math.round(v) : undefined); // blank = auto-size to text
  });
  bind('pAlign', (e) => n.align(e.target.value));
  bind('pPad', (e) => {
    n.padding(clamp(Math.round(+e.target.value) || 0, 0, TEXT_PAD_MAX));
    tr.forceUpdate();   // padding changes the box, which the transformer is hugging
  });

  // ---- datetime ----
  // Both are selects, so re-rendering the panel after the read cannot take focus from
  // someone typing. The old reading is dropped first: it was rendered in the OLD format
  // or zone, and the example of the new one is a truer placeholder while IO answers.
  const setDatetime = (attr) => (e) => {
    n.setAttr(attr, attr === 'timeFmt'
      ? (TIME_PRESETS.find((p) => p.id === e.target.value) || TIME_PRESETS[0]).fmt
      : e.target.value);
    applyTimeValue(n, null);
    refreshProps();
    rereadDatetime(n);
  };
  bind('pDtFmt', setDatetime('timeFmt'));
  bind('pDtTz', setDatetime('timeTz'));
  bind('pLen', (e) => n.width(Math.max(1, +e.target.value || 1)));
  bind('pThick', (e) => n.height(Math.max(1, +e.target.value || 1)));
  bind('pFlip', () => { const w = n.width(); n.width(n.height()); n.height(w); refreshProps(); });
  bind('pW', (e) => { n.setAttr('w', Math.max(40, Math.round(+e.target.value) || 40)); rebuildWidget(n); });
  bind('pH', (e) => { n.setAttr('h', Math.max(30, Math.round(+e.target.value) || 30)); rebuildWidget(n); });
  bind('pTitle', (e) => { n.setAttr('title', e.target.value); rebuildWidget(n); });

  const ratio = etype === 'image' ? n.getAttr('natW') / n.getAttr('natH') : 1;
  bind('pImgW', (e) => {
    const w = Math.max(1, Math.round(+e.target.value) || 1);
    n.width(w);
    if ($('pLock').checked) {
      n.height(Math.max(1, Math.round(w / ratio)));
      $('pImgH').value = Math.round(n.height());
    }
    tr.forceUpdate();
  });
  bind('pImgH', (e) => {
    const h = Math.max(1, Math.round(+e.target.value) || 1);
    n.height(h);
    if ($('pLock').checked) {
      n.width(Math.max(1, Math.round(h * ratio)));
      $('pImgW').value = Math.round(n.width());
    }
    tr.forceUpdate();
  });
  bind('pImgReset', () => {
    n.width(n.getAttr('natW'));
    n.height(n.getAttr('natH'));
    tr.forceUpdate();
    refreshProps();
  });

  // The Feed + Value rows on every feed-bound element, wired from one place.
  ['Lbl', 'Ind', 'Bat', 'Ga', 'Img'].forEach((prefix) => bindFeedRow(bind, n, prefix));

  // A static image's way in: the picker converts it on a successful pick, so a
  // cancelled picker leaves the image exactly as it was.
  bind('pImgFeed', () => openFeedPicker(n, { mode: 'image' }));

  // The feed image's frame. Width and height are independent on purpose (see select()).
  const fiMin = MIN_WIDGET_H.feedimage;
  bind('pFiW', (e) => { n.setAttr('w', Math.max(fiMin, Math.round(+e.target.value) || fiMin)); rebuildWidget(n); });
  bind('pFiH', (e) => { n.setAttr('h', Math.max(fiMin, Math.round(+e.target.value) || fiMin)); rebuildWidget(n); });
  bind('pFiFit', (e) => { n.setAttr('fit', e.target.value); rebuildWidget(n); });
  bind('pFiUnlink', () => {
    const name = n.getAttr('feedName') || n.getAttr('feedKey');
    // With a picture, it becomes the plain image it looks like; without one there is
    // nothing to keep, so the frame stays and simply stops reading.
    const img = feedImageToImage(n);
    if (img) {
      select(img);
      toast(`Unlinked from ${name} — the picture is now a plain image`);
    } else {
      // Through bindFeedImage so a read still in flight for the old feed is dropped.
      bindFeedImage(n, '', '');
      rebuildWidget(n);
      refreshProps();
      toast(`Unlinked from ${name}`);
    }
  });

  // Prefix and suffix fire per keystroke, so they must not call refreshProps() —
  // it replaces #propBody wholesale and would take focus with it.
  const setAffix = (attr) => (e) => {
    n.setAttr(attr, e.target.value);
    n.text(linkedLabelText(n));
  };
  bind('pLblPrefix', setAffix('feedPrefix'));
  bind('pLblSuffix', setAffix('feedSuffix'));
  // Same per-keystroke rule. Blank means "as sent", so it clears to null, not 0.
  bind('pLblDec', (e) => {
    const v = e.target.value.trim();
    n.setAttr('feedDecimals', v === '' ? null : Math.max(0, Math.min(10, Math.round(+v) || 0)));
    n.text(linkedLabelText(n));
  });
  bind('pLblFeed', () => openFeedPicker(n));
  bind('pLblUnlink', () => {
    const name = n.getAttr('feedName') || n.getAttr('feedKey');
    // The composed text is left exactly as it stands. Reverting to the pre-link
    // string would be worse: the user has been looking at the live text and that is
    // what they expect to start editing from.
    n.setAttr('feedKey', '');
    n.setAttr('feedName', '');
    n.setAttr('feedValue', null);
    refreshProps();
    toast(`Unlinked from ${name} — the text is yours to edit`);
  });

  bind('pIndSize', (e) => { n.setAttr('w', Math.max(6, Math.round(+e.target.value) || 6)); rebuildWidget(n); });
  bind('pIndOp', (e) => { n.setAttr('op', e.target.value); rebuildWidget(n); });
  bind('pIndCmp', (e) => { n.setAttr('cmp', e.target.value); rebuildWidget(n); });

  bind('pBatSize', (e) => {
    const min = MIN_WIDGET_W.battery;
    n.setAttr('w', Math.max(min, Math.round(+e.target.value) || min));
    rebuildWidget(n);
  });
  bind('pBatPct', (e) => { n.setAttr('showPct', e.target.checked); rebuildWidget(n); });

  // ---- gauge ----
  // Bounds and thresholds are stored as the RAW field text, not coerced to numbers:
  // '' has to stay distinguishable from 0 so "no warning value" doesn't silently
  // become "warn at zero". toNum() at draw time is what decides usability.
  const setGauge = (attr, coerce = (v) => v) => (e) => {
    n.setAttr(attr, coerce(e.target.value));
    rebuildWidget(n);
  };
  bind('pGaRing', setGauge('ringWidth', (v) => Math.max(1, Math.round(+v) || 1)));
  bind('pGaMin', setGauge('min'));
  bind('pGaMax', setGauge('max'));
  bind('pGaLabel', setGauge('gaugeLabel'));
  bind('pGaLow', setGauge('lowWarn'));
  bind('pGaHigh', setGauge('highWarn'));
  bind('pGaDec', setGauge('decimals', (v) => Math.max(0, Math.min(10, Math.round(+v) || 0))));
  bind('pGaIcon', setGauge('icon'));
  bind('pGaShowIcon', (e) => {
    n.setAttr('showIcon', e.target.checked);
    rebuildWidget(n);
    refreshProps();     // the icon picker appears and disappears with the checkbox
  });

  // ---- chart ----
  const setChart = (attr, coerce = (v) => v) => (e) => {
    n.setAttr(attr, coerce(e.target.value));
    rebuildWidget(n);
    showFontFit();      // a new caption row can change what size fits
  };
  bind('pChX', setChart('xLabel'));
  bind('pChY', setChart('yLabel'));
  bind('pChYMin', setChart('yMin'));         // raw text: '' means auto-detect
  bind('pChYMax', setChart('yMax'));
  bind('pChScale', setChart('yScale'));
  // The chart may draw its text smaller than asked, to fit its height (see
  // buildLineChart). Say so beside the field, or the size looks ignored.
  const showFontFit = () => {
    const hint = $('pChFontFit');
    if (!hint) return;
    const fit = n.getAttr('axisFontFit'), asked = n.getAttr('axisFontSize');
    hint.textContent = fit < asked
      ? `Drawn at ${fit}px — ${asked}px doesn't fit this chart's height. Make it taller for more.` : '';
    hint.hidden = !(fit < asked);
  };
  if (etype === 'linechart') showFontFit();
  bind('pChFontSize', setChart('axisFontSize', (v) => clamp(Math.round(+v) || 7, CHART_FONT_MIN, CHART_FONT_MAX)));
  bind('pChFont', setChart('axisFontFamily'));
  bind('pChDec', setChart('decimals', (v) => Math.max(0, Math.min(10, Math.round(+v) || 0))));
  bind('pChStep', (e) => { n.setAttr('stepped', e.target.checked); rebuildWidget(n); });
  bind('pChGrid', (e) => { n.setAttr('gridLines', e.target.checked); rebuildWidget(n); });
  bind('pChKey', (e) => { n.setAttr('keyLegend', e.target.checked); rebuildWidget(n); });
  bind('pChAdd', () => openFeedPicker(n, { mode: 'series' }));

  // Both of these change WHAT IO returns, not just how it is drawn, so each is a
  // refetch rather than a rebuild.
  const refetchChart = async (label) => {
    const ok = await refreshChart(n);
    refreshProps();
    if (!ok) toast(`Showing the last good data — ${label} could not be read`);
  };
  bind('pChHours', async (e) => {
    n.setAttr('hours', Math.round(+e.target.value) || 24);
    await refetchChart('the new window');
  });
  bind('pChRaw', async (e) => {
    n.setAttr('rawOnly', e.target.checked);
    await refetchChart('the raw data');
  });
  bind('pChRefresh', async () => {
    const ok = await refreshChart(n);
    refreshProps();
    toast(ok ? 'Chart data refreshed' : 'Some feeds could not be read');
  });
  (etype === 'linechart' ? (n.getAttr('feeds') || []) : []).forEach((f, i) => {
    bind(`pChDel${i}`, () => {
      const feeds = (n.getAttr('feeds') || []).filter((_, j) => j !== i);
      n.setAttr('feeds', feeds);
      // Through refreshChart rather than rebuildWidget: it also drops the removed
      // feed's cached series, which would otherwise sit in canvas.json forever.
      refreshChart(n).then(() => refreshProps());
    });
  });

  // Conditions are a variable-length list, so the rows are bound by index. The
  // op and cmp handlers deliberately DON'T call refreshProps() — it replaces the
  // whole panel via innerHTML, which would blow away focus on every keystroke.
  // Add and remove are buttons, so re-rendering there is safe and necessary.
  const setConds = (fn) => {
    const conds = (n.getAttr('conds') || []).map((c) => ({ ...c }));
    fn(conds);
    n.setAttr('conds', conds);
    rebuildWidget(n);
  };
  (etype === 'battery' ? (n.getAttr('conds') || []) : []).forEach((_, i) => {
    bind(`pBatCondOp${i}`, (e) => setConds((cs) => { cs[i].op = e.target.value; }));
    bind(`pBatCondCmp${i}`, (e) => setConds((cs) => { cs[i].cmp = e.target.value; }));
    bind(`pBatCondDel${i}`, () => { setConds((cs) => { cs.splice(i, 1); }); refreshProps(); });
  });
  bind('pBatCondAdd', () => {
    // Seed from the last row so adding a second threshold is a tweak, not a retype.
    setConds((cs) => {
      const prev = cs[cs.length - 1];
      cs.push({
        op: prev ? prev.op : 'lt',
        cmp: prev ? prev.cmp : '20',
        color: n.getAttr('defaultShade'),
      });
    });
    refreshProps();
  });

  bind('pDelete', () => { n.destroy(); select(null); suspendDitherPreview(); scheduleDitherRefresh(); });
  bind('pDuplicate', () => duplicateSelected());
  Z_OPS.forEach(({ op }) => bind(`pZ-${op}`, () => restackSelected(op)));

  // Scoped per row: a `data-target` row writes that attribute directly (elements
  // with more than one color), a plain row goes through setElementColor.
  body.querySelectorAll('.swatches').forEach((box) => {
    const target = box.dataset.target;
    box.querySelectorAll('.swatch').forEach((s) => s.addEventListener('click', () => {
      // `cond:<i>` and `feed:<i>` address a colour INSIDE an array attr, which the
      // flat setAttr path below can't reach.
      if (target && target.startsWith('cond:')) {
        const i = +target.slice(5);
        setConds((cs) => { if (cs[i]) cs[i].color = s.dataset.color; });
      } else if (target && target.startsWith('feed:')) {
        const i = +target.slice(5);
        const feeds = (n.getAttr('feeds') || []).map((f) => ({ ...f }));
        if (feeds[i]) feeds[i].color = s.dataset.color;
        n.setAttr('feeds', feeds);
        rebuildWidget(n);
      } else if (target === 'background') {
        // A text box, not a widget: the text's own sceneFunc paints it on the next draw.
        n.setAttr('background', s.dataset.color);
      } else if (target) {
        n.setAttr(target, s.dataset.color);
        rebuildWidget(n);
      } else {
        setElementColor(n, s.dataset.color);
      }
      refreshProps();
    }));
  });
}

/**
 * Universal duplicate: copy the selected element (any type), offset it by one
 * grid step, and select the copy. Konva's clone() also copies event listeners,
 * but those close over the ORIGINAL node — so strip them and re-wire fresh
 * handlers bound to the clone.
 */
export function duplicateSelected() {
  if (!selected) { toast('Select an element to duplicate'); return; }
  const off = editorOpts.gridSize || 8;
  const clone = selected.clone({
    id: nextId(),
    x: snap(selected.x() + off),
    y: snap(selected.y() + off),
  });
  // Drop the listeners clone() copied, but only the ones wireNode() adds —
  // leave Konva's internal .konva handlers intact.
  clone.off('dragstart dragmove dragend transformstart transformend click tap dblclick dbltap');
  wireNode(clone);
  layer.add(clone);
  select(clone);
  layer.draw();
  suspendDitherPreview();
  scheduleDitherRefresh();
  toast('Duplicated element');
}

/**
 * A Layer control on the selection. The redraw is what makes it an edit like any
 * other: zIndex() alone doesn't request one, and the layer's 'draw' is what autosave
 * and the canvas-state publish listen for (doc.js). A no-op skips both.
 */
export function restackSelected(op) {
  if (!selected || !restack(selected, op)) return;
  layer.batchDraw();
  refreshProps();
  scheduleDitherRefresh();
}

// ---------- context menu ----------------------------------------------------
//
// Right-click on an element selects it and offers the Layer controls, plus the two
// actions the inspector ends with. Built once and re-filled on each open, so its
// disabled states are always those of the element it was opened on.

let ctxMenu = null;

function closeContextMenu() {
  if (!ctxMenu || ctxMenu.hidden) return;
  ctxMenu.hidden = true;
  ctxMenu.innerHTML = '';
}

function deleteSelected() {
  if (!selected) return;
  selected.destroy();
  select(null);
  suspendDitherPreview();
  scheduleDitherRefresh();
}

function openContextMenu(node, clientX, clientY) {
  if (!ctxMenu) {
    ctxMenu = document.createElement('div');
    ctxMenu.className = 'ctx-menu';
    ctxMenu.setAttribute('role', 'menu');
    ctxMenu.hidden = true;
    document.body.appendChild(ctxMenu);
    // Keys stop here: the document handler below would otherwise take an arrow key
    // meant for the menu as a nudge of the element under it.
    ctxMenu.addEventListener('keydown', (e) => {
      e.stopPropagation();
      const items = [...ctxMenu.querySelectorAll('button:not(:disabled)')];
      const at = items.indexOf(document.activeElement);
      if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeContextMenu(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); items[(at + 1) % items.length]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus(); }
    });
    ctxMenu.addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (!act) return;
      closeContextMenu();
      if (act === 'duplicate') duplicateSelected();
      else if (act === 'delete') deleteSelected();
      else restackSelected(act);
    });
    // Anything else dismisses it — a click elsewhere, a scroll, the window losing focus.
    document.addEventListener('pointerdown', (e) => { if (!ctxMenu.contains(e.target)) closeContextMenu(); }, true);
    window.addEventListener('blur', closeContextMenu);
    window.addEventListener('resize', closeContextMenu);
    document.addEventListener('scroll', closeContextMenu, true);
  }
  const item = (act, label, keys, enabled = true) =>
    `<button type="button" role="menuitem" data-act="${act}"${enabled ? '' : ' disabled'}>`
    + `<span>${label}</span><span class="mono">${keys}</span></button>`;
  ctxMenu.innerHTML = Z_OPS.map(({ op, label, keys }) => item(op, label, keys, canRestack(node, op))).join('')
    + '<div class="hr"></div>'
    + item('duplicate', 'Duplicate', '⌘D')
    + item('delete', 'Delete', '⌫');
  ctxMenu.hidden = false;
  // Kept inside the viewport: a right-click near the bottom or right edge opens it
  // up or left of the pointer instead.
  const { width, height } = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = Math.max(4, Math.min(clientX, window.innerWidth - width - 4)) + 'px';
  ctxMenu.style.top = Math.max(4, Math.min(clientY, window.innerHeight - height - 4)) + 'px';
  ctxMenu.querySelector('button:not(:disabled)')?.focus();
}

/** The element a canvas hit belongs to — a widget is a group, so walk up from the shape. */
function elementOf(target) {
  for (let n = target; n && n !== layer; n = n.getParent()) {
    if (n.hasName && n.hasName('element')) return n;
  }
  return null;
}

export function initContextMenu() {
  stage.on('contextmenu', (e) => {
    const node = elementOf(e.target);
    if (!node) { closeContextMenu(); return; }
    e.evt.preventDefault();
    if (selected !== node) select(node);
    openContextMenu(node, e.evt.clientX, e.evt.clientY);
  });
}

/**
 * Clicking empty space drops the selection. Two places count as empty: the stage
 * itself — the paper layer is not listening, so a miss on every element lands on
 * the stage — and the backdrop around the panel. Only the backdrop proper, not
 * anything inside it: the zoom bar, the dither chip and canvas.json all sit in
 * .canvas-ground, and touching them should not cost you your selection.
 */
export function initDeselect() {
  stage.on('click tap', (e) => { if (e.target === stage && selected) select(null); });
  const ground = document.querySelector('.canvas-ground');
  ground?.addEventListener('click', (e) => {
    if (selected && (e.target === ground || e.target.classList.contains('device-shell'))) select(null);
  });
}

/**
 * Nudge, delete, duplicate and restack. Ignored while a form field has focus, and scoped
 * to the editor — without that, Backspace on the settings screen would silently
 * delete whatever was last selected on a canvas the user cannot even see.
 */
export function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (!document.querySelector('#a7[data-active="true"]')) return;

    // Cmd/Ctrl+D duplicates the selection.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      duplicateSelected();
      return;
    }
    if (!selected) return;

    // Cmd/Ctrl+] and [ step the selection forward and backward; with Shift, all the
    // way to the front or back. Matched on e.code first because Shift turns the key
    // into } and { on a US layout (and something else again on others); e.key covers
    // synthetic events, which often carry no code.
    const code = e.code || { ']': 'BracketRight', '}': 'BracketRight', '[': 'BracketLeft', '{': 'BracketLeft' }[e.key];
    if ((e.metaKey || e.ctrlKey) && (code === 'BracketRight' || code === 'BracketLeft')) {
      e.preventDefault();
      const up = code === 'BracketRight';
      restackSelected(e.shiftKey ? (up ? 'front' : 'back') : (up ? 'forward' : 'backward'));
      return;
    }

    // With snap on, arrows step by one grid cell and Shift gives a fine 1px
    // nudge. With snap off, arrows step 1px and Shift steps 10px.
    const step = editorOpts.snap ? (e.shiftKey ? 1 : editorOpts.gridSize) : (e.shiftKey ? 10 : 1);
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      selected.move({ x: moves[e.key][0], y: moves[e.key][1] });
      selected.position({ x: Math.round(selected.x()), y: Math.round(selected.y()) });
      refreshProps();
      // Uncover the stage so held arrows read as movement, then re-dither once
      // the key-repeat stops (the refresh is debounced).
      suspendDitherPreview();
      scheduleDitherRefresh();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      selected.destroy();
      select(null);
      suspendDitherPreview();
      scheduleDitherRefresh();
    }
  });
}
