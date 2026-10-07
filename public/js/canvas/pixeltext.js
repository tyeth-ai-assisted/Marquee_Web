/**
 * Konva.Text that draws small text from a bitmap font (see pixelfont.js).
 *
 * A subclass rather than a new element, so every text in the app — labels, the date and
 * time, and every widget's captions — keeps working through the same n.text(),
 * n.fontSize(), n.fill() and transformer code it always did. At 8 px and up, or in a
 * named font, it is a plain Konva.Text. Below that it measures and draws from the glyph
 * table: Konva's own wrapping, alignment and padding all run on the widths it reports,
 * and each glyph row is filled as whole pixels at whole-pixel positions.
 */

import { Konva } from './konva.js';
import { pixelFontFor, pixelTextWidth, pixelTextRuns } from './pixelfont.js';

export class PixelText extends Konva.Text {
  /** The bitmap font standing in for this text's size and family, or null. */
  pixelFont() {
    return pixelFontFor(this.fontSize(), this.fontFamily());
  }

  _getTextWidth(text) {
    const f = this.pixelFont();
    return f ? pixelTextWidth(f, text, this.letterSpacing()) : super._getTextWidth(text);
  }

  getHeight() {
    const f = this.pixelFont();
    const authored = this.attrs.height !== undefined && this.attrs.height !== 'auto';
    if (!f || authored) return super.getHeight();
    return this.textArr.length * f.lineH + 2 * this.padding();
  }

  _sceneFunc(ctx) {
    const f = this.pixelFont();
    if (!f) { super._sceneFunc(ctx); return; }
    if (!this.text()) return;
    const pad = this.padding(), boxW = this.getWidth(), align = this.align();
    const spacing = this.letterSpacing();
    ctx.setAttr('fillStyle', this.fill());
    let y = pad;
    const extra = this.getHeight() - this.textArr.length * f.lineH - 2 * pad;
    if (this.verticalAlign() === 'middle') y += Math.floor(extra / 2);
    else if (this.verticalAlign() === 'bottom') y += extra;
    y = Math.round(y);
    for (const line of this.textArr) {
      let x = pad;
      if (align === 'right') x += boxW - line.width - 2 * pad;
      else if (align === 'center') x += Math.floor((boxW - line.width - 2 * pad) / 2);
      x = Math.round(x);
      pixelTextRuns(f, line.text, (rx, ry, len) => ctx.fillRect(x + rx, y + ry, len, 1), spacing);
      y += f.lineH;
    }
  }
}
