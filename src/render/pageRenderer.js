// Page rendering — buildPages, refresh/renderCurrentPage, page-overlay clearing, and pending edit/erase previews.
// Assembled onto PDFEditorApp.prototype (mixin); verbatim from app.js (this = the app).

export const PageRendererMethods = {
  /**
   * Build the stacked, scrollable view: one canvas + overlay wrapper per page.
   * Called when a document is (re)loaded. Preserves nothing — full DOM rebuild.
   */
  async buildPages() {
    if (!this.pdfJsDoc) return;
    const container = document.getElementById('canvasContainer');
    if (!container) return;
    container.innerHTML = '';
    this.pageViews = [];

    for (let i = 0; i < this.pdfJsDoc.numPages; i++) {
      const page = await this.pdfJsDoc.getPage(i + 1);
      // Show any not-yet-baked rotation (large/view-only docs) by rotating the pdf.js viewport — fast,
      // no pdf-lib rebuild. The bake into the file happens only on Download. (Empty for normal docs.)
      const pend = (this._pendingRot && this._pendingRot[i]) || 0;
      const viewport = pend
        ? page.getViewport({ scale: this.scale, rotation: (page.rotate + pend) % 360 })
        : page.getViewport({ scale: this.scale });

      const wrapper = document.createElement('div');
      wrapper.className = 'page-wrap';
      wrapper.dataset.page = String(i);

      const canvas = document.createElement('canvas');
      canvas.className = 'page-canvas';
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      wrapper.appendChild(canvas);
      container.appendChild(wrapper);

      // willReadFrequently keeps the canvas CPU-backed so getImageData (used to sample a line's
      // real background/text colour in edit mode) returns correct pixels instead of empty/black
      // readbacks on a GPU-accelerated canvas.
      const pv = { pageNum: i, page, viewport, canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }), wrapper };
      canvas.addEventListener('click', (e) => this.handleCanvasClick(e, pv));
      canvas.addEventListener('mousedown', (e) => this.onEraseStart(e, pv));
      this.pageViews.push(pv);
      // Mount Fabric.js annotation layer over this page
      this.annotationManager.mountPage(pv);
    }

    this.pageWidth = this.pageViews[0] ? this.pageViews[0].page.view[2] : 612;
    this.pageHeight = this.pageViews[0] ? this.pageViews[0].page.view[3] : 792;
    this.currentPage = 0;
    // Keep the annotation layer interactive across page (re)builds — e.g. the post-save reload remounts
    // the Fabric canvases, which otherwise leaves them pointer-events:none and unable to take new
    // annotations until the user toggles modes. Re-activate + re-arm the current tool when in annotate mode.
    this.annotationManager.setActive(this.mode === 'annotate');
    if (this.mode === 'annotate' && this._lastAnnotateTool) this.annotationManager.setTool(this._lastAnnotateTool);
    await this.refresh();
    this.updatePageInfo();
  },
  /**
   * Re-paint every page's bitmap and rebuild its overlays in place (keeps the DOM and
   * scroll position). Use for edits / mode changes. Alias: renderCurrentPage().
   */
  async refresh() {
    if (!this.pageViews.length) return;
    // Large/view-only docs (no edits/overlays) render LAZILY — only the pages on screen, on scroll —
    // so opening/closing a 500-page file is instant instead of grinding through every page.
    if (this.largeFileMode) { this._refreshLazy(); return; }
    if (this._refreshing) { this._refreshPending = true; return; }
    this._refreshing = true;
    try {
      do {
        this._refreshPending = false;
        // Rebuild the overlay registry from scratch each pass: clearPageOverlays removes the DOM nodes
        // but the array would otherwise keep stale (disconnected) refs, so _overlayElFor could return a
        // removed element and _positionTextToolbar would hide the toolbar (e.g. after styling/linking a
        // committed overlay, which re-renders it).
        this.insertOverlays = [];
        // Every editing mode (Edit, Add, and smart/auto) exposes existing text as per-line editable
        // boxes — the dynamic clicking model means a click on a line edits it in any of them. Only the
        // read-only 'view' mode (and non-text tools) paint committed line edits straight onto the canvas.
        const textEditing = this.mode === 'edit' || this.mode === 'auto' || this.mode === 'text';
        for (const pv of this.pageViews) {
          this.clearPageOverlays(pv);
          await pv.page.render({ canvasContext: pv.ctx, viewport: pv.viewport }).promise;
          this.drawPendingErases(pv);
          if (!textEditing) this.drawPendingLineEdits(pv);  // edit/auto show them in boxes
          this.createInsertOverlays(pv);
          if (textEditing) this.createEditableTextBoxes(pv);
        }
      } while (this._refreshPending);
    } catch (error) {
      console.error('Error rendering pages:', error);
    } finally {
      this._refreshing = false;
    }
  },
  /** Lazy bitmap render for large/view-only docs: paint each page only when it scrolls near view. */
  _refreshLazy() {
    if (this._lazyIO) { this._lazyIO.disconnect(); this._lazyIO = null; }
    this.insertOverlays = [];
    const stage = document.getElementById('stage');
    const paint = (pv) => {
      if (pv._paintedVp === pv.viewport) return;     // already painted this exact viewport
      pv._paintedVp = pv.viewport;
      pv.page.render({ canvasContext: pv.ctx, viewport: pv.viewport }).promise.catch(() => {});
    };
    if (typeof IntersectionObserver === 'function') {
      const byEl = new Map(this.pageViews.map((pv) => [pv.wrapper, pv]));
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) { const pv = byEl.get(e.target); if (pv) paint(pv); }
      }, { root: stage || null, rootMargin: '900px 0px' });   // render a screen ahead/behind
      for (const pv of this.pageViews) io.observe(pv.wrapper);
      this._lazyIO = io;
    } else {
      this.pageViews.slice(0, 25).forEach(paint);              // no IO: just the first pages
    }
  },
  // Back-compat: existing call sites use renderCurrentPage() to mean "refresh overlays".
  renderCurrentPage() { return this.refresh(); },
  clearPageOverlays(pv) {
    pv.wrapper.querySelectorAll('.editable-text-box, .insert-overlay').forEach(el => el.remove());
  },
  /**
   * Draw pending erase rectangles (white-out areas, e.g. an old signature) as a preview.
   */
  drawPendingErases(pv) {
    const erases = this.edits.filter(e => e.kind === 'erase' && e.pageIndex === pv.pageNum);
    if (erases.length === 0) return;
    const ctx = pv.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    erases.forEach(e => {
      ctx.fillRect(e.x * this.scale, e.top * this.scale,
        (e.right - e.x) * this.scale, (e.bottom - e.top) * this.scale);
    });
    ctx.restore();
  },
  /**
   * Draw pending line text-edits onto the canvas (white-cover the original line, then the
   * new text) so an edit stays visible in EVERY mode — not only inside the edit boxes.
   */
  drawPendingLineEdits(pv) {
    const S = this.scale;
    const list = this.edits.filter(e =>
      e.redact !== false && e.kind !== 'erase' && e.pageIndex === pv.pageNum &&
      e.top != null && e.newText != null);
    if (list.length === 0) return;
    const cx = pv.ctx;
    cx.save();
    cx.setTransform(1, 0, 0, 1, 0, 0);
    list.forEach(e => {
      cx.fillStyle = '#ffffff';
      cx.fillRect((e.x - 2) * S, (e.top - 1) * S, ((e.right - e.x) + 4) * S, ((e.bottom - e.top) + 2) * S);
      const text = (e.newText || '').replace(/[\r\n]+/g, ' ');
      if (!text) return;
      cx.fillStyle = '#000000';
      cx.textBaseline = 'alphabetic';
      const fs = (e.fontSize || 12) * S;
      const fam = e.serif ? '"Times New Roman",Times,serif' : 'Arial,Helvetica,sans-serif';
      const weight = e.bold ? 'bold ' : '';
      const slant = e.italic ? 'italic ' : '';
      cx.font = `${slant}${weight}${fs}px ${fam}`;
      cx.fillText(text, e.x * S, e.baseline * S);
    });
    cx.restore();
  },
  /** Find a pending line-edit that matches a given extracted line (by page + position). */
  findLineEdit(line) {
    const s = this.scale;
    const xPt = line.left / s, basePt = line.baseline / s;
    return this.edits.find(e =>
      e.redact !== false && e.kind !== 'erase' && e.pageIndex === line.pageIndex &&
      Math.abs(e.x - xPt) < 1.5 && Math.abs(e.baseline - basePt) < 1.5);
  },
};
