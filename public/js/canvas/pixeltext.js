/**
 * Konva.Text that draws from a bitmap font when one is chosen (see pixelfont.js).
 *
 * A subclass rather than a new element, so every text in the app — labels, the date and
 * time, and every widget's captions — keeps working through the same n.text(),
 * n.fontSize(), n.fill() and transformer code it always did. In a browser font it is a
 * plain Konva.Text. In a bitmap font it measures and draws from the glyph table, at the
 * whole-pixel scale pixelScale() gives for its size: Konva's own wrapping, alignment and
 * padding all run on the widths it reports, and each glyph row is filled as whole pixels
 * at whole-pixel positions.
 */

import { Konva } from './konva.js';
import {
  pixelFontFor, pixelScale, pixelTextWidth, pixelTextRuns, cssFamily, hasPictographs, drawableText,
} from './pixelfont.js';
import { requestEmojiFont } from './webfont.js';

export class PixelText extends Konva.Text {
  /** The bitmap font this text is drawn from, or null. */
  pixelFont() {
    return pixelFontFor(this.fontSize(), this.fontFamily());
  }

  /** The line height of this text in its bitmap font at its scale. */
  _pixelLineH(f) {
    return f.lineH * pixelScale(f, this.fontSize());
  }

  /**
   * The canvas font string Konva measures and draws with. The family is the stack from
   * cssFamily(): the chosen font, then the monochrome emoji fallback. A text that holds
   * an emoji or symbol asks for that font the first time it is drawn, and lays itself
   * out again once it has arrived — the OS's colour emoji stood in until then.
   */
  _getContextFont() {
    if (this.pixelFont()) return super._getContextFont();
    const text = this.text();
    if (this._emojiAskedFor !== text && hasPictographs(text)) {
      this._emojiAskedFor = text;            // once per text: a redraw must not re-ask
      requestEmojiFont(text).then(() => {
        if (!this.getLayer()) return;        // deleted while the font was loading
        this._setTextData();
        this.getLayer().batchDraw();
      });
    }
    return `${this.fontStyle()} ${this.fontVariant()} ${this.fontSize()}px ${cssFamily(this.fontFamily())}`;
  }

  /**
   * Konva splits text() into the lines it draws here. It is given drawableText() of it
   * instead — emoji in text presentation, so the fallback font draws them — while text()
   * itself, what the inspector shows and the document saves, keeps what was typed.
   */
  _setTextData() {
    const raw = this.attrs.text;
    const drawn = drawableText(raw);
    if (drawn === raw) return super._setTextData();
    this.attrs.text = drawn;
    try { return super._setTextData(); } finally { this.attrs.text = raw; }
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
    return this.textArr.length * this._pixelLineH(f) + 2 * this.padding();
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
}
