/**
 * A valid 24-bit BMP of the given pixel size — header plus raw rows — built in memory so
 * the test can be exact about the ceiling without a 400 KB fixture in the repo. The real
 * file this stands in for is a 410 KB WipperSnapper logo whose base64 runs to 546,336
 * characters; IO refused it with a 422 (see feedimage.live.test.js).
 */
export function syntheticBmp(width, height) {
  const rowBytes = Math.ceil((width * 3) / 4) * 4;
  const pixels = rowBytes * height;
  const buf = Buffer.alloc(54 + pixels);
  buf.write('BM', 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);           // pixel data offset
  buf.writeUInt32LE(40, 14);           // BITMAPINFOHEADER
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);            // planes
  buf.writeUInt16LE(24, 28);           // bits per pixel
  buf.writeUInt32LE(pixels, 34);
  return buf;
}
