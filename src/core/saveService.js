// Save service — mupdf-wasm in-browser save + the pdf-lib offline flatten fallback (white-out
// rects + overlays). Assembled onto PDFEditorApp.prototype (mixin); verbatim from app.js.
import { PDFDocument, StandardFonts, rgb, degrees, BlendMode } from 'pdf-lib';
import { MupdfService } from '../services/mupdfService.js';

export const SaveServiceMethods = {
  async savePDF() {
    if (!this.controller.isLoaded) {
      this.showStatus('No PDF loaded', 'error');
      return;
    }

    this.showStatus('Saving PDF…', 'info');

    if (!this.originalFileData) {
      this.showStatus('Failed to save: the original PDF data is not available.', 'error');
      return;
    }

    // Produce the fully-edited bytes (bakes previewed rotation + applies this.edits via the fidelity
    // fallback chain). Shared with Split so both bake edits identically.
    const { bytes: editedPdfBytes, flattened } = await this._produceEditedBytes();

    if (!editedPdfBytes) {
      this.showStatus('Failed to save. Please reload the page and try again.', 'error');
      return;
    }

    // Download it. The save has succeeded the moment this completes.
    try {
      const blob = new Blob([editedPdfBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'edited-document.pdf';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Download failed:', e);
      this.showStatus('Failed to save: could not start the download.', 'error');
      return;
    }

    // Post-save housekeeping. The file is ALREADY saved, so any error here is non-fatal
    // and must never turn a successful save into a "Failed to save" message.
    try {
      if (flattened) {
        this.showStatus('Saved a flattened copy. This PDF is protected, so text-level editing wasn\'t possible. To keep selectable text, remove the PDF\'s protection first.', 'info');
      } else {
        this.showStatus('Saved! Your edited PDF has been downloaded.', 'success');
      }
    } catch (e) {
      console.warn('Post-save refresh failed (the file was already saved):', e);
      this.showStatus('Saved! Your edited PDF has been downloaded.', 'success');
    }

    // Keep the document loaded after saving so the user can continue editing. (Previously the
    // page reloaded ~1.6s after save, wiping the document back to the upload screen.)
  },

  /**
   * Produce the fully-edited PDF bytes WITHOUT downloading — bakes previewed-but-uncommitted
   * rotations, then applies this.edits through the same fidelity fallback chain savePDF uses
   * (mupdf-wasm true-removal → pdf-lib cover+redraw → flatten-to-image). Returns
   * { bytes: Uint8Array|null, flattened: boolean }. Shared by savePDF() and the Split feature so a
   * split carries the user's edits (replaced/added text, font/style changes) exactly like a save.
   */
  async _produceEditedBytes() {
    if (!this.originalFileData) return { bytes: null, flattened: false };

    // Bake any rotations previewed in the Rotate/Reorder panel but not yet committed (deferred for
    // speed) into originalFileData first, so they ride into whatever we produce below.
    if (this._pendingRot && Object.keys(this._pendingRot).length) {
      const n = this.pdfJsDoc.numPages;
      const order = [];
      for (let i = 0; i < n; i++) order.push({ src: i, rot: this._pendingRot[i] || 0 });
      try { this.originalFileData = await this.applyPageOrder(order); this._pendingRot = {}; }
      catch (e) { console.warn('Could not bake pending rotation before producing bytes:', e); }
    }

    let editedPdfBytes = null;
    let flattened = false;
    const fabricAnnotations = this.annotationManager ? this.annotationManager.serialize() : [];
    // Redaction removes whole RUNS: an edited line whose band overlaps another run on the SAME row
    // (a form fill-in over a blank) would silently delete that run. Expand with preserve edits that
    // re-add such runs verbatim (local copy — undo/history untouched).
    const editsForSave = this._withEntangledPreserves
      ? this._withEntangledPreserves(this.edits) : this.edits;

    // Tier 1: in-browser mupdf-wasm (true text removal, embedded-font reuse); DECLINES to the next
    // tier on edits it can't do faithfully, so it never regresses the pdf-lib result.
    if (MupdfService.isSupported()) {
      try { editedPdfBytes = await MupdfService.editPDF(this.originalFileData, editsForSave, fabricAnnotations); }
      catch (e) { console.warn('WASM save unavailable/declined:', e); }
    }
    // Tier 2: pdf-lib cover-and-redraw (offline / static host).
    if (!editedPdfBytes) {
      try { editedPdfBytes = await this.applyEditsWithPdfLib(this.originalFileData, editsForSave); }
      catch (e) { console.warn('Client-side (vector) save failed, flattening instead:', e); }
    }
    // Tier 3: flatten-to-image last resort (odd page trees / protected PDFs pdf-lib can't traverse).
    if (!editedPdfBytes) {
      try { editedPdfBytes = await this.flattenToPdfBytes(editsForSave); flattened = true; }
      catch (e) { console.warn('Flatten save failed:', e); }
    }
    return { bytes: editedPdfBytes, flattened };
  },
  /**
   * Apply all edits to the PDF in the browser using pdf-lib and return the new bytes.
   * Coordinates in `edits` are PDF points with a TOP-LEFT origin; pdf-lib uses a
   * BOTTOM-LEFT origin, so y is flipped with pageHeight.
   *  - replace edits (redact !== false): cover the original line with a white box, then
   *    draw the new text at the original baseline.
   *  - insert edits (added text / signatures): just draw the text (signatures in italic).
   */
  async applyEditsWithPdfLib(originalBytes, edits) {
    // Many PDFs carry empty-password "permissions" encryption; load them anyway.
    const pdfDoc = await PDFDocument.load(originalBytes, { ignoreEncryption: true });
    const sans = {
      regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
      bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
      italic: await pdfDoc.embedFont(StandardFonts.HelveticaOblique),
      boldItalic: await pdfDoc.embedFont(StandardFonts.HelveticaBoldOblique),
    };
    const serif = {
      regular: await pdfDoc.embedFont(StandardFonts.TimesRoman),
      bold: await pdfDoc.embedFont(StandardFonts.TimesRomanBold),
      italic: await pdfDoc.embedFont(StandardFonts.TimesRomanItalic),
      boldItalic: await pdfDoc.embedFont(StandardFonts.TimesRomanBoldItalic),
    };
    const mono = {
      regular: await pdfDoc.embedFont(StandardFonts.Courier),
      bold: await pdfDoc.embedFont(StandardFonts.CourierBold),
      italic: await pdfDoc.embedFont(StandardFonts.CourierOblique),
      boldItalic: await pdfDoc.embedFont(StandardFonts.CourierBoldOblique),
    };
    const pages = pdfDoc.getPages();
    const white = rgb(1, 1, 1);
    const black = rgb(0, 0, 0);

    // Pick family (added text uses fontFamily; line edits use detected serif) + weight/style.
    const pickFont = (e) => {
      if (e.style === 'signature') return sans.italic;
      let fam = sans;
      if (e.fontFamily === 'serif' || (e.fontFamily == null && e.serif)) fam = serif;
      else if (e.fontFamily === 'mono') fam = mono;
      if (e.bold && e.italic) return fam.boldItalic;
      if (e.bold) return fam.bold;
      if (e.italic) return fam.italic;
      return fam.regular;
    };

    for (const edit of edits) {
      const page = pages[edit.pageIndex];
      if (!page) continue;
      const ph = page.getHeight();

      // Drawn-signature / stamp image: embed and place (top-left origin -> bottom-left).
      if (edit.kind === 'image' && edit.dataUrl) {
        const png = await pdfDoc.embedPng(edit.dataUrl);
        const w = edit.width, h = edit.height;
        const rot = edit.rotation || 0;
        if (!rot) {
          page.drawImage(png, { x: edit.x, y: ph - edit.top - h, width: w, height: h });
        } else {
          // pdf-lib rotates about the (x,y) anchor; offset it so the rotation is about the
          // image centre (matching the on-screen overlay). CSS rotates clockwise for +deg,
          // pdf-lib counter-clockwise, so negate the angle.
          const cx = edit.x + w / 2;
          const cy = ph - edit.top - h / 2;
          const rad = -rot * Math.PI / 180;
          const cos = Math.cos(rad), sin = Math.sin(rad);
          const ax = cx - (w / 2 * cos - h / 2 * sin);
          const ay = cy - (w / 2 * sin + h / 2 * cos);
          page.drawImage(png, { x: ax, y: ay, width: w, height: h, rotate: degrees(-rot) });
        }
        continue;
      }

      let size = edit.fontSize || 12;
      const font = pickFont(edit);
      const ehasRuns = edit.redact === false && Array.isArray(edit.runs) && edit.runs.length;
      // The standard font variant for a run: its own bold/italic when runs are present, else the
      // box-level `font`. Family (sans/serif/mono) is box-level.
      const fontFor = (r) => ehasRuns
        ? pickFont({ style: edit.style, fontFamily: edit.fontFamily, serif: edit.serif, bold: r.bold, italic: r.italic })
        : font;
      // Line model: [[{text,size,bold,italic}], ...]. Explicit runs carry per-run style; otherwise
      // one run per line at `size`. Replace edits are always a single line. Text is sanitised for
      // the standard font (pdf-lib can only encode WinAnsi).
      const lineModel = ehasRuns
        ? edit.runs.map(line => line.map(r => ({ text: this.sanitizeForStandardFont(r.text), size: r.size || size, bold: !!r.bold, italic: !!r.italic })))
        : ((edit.redact === false)
          ? (edit.newText || '').split(/\r\n?|\n/).map(l => [{ text: this.sanitizeForStandardFont(l), size }])
          : [[{ text: this.sanitizeForStandardFont((edit.newText || '').replace(/[\r\n]+/g, ' ')), size }]]);

      // Replace: cover the original line first. pdf-lib can't delete the underlying glyphs,
      // so we paint over them — but with the line's OWN background colour (sampled from the
      // page) so a shaded/coloured cell isn't turned white. The Erase tool still uses white.
      if (edit.redact !== false && edit.top != null && edit.bottom != null) {
        let coverColor = white;
        if (edit.kind !== 'erase' && Array.isArray(edit.bgColor)) {
          coverColor = rgb(edit.bgColor[0] / 255, edit.bgColor[1] / 255, edit.bgColor[2] / 255);
        }
        page.drawRectangle({
          x: edit.x - 2,
          y: ph - edit.bottom - 1,
          width: (edit.right - edit.x) + 4,
          height: (edit.bottom - edit.top) + 2,
          color: coverColor,
        });
      }

      if (!lineModel.some(parts => parts.some(r => r.text))) continue;
      const lineWidth = (parts) => parts.reduce((w, r) => {
        try { return w + fontFor(r).widthOfTextAtSize(r.text, r.size); } catch (e) { return w; }
      }, 0);
      // The substituted standard font is often wider than the PDF's original, which can push an
      // edited line off the right edge. If the widest line overflows the space to the right
      // margin, scale every run down by the same factor (proportions kept, nothing cut off).
      const avail = page.getWidth() - edit.x - 4;
      if (avail > 8) {
        let w = 0;
        for (const parts of lineModel) w = Math.max(w, lineWidth(parts));
        if (w > avail) {
          const scale = Math.max(0.05, avail / w);
          lineModel.forEach(parts => parts.forEach(r => { r.size = Math.max(4, r.size * scale); }));
        }
      }
      // Added text can be rotated to any angle about its origin (x, baseline). pdf-lib rotates
      // glyphs counter-clockwise, so use -rotation to match the CSS (clockwise) preview: drop each
      // line by its own height (rotated about the origin), then chain its runs along the baseline.
      const rot = edit.rotation || 0;
      const rad = rot * Math.PI / 180;
      // A MOVED line: the cover above stays on the ORIGINAL rect; the redraw shifts by dx/dy
      // (PDF pts, top-origin — so +dy moves DOWN, i.e. subtracts in pdf-lib's bottom-origin y).
      const baseX = edit.x + (+(edit.dx) || 0), baseY = ph - (edit.baseline + (+(edit.dy) || 0));
      let drop = 0, prevMax = null;
      lineModel.forEach((parts) => {
        const thisMax = Math.max(4, ...parts.map(r => r.size));
        // Use the larger of adjacent lines so a big line after a small one doesn't overlap.
        if (prevMax !== null) drop += Math.max(prevMax, thisMax) * 1.2;
        prevMax = thisMax;
        const lx = baseX - drop * Math.sin(rad);
        const ly = baseY - drop * Math.cos(rad);
        let adv = 0;
        parts.forEach(r => {
          if (!r.text) return;
          const rf = fontFor(r);
          const opts = { x: lx + adv * Math.cos(rad), y: ly - adv * Math.sin(rad), size: r.size, font: rf, color: black };
          if (rot) opts.rotate = degrees(-rot);
          try { page.drawText(r.text, opts); }
          catch (e) { page.drawText(r.text.replace(/[^\x20-\x7E]/g, '?'), opts); }
          try { adv += rf.widthOfTextAtSize(r.text, r.size); } catch (e) { adv += r.text.length * r.size * 0.5; }
        });
      });
    }

    // ── Burn in Fabric.js annotations ──────────────────────────────────────────
    const annotations = this.annotationManager ? this.annotationManager.serialize() : [];
    for (const ann of annotations) {
      const page = pages[ann.pageIndex];
      if (!page) continue;

      // Helper: parse an rgb/rgba/hex colour string to a pdf-lib rgb(). Defaults to black.
      const parsePdfColor = (colorStr, fallbackR = 0, fallbackG = 0, fallbackB = 0) => {
        if (!colorStr) return rgb(fallbackR, fallbackG, fallbackB);
        // hex #rrggbb
        const hexM = colorStr.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
        if (hexM) return rgb(parseInt(hexM[1], 16) / 255, parseInt(hexM[2], 16) / 255, parseInt(hexM[3], 16) / 255);
        // rgb(r,g,b) or rgba(r,g,b,a)
        const rgbM = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (rgbM) return rgb(+rgbM[1] / 255, +rgbM[2] / 255, +rgbM[3] / 255);
        return rgb(fallbackR, fallbackG, fallbackB);
      };

      if (ann.kind === 'ann-line') {
        try {
          page.drawLine({
            start: { x: ann.x1, y: ann.y1 },
            end: { x: ann.x2, y: ann.y2 },
            thickness: Math.max(0.5, ann.strokeWidth),
            color: parsePdfColor(ann.stroke),
          });
        } catch (_) {}

      } else if (ann.kind === 'ann-rect') {
        try {
          page.drawRectangle({
            x: ann.x, y: ann.y, width: ann.width, height: ann.height,
            borderColor: parsePdfColor(ann.stroke),
            borderWidth: Math.max(0.5, ann.strokeWidth),
            color: undefined,  // transparent fill
          });
        } catch (_) {}

      } else if (ann.kind === 'ann-highlight') {
        // Semi-transparent highlight rectangle drawn with Multiply blend mode so the
        // ink tints the text underneath rather than covering it — exactly like a real
        // highlighter. BlendMode.Multiply darkens where colours overlap and is
        // transparent-effective on white backgrounds, preventing text from being hidden.
        try {
          page.drawRectangle({
            x: ann.x, y: ann.y, width: ann.width, height: ann.height,
            color: parsePdfColor(ann.fill || '#FFD600'),
            opacity: ann.opacity ?? 0.4,
            blendMode: BlendMode.Multiply,
          });
        } catch (_) {}

      } else if (ann.kind === 'ann-ellipse') {
        try {
          page.drawEllipse({
            x: ann.x, y: ann.y, xScale: ann.rx, yScale: ann.ry,
            borderColor: parsePdfColor(ann.stroke),
            borderWidth: Math.max(0.5, ann.strokeWidth),
          });
        } catch (_) {}

      } else if (ann.kind === 'ann-table') {
        // Draw the table grid as individual lines
        try {
          const { x, y, width, height, rows, cols, strokeWidth } = ann;
          const cellW = width / cols;
          const cellH = height / rows;
          const strokeColor = parsePdfColor(ann.stroke || '#2d3a5c');
          const lw = Math.max(0.5, strokeWidth);
          // Horizontal lines (y is bottom-left: table goes UP from y)
          for (let r = 0; r <= rows; r++) {
            const ly = y + r * cellH;
            page.drawLine({ start: { x, y: ly }, end: { x: x + width, y: ly }, thickness: lw, color: strokeColor });
          }
          // Vertical lines
          for (let c = 0; c <= cols; c++) {
            const lx = x + c * cellW;
            page.drawLine({ start: { x: lx, y }, end: { x: lx, y: y + height }, thickness: lw, color: strokeColor });
          }
        } catch (_) {}

      } else if (ann.kind === 'ann-path') {
        // Freehand draw / freehand highlight: render to an off-screen canvas then embed as image.
        // (pdf-lib's drawSvgPath is limited; this approach preserves every brush stroke faithfully.)
        // The entire Fabric annotation layer for the page is rasterised once as a transparent PNG,
        // then stamped with BlendMode.Multiply so:
        //   • pure-white pixels (background) multiply to white  → fully transparent / pass-through
        //   • coloured pixels (strokes, highlights) multiply the PDF text → tinting, not covering
        // Without Multiply the PNG composites as normal alpha and semi-transparent yellow appears
        // as a milky opaque film that hides the text underneath.
        try {
          const { fabricCanvas } = this.annotationManager.pages.find(p => p.pageIndex === ann.pageIndex) || {};
          if (fabricCanvas) {
            // Embed once per page — all paths on the same page share one PNG layer.
            if (!this._embeddedAnnPages) this._embeddedAnnPages = new Set();
            if (!this._embeddedAnnPages.has(ann.pageIndex)) {
              this._embeddedAnnPages.add(ann.pageIndex);
              const dataUrl = fabricCanvas.toDataURL({ format: 'png', multiplier: 1 });
              if (dataUrl && dataUrl !== 'data:,') {
                const imgBytes = await fetch(dataUrl).then(r => r.arrayBuffer());
                const pngImg = await pdfDoc.embedPng(imgBytes);
                const ph = page.getHeight();
                const pw = page.getWidth();
                // BlendMode.Multiply: imported at the top of this file from pdf-lib.
                page.drawImage(pngImg, {
                  x: 0, y: 0, width: pw, height: ph,
                  opacity: 1,
                  blendMode: BlendMode.Multiply,
                });
              }
            }
          }
        } catch (_) {}
      }
    }
    // Clean up per-save state
    delete this._embeddedAnnPages;

    return pdfDoc.save();
  },
};
