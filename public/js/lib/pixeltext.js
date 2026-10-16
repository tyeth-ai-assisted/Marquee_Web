/**
 * Konva.Text that draws from a bitmap font when one is chosen (see pixelfont.js).
 *
 * A subclass rather than a new element, so every text in the app — labels, the date and
 * time, and every widget's captions — keeps working through the same n.text(),
 * n.fontSize(), n.fill() and transformer code it always did. In an outline font it is a
 * plain Konva.Text. In a bitmap font it measures and draws from the glyph table, at the
 * whole-pixel scale pixelScale() gives for its size: Konva's own wrapping, alignment and
 * padding all run on the widths it reports, and each glyph row is filled as whole pixels
 * at whole-pixel positions.
 *
 * Konva is the host's (the editor's vendored build, or a server's canvas-backed one), so
 * the class is made from the Konva it is handed, once per Konva.
 */

import { pixelFontFor, pixelScale, pixelTextWidth, pixelTextRuns } from './pixelfont.js';

const classes = new WeakMap();

/** The PixelText class for this Konva. */
export function pixelTextClass(Konva) {
  let PixelText = classes.get(Konva);
  if (PixelText) return PixelText;

  PixelText = class extends Konva.Text {
    /** The bitmap font this text is drawn from, or null. */
    pixelFont() {
      return pixelFontFor(this.fontFamily());
    }

    _getTextWidth(text) {
      const f = this.pixelFont();
      if (!f) return super._getTextWidth(text);
      return pixelTextWidth(f, text, this.letterSpacing(), pixelScale(f, this.fontSize()));
    }

    getHeight() {
      const f = this.pixelFont();
      const authored = this.attrs.height !== undefined && this.attrs.height !== 'auto';
      if (!f || authored) return super.getHeight();
      return this.textArr.length * f.lineH * pixelScale(f, this.fontSize()) + 2 * this.padding();
    }

    _sceneFunc(ctx) {
      const f = this.pixelFont();
      if (!f) { super._sceneFunc(ctx); return; }
      if (!this.text()) return;
      const pad = this.padding(), boxW = this.getWidth(), align = this.align();
      const spacing = this.letterSpacing();
      const scale = pixelScale(f, this.fontSize()), lineH = f.lineH * scale;
      ctx.setAttr('fillStyle', this.fill());
      let y = pad;
      const extra = this.getHeight() - this.textArr.length * lineH - 2 * pad;
      if (this.verticalAlign() === 'middle') y += Math.floor(extra / 2);
      else if (this.verticalAlign() === 'bottom') y += extra;
      y = Math.round(y);
      for (const line of this.textArr) {
        let x = pad;
        if (align === 'right') x += boxW - line.width - 2 * pad;
        else if (align === 'center') x += Math.floor((boxW - line.width - 2 * pad) / 2);
        x = Math.round(x);
        pixelTextRuns(f, line.text, (rx, ry, len, thick) => ctx.fillRect(x + rx, y + ry, len, thick), spacing, scale);
        y += lineH;
      }
    }
  };
  classes.set(Konva, PixelText);
  return PixelText;
}

/** A new text node: `new Konva.Text(config)`, drawing from a bitmap font when it names one. */
export function newText(Konva, config) {
  return new (pixelTextClass(Konva))(config);
}
