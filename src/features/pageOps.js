// Page operations — insert blank page, commit/apply a new page order, flatten to PDF bytes, busy overlay.
// Assembled onto PDFEditorApp.prototype (mixin); verbatim from app.js (this = the app).
import { PDFDocument, rgb, degrees } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import { loadImage } from '../util/image.js';
import { confirmDialog } from '../util/dialog.js';
import { downloadBytes } from '../util/download.js';
import { overEditLimit, withinDeviceCap, DEVICE_CAP_MESSAGE, LARGE_FILE_WARNING } from '../core/limits.js';

export const PageOpsMethods = {
  /** Insert one blank page at the position chosen in the dropdown (end, or after page N). */
  async insertBlankPage() {
    if (!this.pdfJsDoc) return;
    const sel = document.getElementById('insertPos');
    const val = sel ? sel.value : 'end';
    const n = this.pdfJsDoc.numPages;
    const afterIndex = (val === 'end') ? n - 1 : parseInt(val, 10);

    // Match the blank page's size to a neighbouring page so it looks consistent.
    const refIdx = Math.min(Math.max(afterIndex, 0), n - 1);
    const ref = await this.pdfJsDoc.getPage(refIdx + 1);
    const w = ref.view[2] - ref.view[0];
    const h = ref.view[3] - ref.view[1];

    const pend = this._pendingRot || {};
    const order = [];
    for (let i = 0; i < n; i++) {
      order.push({ src: i, rot: pend[i] || 0 });   // carry any pending rotation through the insert
      if (i === afterIndex) order.push({ blank: true, w, h });
    }
    this._pendingRot = {};
    const where = (val === 'end') ? 'at the end' : `after page ${afterIndex + 1}`;
    await this.commitPageOrder(order, `Blank page inserted ${where}.`, 'Adding a blank page…');
  },
  /**
   * Rebuild the document from an ordered list of page descriptors and reload it.
   * Each descriptor is { src: indexInCurrentDoc } or { blank: true, w, h }.
   */
  async commitPageOrder(order, successMsg, busyMsg) {
    if (this._pageOpBusy) return;

    // Page structure changes shift page indices, which would invalidate any pending
    // text edits — confirm before discarding them.
    if (this.edits.length > 0) {
      const ok = await confirmDialog(
        'Reorganizing pages applies to the original document and clears your unsaved text edits (their page positions change). Continue?',
        { title: 'Reorganize pages?', okText: 'Continue', cancelText: 'Cancel' }
      );
      if (!ok) return;
    }

    this._pageOpBusy = true;
    // Block the screen with a spinner while the document is rebuilt + reloaded (can take a moment
    // on large PDFs) so nothing is clickable mid-operation.
    this._showBusy(busyMsg || 'Updating pages…');
    try {
      const bytes = await this.applyPageOrder(order);
      const outPages = order.length;   // exact output page count (one descriptor per output page)

      // Over the device cap: can't safely hold the result — abort and keep the current document.
      if (!withinDeviceCap(bytes.length)) {
        this.showStatus(DEVICE_CAP_MESSAGE, 'error');
        return;
      }

      // Gate on the OUTPUT: once a document is over the 30 MB / 500-page edit limit it is
      // download-only (editing is unsupported). largeFileMode is sticky for the session — a doc
      // opened large stays download-only here even if a delete drops it back under the limit
      // (re-open the downloaded file to edit it).
      const downloadOnly = this.largeFileMode || overEditLimit(bytes.length, outPages);

      // Adopt the rebuilt document as the new in-memory baseline either way (so further page ops
      // and the Download button compound correctly, and the thumbnails reflect the change).
      this.originalFileData = bytes;
      const loadingTask = pdfjsLib.getDocument({ data: bytes.slice(0) });
      this.pdfJsDoc = await loadingTask.promise;
      this.edits = [];
      this.resetHistory();
      this.selectedThumb = null;

      if (downloadOnly) {
        // VIEW-ONLY / large: never route back through the editable pipeline or the backend. Re-render
        // the page bitmaps + thumbnails so the change is visible, and offer a single Download.
        this.largeFileMode = true;
        this.setMode('view');
        await this.buildPages();
        this.enableUiAfterLoad(true);
        this.updatePageInfo();
        this.renderPagesPanel();
        // Drawer already shows the amber "download instead" warning — keep the toast to a brief confirm.
        this.showStatus(successMsg, 'info');
      } else {
        await this.extractTextFromPDFjs();
        await this.buildPages();
        this.updatePageInfo();
        this.renderPagesPanel();
        this.showStatus(successMsg, 'success');
      }
    } catch (e) {
      console.error('Page operation failed:', e);
      const oom = /allocation|out of memory|invalid array length|range/i.test(String(e && e.message));
      this.showStatus(oom ? DEVICE_CAP_MESSAGE : `Couldn't update pages: ${e.message}`, 'error');
    } finally {
      this._pageOpBusy = false;
      this._hideBusy();
    }
  },

  /**
   * Download the current document (used by the pages drawer in large/view-only mode). Bakes any
   * pending rotations into the output with a single pdf-lib pass (no full editor reload), so large
   * files download fast with their rotations applied. Pending state is kept so the preview stays.
   */
  async downloadCurrentPdf() {
    if (!this.originalFileData) return;
    let bytes = this.originalFileData;
    if (this._pendingRot && Object.keys(this._pendingRot).length) {
      const n = this.pdfJsDoc.numPages;
      const order = [];
      for (let i = 0; i < n; i++) order.push({ src: i, rot: this._pendingRot[i] || 0 });
      this._showBusy('Preparing download…');
      try { bytes = await this.applyPageOrder(order); } finally { this._hideBusy(); }
    }
    downloadBytes(bytes, 'document.pdf');
  },
  /** Show / hide the blocking page-operation loading overlay. */
  _showBusy(msg) {
    const o = document.getElementById('busyOverlay'), m = document.getElementById('busyMsg');
    if (m && msg) m.textContent = msg;
    if (o) o.hidden = false;
  },
  _hideBusy() { const o = document.getElementById('busyOverlay'); if (o) o.hidden = true; },
  /**
   * Build new PDF bytes from the ordered descriptor list using pdf-lib. Each descriptor is
   * { src: indexInCurrentDoc } or { blank: true, w, h }; an optional `rot` (90/180/270) is applied
   * LOSSLESSLY as PDF /Rotate, combined with the page's existing rotation (no rasterization).
   */
  async applyPageOrder(order) {
    const src = await PDFDocument.load(this.originalFileData, { ignoreEncryption: true });
    const out = await PDFDocument.create();

    // Copy all needed source pages in one pass (preserves their content & annotations).
    const srcIndices = order.filter(o => o.src != null).map(o => o.src);
    const copied = srcIndices.length ? await out.copyPages(src, srcIndices) : [];

    let ci = 0;
    for (const item of order) {
      const pg = (item.src != null) ? copied[ci++] : out.addPage([item.w || 612, item.h || 792]);
      if (item.rot) {
        const base = (pg.getRotation && pg.getRotation().angle) || 0;
        pg.setRotation(degrees(((base + item.rot) % 360 + 360) % 360));
      }
      if (item.src != null) out.addPage(pg);   // blank pages are already added by addPage() above
    }
    return out.save();
  },
  /**
   * Fallback save for PDFs pdf-lib can't edit (e.g. encrypted ones): render each page
   * with PDF.js, paint the pending edits on top, and rebuild a new PDF from those page
   * images. Always works, but the result is image-based (text is no longer selectable).
   */
  async flattenToPdfBytes(edits) {
    const out = await PDFDocument.create();
    const S = 2; // render scale for crisp output

    for (let p = 0; p < this.pdfJsDoc.numPages; p++) {
      const page = await this.pdfJsDoc.getPage(p + 1);
      const viewport = page.getViewport({ scale: S });
      const cnv = document.createElement('canvas');
      cnv.width = viewport.width;
      cnv.height = viewport.height;
      const cx = cnv.getContext('2d');
      cx.fillStyle = '#ffffff';
      cx.fillRect(0, 0, cnv.width, cnv.height);
      await page.render({ canvasContext: cx, viewport }).promise;

      // Paint this page's edits (coords are PDF points, top-left origin -> * S px).
      for (const e of edits.filter(e => e.pageIndex === p)) {
        if (e.kind === 'image' && e.dataUrl) {
          const im = await loadImage(e.dataUrl);
          cx.drawImage(im, e.x * S, e.top * S, e.width * S, e.height * S);
          continue;
        }
        if (e.kind === 'erase' || (e.redact !== false && e.top != null && e.bottom != null)) {
          // Text replace covers with the cell's own background colour; Erase uses white.
          cx.fillStyle = (e.kind !== 'erase' && Array.isArray(e.bgColor))
            ? `rgb(${e.bgColor[0]},${e.bgColor[1]},${e.bgColor[2]})` : '#ffffff';
          cx.fillRect((e.x - 2) * S, (e.top - 1) * S,
            ((e.right - e.x) + 4) * S, ((e.bottom - e.top) + 2) * S);
        }
        // Added text may carry per-run font sizes (e.runs) and explicit line breaks;
        // replace edits are always a single line at one size.
        const fhasRuns = e.redact === false && Array.isArray(e.runs) && e.runs.length;
        const flines = (e.redact === false)
          ? (e.newText || '').split(/\r\n?|\n/)
          : [(e.newText || '').replace(/[\r\n]+/g, ' ')];
        if (fhasRuns || flines.some(l => l)) {
          cx.fillStyle = '#000000';
          cx.textBaseline = 'alphabetic';
          let fam;
          if (e.style === 'signature') fam = '"Snell Roundhand","Apple Chancery","Brush Script MT",cursive';
          else if (e.fontFamily === 'serif' || (e.fontFamily == null && e.serif)) fam = '"Times New Roman",Times,serif';
          else if (e.fontFamily === 'mono') fam = '"Courier New",Courier,monospace';
          else fam = 'Arial,Helvetica,sans-serif';
          const baseSize = e.fontSize || 12;
          // Line model: explicit runs when present, else one run per line at the base size.
          const lineModel = fhasRuns ? e.runs : flines.map(l => [{ text: l, size: baseSize }]);
          const rot = e.rotation || 0;
          const drawLine = (parts, x0, y0) => {        // chain runs left-to-right at their own style
            let cxpos = x0;
            parts.forEach(r => {
              if (!r.text) return;
              const weight = (fhasRuns ? r.bold : e.bold) ? 'bold ' : '';
              const slant = ((fhasRuns ? r.italic : e.italic) || e.style === 'signature') ? 'italic ' : '';
              cx.font = `${slant}${weight}${(r.size || baseSize) * S}px ${fam}`;
              cx.fillText(r.text, cxpos, y0);
              cxpos += cx.measureText(r.text).width;
            });
          };
          // Advance each line by the larger of the two adjacent lines (no overlap when sizes mix).
          const lineMax = (parts) => Math.max(baseSize, ...parts.map(r => r.size || baseSize));
          const advanceLines = (x0, y0) => {
            let y = y0, prevMax = null;
            lineModel.forEach((parts) => {
              const thisMax = lineMax(parts);
              if (prevMax !== null) y += Math.max(prevMax, thisMax) * 1.2 * S;
              prevMax = thisMax;
              drawLine(parts, x0, y);
            });
          };
          if (rot) {
            cx.save();
            cx.translate(e.x * S, e.baseline * S);
            cx.rotate(rot * Math.PI / 180);     // canvas y-down: +rad is clockwise (matches CSS)
            advanceLines(0, 0);
            cx.restore();
          } else {
            advanceLines(e.x * S, e.baseline * S);
          }
        }
      }

      const img = await out.embedPng(cnv.toDataURL('image/png'));
      const pv = page.getViewport({ scale: 1 });
      const pg = out.addPage([pv.width, pv.height]);
      pg.drawImage(img, { x: 0, y: 0, width: pv.width, height: pv.height });
    }

    return out.save();
  },
};
