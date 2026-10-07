/**
 * A picture arriving as a feed value — public/js/core/feedimage.js.
 *
 * The sniffing is the part worth pinning: a feed image is bound by looking at its value,
 * and the inspector, the picker and the live take all decide "is this a picture" through
 * parseFeedImage(). Get it wrong one way and a doorbell feed is refused; the other way and
 * a temperature feed is handed to an <img>. feedimage.js imports only api.js's constant,
 * so it runs under plain node.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFeedImage, sniffImageType, base64ByteLength, fitRect, feedImageProblem, FEED_IMAGE_TYPES,
} from '../public/js/core/feedimage.js';
import { IO_MAX_NO_HISTORY } from '../public/js/core/api.js';
import { syntheticBmp } from './helpers/bmp.js';

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

// Real headers, padded out so each clears the length floor. The sniff only reads the
// first eight bytes, so a header plus filler is exactly as good as a whole file here.
const filler = Array(32).fill(0);
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...filler]);
const JPEG = b64([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, ...filler]);
const GIF = b64([...Buffer.from('GIF89a'), ...filler]);
const BMP = b64([...Buffer.from('BM'), 0x3e, 0x00, 0x00, 0x00, ...filler]);

// A complete 1×1 transparent PNG — the smallest honest picture there is.
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('each supported format is recognised by its signature', () => {
  assert.equal(sniffImageType(PNG), 'image/png');
  assert.equal(sniffImageType(JPEG), 'image/jpeg');
  assert.equal(sniffImageType(GIF), 'image/gif');
  assert.equal(sniffImageType(BMP), 'image/bmp');
  assert.equal(sniffImageType(PNG_1x1), 'image/png');
  for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/bmp']) assert.ok(FEED_IMAGE_TYPES[mime]);
});

test('other bytes are not an image, however image-like their container', () => {
  // WebP is a RIFF; SVG is text; a PDF starts with %PDF. None of them is a format the
  // editor accepts, and none must be mistaken for one.
  assert.equal(sniffImageType(b64([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8 '), ...filler])), null);
  assert.equal(sniffImageType(b64(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))), null);
  assert.equal(sniffImageType(b64(Buffer.from('%PDF-1.4 and then a lot of nothing'))), null);
  assert.equal(sniffImageType(''), null);
  assert.equal(sniffImageType('!!!!not base64'), null);
});

test('a raw base64 value — what the camera guides publish — parses to a data URL of its real type', () => {
  const r = parseFeedImage(PNG_1x1);
  assert.equal(r.ok, true);
  assert.equal(r.mime, 'image/png');
  assert.equal(r.dataUrl, `data:image/png;base64,${PNG_1x1}`);
  assert.equal(r.bytes, 70);
  assert.equal(r.bytes, Buffer.from(PNG_1x1, 'base64').length);
});

test('a data URL is accepted, and its declared type is overruled by the bytes', () => {
  const honest = parseFeedImage(`data:image/jpeg;base64,${JPEG}`);
  assert.equal(honest.ok, true);
  assert.equal(honest.mime, 'image/jpeg');
  // PNG bytes labelled as a JPEG: the browser would decode it as a PNG, and so do we.
  const mislabelled = parseFeedImage(`data:image/jpeg;base64,${PNG}`);
  assert.equal(mislabelled.ok, true);
  assert.equal(mislabelled.mime, 'image/png');
  assert.equal(mislabelled.dataUrl, `data:image/png;base64,${PNG}`);
  // A data URL that is not base64 at all.
  assert.deepEqual(parseFeedImage('data:text/plain,hello'), { ok: false, reason: 'not-base64' });
  assert.deepEqual(parseFeedImage('data:image/png;base64'), { ok: false, reason: 'not-base64' });
});

test('wrapped lines, stray whitespace and the URL-safe alphabet all decode', () => {
  const wrapped = PNG_1x1.replace(/(.{20})/g, '$1\n');
  assert.notEqual(wrapped, PNG_1x1);
  assert.equal(parseFeedImage(wrapped).dataUrl, `data:image/png;base64,${PNG_1x1}`);
  assert.equal(parseFeedImage(`  ${PNG_1x1}\r\n`).dataUrl, `data:image/png;base64,${PNG_1x1}`);
  // A PNG header followed by bytes that encode to '+' and '/', so there is something to swap.
  const plusSlash = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xfb, 0xef, 0xbe, 0xff, 0xff, 0xff, ...filler]);
  assert.match(plusSlash, /\+.*\//);
  const urlSafe = plusSlash.replace(/\+/g, '-').replace(/\//g, '_');
  assert.notEqual(urlSafe, plusSlash);
  assert.equal(parseFeedImage(urlSafe).dataUrl, `data:image/png;base64,${plusSlash}`);
});

test('a feed that is not an image feed is refused with a reason, not handed to the browser', () => {
  for (const v of [null, undefined, '', '   ']) assert.deepEqual(parseFeedImage(v), { ok: false, reason: 'empty' });
  for (const v of ['72.5', 'ON', '{"state":"sleeping","until":1234}', 'iVBORw0K', 'Hello, world!'])
    assert.equal(parseFeedImage(v).reason, 'not-base64', v);
  // Prose made only of letters is indistinguishable from base64 by its alphabet once the
  // spaces are stripped — so it is refused one step later, as bytes that are no picture.
  // Either way it never reaches an <img>; which reason is a detail of the message.
  for (const v of ['Hello world from a text feed', 'BM is how a sentence can start']) {
    const r = parseFeedImage(v);
    assert.equal(r.ok, false, v);
    assert.ok(['not-base64', 'unknown'].includes(r.reason), `${v}: ${r.reason}`);
  }
  // Valid base64 of something that is not a picture.
  assert.deepEqual(parseFeedImage(b64(Buffer.from('just some plain bytes, not a picture at all'))),
    { ok: false, reason: 'unknown' });
});

test('a value over the IO ceiling is refused, and the ceiling is the 512 KB history-off tier', () => {
  assert.equal(IO_MAX_NO_HISTORY, 512 * 1024);
  // Header plus a hundred bytes, a multiple of three so the base64 carries no padding.
  const big = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(100).fill(0)]);
  assert.equal(parseFeedImage(big).ok, true);
  assert.deepEqual(parseFeedImage(big, { max: 100 }), { ok: false, reason: 'too-large' });
  // Exactly at the ceiling is fine — IO itself allows it.
  assert.equal(parseFeedImage(big, { max: big.length }).ok, true);
});

test('base64ByteLength agrees with a real decode, padding included', () => {
  for (const s of [PNG_1x1, PNG, JPEG, GIF, BMP, b64([1]), b64([1, 2]), b64([1, 2, 3])])
    assert.equal(base64ByteLength(s), Buffer.from(s, 'base64').length, s);
  assert.equal(base64ByteLength(''), 0);
});

test('every reason has a sentence, and the sentence names the feed', () => {
  for (const reason of ['empty', 'not-base64', 'unknown', 'too-large', 'anything-else']) {
    const s = feedImageProblem(reason, '"Doorbell"');
    assert.ok(s.startsWith('"Doorbell"'), s);
  }
  assert.match(feedImageProblem('too-large'), /512 KB/);
});

// ---- fitRect: where a picture lands in its frame -------------------------------------

test('contain: whole picture, centred, integer edges', () => {
  // Landscape 4:3 picture into a square frame: width-bound, bars above and below.
  assert.deepEqual(fitRect(400, 300, 100, 100), { x: 0, y: 13, w: 100, h: 75 });
  // Portrait into the same frame: height-bound, bars at the sides.
  assert.deepEqual(fitRect(300, 400, 100, 100), { x: 13, y: 0, w: 75, h: 100 });
  // Same shape as the frame: fills it exactly.
  assert.deepEqual(fitRect(200, 100, 100, 50), { x: 0, y: 0, w: 100, h: 50 });
  // A small picture is scaled UP to the frame, not left at its natural size: the frame is
  // the authored thing and a thumbnail feed should still fill it.
  assert.deepEqual(fitRect(10, 10, 100, 100), { x: 0, y: 0, w: 100, h: 100 });
  assert.equal(fitRect(400, 300, 100, 100, 'contain').crop, undefined);
});

test('contain is the default and an unknown fit falls back to it', () => {
  assert.deepEqual(fitRect(400, 300, 100, 100, undefined), fitRect(400, 300, 100, 100, 'contain'));
  assert.deepEqual(fitRect(400, 300, 100, 100, 'bogus'), fitRect(400, 300, 100, 100, 'contain'));
});

test('cover: the frame is filled and the crop names the window of the picture shown', () => {
  // Landscape into a square: height-bound, so the sides are trimmed — 100 of 400 source
  // columns are visible per 100 frame pixels... i.e. the crop is 300 wide, centred.
  assert.deepEqual(fitRect(400, 300, 100, 100, 'cover'),
    { x: 0, y: 0, w: 100, h: 100, crop: { x: 50, y: 0, width: 300, height: 300 } });
  // Portrait: top and bottom trimmed.
  assert.deepEqual(fitRect(300, 400, 100, 100, 'cover'),
    { x: 0, y: 0, w: 100, h: 100, crop: { x: 0, y: 50, width: 300, height: 300 } });
  // Same shape: nothing trimmed.
  assert.deepEqual(fitRect(200, 100, 100, 50, 'cover').crop, { x: 0, y: 0, width: 200, height: 100 });
});

test('stretch: the frame, exactly, and the picture takes the consequences', () => {
  assert.deepEqual(fitRect(400, 300, 100, 20, 'stretch'), { x: 0, y: 0, w: 100, h: 20 });
});

test('the frame is never ratcheted: a picture is placed into the frame, not into the last picture', () => {
  // The failure mode this design exists to avoid. Alternate a landscape and a portrait
  // picture through the same frame; the frame is what fitRect is given each time, so the
  // result for the landscape is the same on the third reading as on the first.
  const frame = [120, 90];
  const first = fitRect(1600, 900, ...frame);
  fitRect(900, 1600, ...frame);
  assert.deepEqual(fitRect(1600, 900, ...frame), first);
});

test('degenerate sizes do not divide by zero or produce an invisible picture', () => {
  for (const r of [fitRect(0, 0, 100, 100), fitRect(400, 300, 0, 0), fitRect(undefined, null, 10, 10)]) {
    for (const k of ['x', 'y', 'w', 'h']) assert.ok(Number.isInteger(r[k]), JSON.stringify(r));
    assert.ok(r.w >= 1 && r.h >= 1, JSON.stringify(r));
  }
});

// ---- the size ceiling, with a real picture --------------------------------------------

test('a 410 KB bitmap — the one IO refuses — is refused here too, by the same ceiling', () => {
  const big = syntheticBmp(400, 342).toString('base64');            // 410,454 bytes -> 547,272 chars
  assert.ok(big.length > IO_MAX_NO_HISTORY, `${big.length} chars`);
  assert.equal(sniffImageType(big), 'image/bmp', 'it IS a bitmap; size is the only objection');
  assert.deepEqual(parseFeedImage(big), { ok: false, reason: 'too-large' });
});

test('a 65 KB bitmap — the small WipperSnapper logo — is well inside it', () => {
  const small = syntheticBmp(229, 97).toString('base64');          // 66,790 bytes, like the real file
  assert.ok(small.length < IO_MAX_NO_HISTORY);
  const r = parseFeedImage(small);
  assert.equal(r.ok, true);
  assert.equal(r.mime, 'image/bmp');
  assert.equal(r.bytes, 54 + Math.ceil((229 * 3) / 4) * 4 * 97);
});

test('cover never produces an empty or out-of-picture crop, however extreme the shapes', () => {
  // The cases Copilot's review pointed at: a 1×1 picture in a wide, short frame rounded to
  // a zero-high window placed outside the picture, and the transposed case to zero width.
  const inside = (nw, nh, r) => r.crop.width >= 1 && r.crop.height >= 1
    && r.crop.x >= 0 && r.crop.y >= 0 && r.crop.x + r.crop.width <= nw && r.crop.y + r.crop.height <= nh;
  for (const [nw, nh, fw, fh] of [
    [1, 1, 120, 8], [1, 1, 8, 120], [2, 1, 300, 1], [1, 2, 1, 300], [3, 7, 1000, 1], [7, 3, 1, 1000],
    [550, 248, 1, 1], [550, 248, 1, 400], [550, 248, 400, 1], [4, 3, 100, 100],
  ]) {
    const r = fitRect(nw, nh, fw, fh, 'cover');
    assert.ok(inside(nw, nh, r), `${nw}x${nh} into ${fw}x${fh}: ${JSON.stringify(r.crop)}`);
    assert.deepEqual([r.x, r.y, r.w, r.h], [0, 0, fw, fh]);
  }
  assert.deepEqual(fitRect(1, 1, 120, 8, 'cover').crop, { x: 0, y: 0, width: 1, height: 1 });
  // The ordinary case is untouched by the clamp.
  assert.deepEqual(fitRect(400, 300, 100, 100, 'cover').crop, { x: 50, y: 0, width: 300, height: 300 });
});
