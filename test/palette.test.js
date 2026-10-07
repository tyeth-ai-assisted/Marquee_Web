/**
 * The display background — public/js/canvas/palette.js.
 *
 * palette.js imports nothing, so it runs under plain node.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  display, PAPER, PALETTES, nearestColor, isHexColor, paletteBackground,
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

test('nearestColor picks the closest palette entry', () => {
  assert.equal(nearestColor('#000000', PALETTES.mono), '#2F2429');
  assert.equal(nearestColor('#FFFFFF', PALETTES.mono), '#F2F4EF');
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
