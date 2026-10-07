/**
 * The display background — public/js/canvas/palette.js.
 *
 * palette.js imports nothing, so it runs under plain node.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  display, PAPER, LEGACY_PAPER, PALETTES, nearestColor, isHexColor, paletteBackground, migrateLegacyPaper,
} from '../public/js/canvas/palette.js';

test('the display starts on PAPER, and PAPER is in every palette', () => {
  assert.equal(display.background, PAPER);
  for (const [type, pal] of Object.entries(PALETTES)) assert.ok(pal.includes(PAPER), type);
});

test('isHexColor: #RRGGBB only', () => {
  assert.equal(isHexColor('#2F2429'), true);
  assert.equal(isHexColor('#f2f4ef'), true);
  assert.equal(isHexColor('#fff'), false);
  assert.equal(isHexColor('black'), false);
  assert.equal(isHexColor(''), false);
  assert.equal(isHexColor(undefined), false);
});

test('PAPER is pure white, so a photo\'s white and the blank page are the same colour', () => {
  assert.equal(PAPER, '#FFFFFF');
});

test('migrateLegacyPaper swaps the old paper tint for PAPER anywhere in a document', () => {
  const src = 'data:image/png;base64,AAAA';
  const doc = {
    version: 1,
    display: { type: 'mono', background: '#F2F4EF' },
    elements: [
      { etype: 'label', fill: '#f2f4ef', background: '#2F2429', text: '#F2F4EF is a colour' },
      { etype: 'indicator', onColor: '#2F2429', offColor: '#F2F4EF' },
      { etype: 'battery', conds: [{ op: 'lt', cmp: '20', color: '#F2F4EF' }] },
      { etype: 'image', src },
    ],
  };
  const out = migrateLegacyPaper(doc);
  assert.equal(out.display.background, PAPER);
  assert.equal(out.elements[0].fill, PAPER);
  assert.equal(out.elements[0].background, '#2F2429');
  assert.equal(out.elements[0].text, '#F2F4EF is a colour', 'only whole colour values change');
  assert.equal(out.elements[1].offColor, PAPER);
  assert.equal(out.elements[2].conds[0].color, PAPER);
  assert.equal(out.elements[3].src, src);
  assert.equal(doc.display.background, LEGACY_PAPER, 'the input is not modified');
});

test('nearestColor picks the closest palette entry', () => {
  assert.equal(nearestColor('#000000', PALETTES.mono), '#2F2429');
  assert.equal(nearestColor('#FFFFFF', PALETTES.mono), PAPER);
  assert.equal(nearestColor(LEGACY_PAPER, PALETTES.mono), PAPER);
  assert.equal(nearestColor('#FF0000', PALETTES.tricolor), '#D72627');
  assert.equal(nearestColor('#808080', PALETTES.gray4), '#70696B');
});

test('paletteBackground: missing or junk is PAPER, so an older document looks as it did', () => {
  for (const type of Object.keys(PALETTES)) {
    assert.equal(paletteBackground(undefined, type), PAPER);
    assert.equal(paletteBackground(null, type), PAPER);
    assert.equal(paletteBackground('red', type), PAPER);
  }
});

test('paletteBackground: a palette colour is kept, anything else snaps onto the panel', () => {
  assert.equal(paletteBackground('#D72627', 'tricolor'), '#D72627');
  assert.equal(paletteBackground('#2F2429', 'mono'), '#2F2429');
  // A red page on a mono panel has no red to be — it becomes the nearer of ink and paper.
  assert.equal(paletteBackground('#D72627', 'mono'), nearestColor('#D72627', PALETTES.mono));
  // A quadcolor yellow page opened on a tricolor panel lands on its red.
  assert.equal(paletteBackground('#FFFF03', 'tricolor'), '#D72627');
  assert.equal(paletteBackground('#fd2a00', 'quadcolor'), '#FD2A00');
});
