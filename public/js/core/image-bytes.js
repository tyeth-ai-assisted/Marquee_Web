/** Raster signatures shared by browser uploads and Worker downloads. */
export function rasterType(bytes) {
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v))
    return "image/png";
  if (String.fromCharCode(...bytes.slice(0, 4)) === "GIF8") return "image/gif";
  if (bytes[0] === 66 && bytes[1] === 77) return "image/bmp";
  if (
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  )
    return "image/webp";
  return null;
}
