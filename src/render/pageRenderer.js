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
      // Mount Fabric.js annotation layer over this page. A LAZY-editable doc (501+ pages) defers
      // this to first paint — 1000+ eager Fabric canvases alone are enough memory to crash the tab.
      if (!this.lazyEditMode) this.annotationManager.mountPage(pv);
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
  async refresh(opts = {}) {
    if (!this.pageViews.length) return;
    // Large/view-only docs (no edits/overlays) render LAZILY — only the pages on screen, on scroll —
    // so opening/closing a 500-page file is instant instead of grinding through every page.
    if (this.largeFileMode) { this._refreshLazy(); return; }
    // Big-but-EDITABLE doc (501–1500 pages): windowed rendering — full overlays (boxes, covers,
    // annotations) but only for pages near the viewport, evicting far ones. Same editing pipeline,
    // page at a time, so memory stays flat instead of scaling with the page count.
    if (this.lazyEditMode) { this._refreshLazyEditable(opts); return; }
    // opts.only (Set of page indexes): re-render JUST those pages — undo/redo of a one-page edit
    // must not loop a 100-page document. A refresh queued while running always reruns FULL.
    let only = (opts.only instanceof Set && opts.only.size) ? opts.only : null;
    if (this._refreshing) { this._refreshPending = true; return; }
    this._refreshing = true;
    // The text layer builds PROGRESSIVELY page by page below (seconds on a 100-page doc). Search
    // consults this flag: a query that runs mid-build re-scans when pages are still arriving, so
    // the match count converges to the full document instead of silently stopping at the pages
    // that happened to exist at keystroke time.
    this._textLayerComplete = false;
    try {
      do {
        if (this._refreshPending) only = null;               // a queued request widens to a full pass
        this._refreshPending = false;
        // Rebuild the overlay registry from scratch each pass: clearPageOverlays removes the DOM nodes
        // but the array would otherwise keep stale (disconnected) refs, so _overlayElFor could return a
        // removed element and _positionTextToolbar would hide the toolbar (e.g. after styling/linking a
        // committed overlay, which re-renders it). A TARGETED pass drops only the refreshed pages'
        // entries — the other pages' overlay DOM stays untouched, so their refs remain live.
        if (only) this.insertOverlays = this.insertOverlays.filter((o) => !only.has(o.__edit ? o.__edit.pageIndex : -1));
        else this.insertOverlays = [];
        // Every editing mode (Edit, Add, and smart/auto) exposes existing text as per-line editable
        // boxes — the dynamic clicking model means a click on a line edits it in any of them. Only the
        // read-only 'view' mode (and non-text tools) paint committed line edits straight onto the canvas.
        const textEditing = this.mode === 'edit' || this.mode === 'auto' || this.mode === 'text';
        for (const pv of this.pageViews) {
          if (only && !only.has(pv.pageNum)) continue;
          this.clearPageOverlays(pv);
          await pv.page.render({ canvasContext: pv.ctx, viewport: pv.viewport }).promise;
          this.drawPendingErases(pv);
          if (!textEditing) this.drawPendingLineEdits(pv);  // edit/auto show them in boxes
          this.createInsertOverlays(pv);
          if (textEditing) this.createEditableTextBoxes(pv);
        }
      } while (this._refreshPending);
      this._textLayerComplete = true;
    } catch (error) {
      console.error('Error rendering pages:', error);
      this._textLayerComplete = true;   // don't leave search polling forever on a render error
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
  /**
   * Windowed renderer for LAZY-EDITABLE docs (501–1500 pages). Each page paints — bitmap render,
   * pending-erase preview, insert overlays, editable text boxes, Fabric layer (mounted once) —
   * only when it scrolls within ~1200px of the viewport, and far pages are EVICTED (overlays
   * removed, canvas backing shrunk to 1×1 while the locked CSS size preserves layout/scroll).
   * Re-entering repaints from the same pipeline, so pending edits re-render correctly.
   * Known trade-off: Search only sees painted pages' boxes on these documents.
   */
  _refreshLazyEditable(opts = {}) {
    const textEditing = this.mode === 'edit' || this.mode === 'auto' || this.mode === 'text';
    const stage = document.getElementById('stage');
    const paint = async (pv, force = false) => {
      if (pv._lePainting) { pv._leRepaint = pv._leRepaint || force; return; }
      if (pv._lePainted && !force) return;
      pv._lePainting = true;
      try {
        // Lock the on-screen size once so evicting (attr 1×1) can't collapse layout / jump scroll.
        if (!pv._leCssLocked) {
          const cw = pv.canvas.clientWidth, ch = pv.canvas.clientHeight;
          if (cw && ch) { pv.canvas.style.width = cw + 'px'; pv.canvas.style.height = ch + 'px'; pv._leCssLocked = true; }
        }
        // Restore full-res backing if this canvas was evicted.
        if (pv.canvas.width !== pv.viewport.width || pv.canvas.height !== pv.viewport.height) {
          pv.canvas.width = pv.viewport.width;
          pv.canvas.height = pv.viewport.height;
        }
        this.insertOverlays = this.insertOverlays.filter((o) => (o.__edit ? o.__edit.pageIndex : -1) !== pv.pageNum);
        this.clearPageOverlays(pv);
        // On-demand hydration: this page's text geometry is extracted only now (lazy docs skip
        // the all-pages extraction at load), then the normal per-page pipeline runs unchanged.
        await this._ensurePageExtracted(pv);
        await pv.page.render({ canvasContext: pv.ctx, viewport: pv.viewport }).promise;
        this.drawPendingErases(pv);
        if (!textEditing) this.drawPendingLineEdits(pv);
        this.createInsertOverlays(pv);
        if (textEditing) await this.createEditableTextBoxes(pv);
        if (!pv._annMounted) { this.annotationManager.mountPage(pv); pv._annMounted = true; }
        pv._lePainted = true;
        // Hard cap on concurrently-painted pages (fast scrolling can outrun leave events): evict
        // the stalest painted page outside the current visible set until we're back under budget.
        const painted = this.pageViews.filter((p) => p._lePainted);
        if (painted.length > 14) {
          painted
            .filter((p) => p !== pv && !(this._leVisible && this._leVisible.has(p)))
            .sort((a, b) => (a._leSeen || 0) - (b._leSeen || 0))
            .slice(0, painted.length - 14)
            .forEach((p) => evict(p));
        }
      } catch (e) {
        console.warn('lazy-edit paint failed for page', pv.pageNum + 1, e);
      } finally {
        pv._lePainting = false;
        if (pv._leRepaint) { pv._leRepaint = false; paint(pv, true); }
      }
    };
    const evict = (pv) => {
      if (!pv._lePainted || pv._lePainting) return;
      // Never evict the page the user is interacting with (removing a focused box skips its blur
      // commit) — it will be evicted on a later pass once focus moves on.
      if (pv.wrapper.contains(document.activeElement)) return;
      this.insertOverlays = this.insertOverlays.filter((o) => (o.__edit ? o.__edit.pageIndex : -1) !== pv.pageNum);
      this.clearPageOverlays(pv);
      pv.canvas.width = 1; pv.canvas.height = 1;    // frees the multi-MB backing store
      pv._lePainted = false;
      // The Fabric layer stays mounted once created: it may hold the user's annotations, and one
      // stays cheap — only pages the user actually visited ever mount one.
    };

    // Targeted pass (undo/redo, style commits): repaint just those pages if currently painted.
    if (opts.only instanceof Set && opts.only.size && this._lazyEditIO) {
      for (const pv of this.pageViews) {
        if (opts.only.has(pv.pageNum) && (pv._lePainted || pv._lePainting)) paint(pv, true);
      }
      this._textLayerComplete = true;
      return;
    }

    // Expose the painter to features that must materialise a far page on demand — Search jumps
    // to a match on an unpainted page by awaiting _lePaint(pv) before resolving its DOM box.
    this._lePaint = paint;
    this._leEvict = evict;

    if (this._lazyEditIO) { this._lazyEditIO.disconnect(); this._lazyEditIO = null; }
    this.pageViews.forEach((pv) => { pv._lePainted = false; pv._lePainting = false; });
    this.insertOverlays = [];
    this._leVisible = new Set();
    if (typeof IntersectionObserver === 'function') {
      const byEl = new Map(this.pageViews.map((pv) => [pv.wrapper, pv]));
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          const pv = byEl.get(e.target);
          if (!pv) continue;
          if (e.isIntersecting) { this._leVisible.add(pv); pv._leSeen = performance.now(); paint(pv); }
          else { this._leVisible.delete(pv); evict(pv); }
        }
      }, { root: stage || null, rootMargin: '1200px 0px' });
      for (const pv of this.pageViews) io.observe(pv.wrapper);
      this._lazyEditIO = io;
    } else {
      this.pageViews.slice(0, 8).forEach((pv) => paint(pv));     // no IO: just the first pages
    }
    // Search polls this to know box-building settled; on lazy docs it covers the painted window.
    this._textLayerComplete = true;
  },
  // Back-compat: existing call sites use renderCurrentPage() to mean "refresh overlays".
  renderCurrentPage() { return this.refresh(); },
  clearPageOverlays(pv) {
    pv.wrapper.querySelectorAll('.editable-text-box, .insert-overlay, .qpe-move-grip, .qpe-snap-guide').forEach(el => el.remove());
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
