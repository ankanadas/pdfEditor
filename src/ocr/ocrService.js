// OCR service — the main-thread pipeline that runs Tesseract.js OCR (off the main thread, inside
// Tesseract's own self-hosted worker) and turns its {text,bbox} payloads into an interactive text
// overlay. Mixed onto PDFEditorApp.prototype (OcrMethods); this = the app.
//
// Why main-thread createWorker (and not an app-owned nested worker): Tesseract.js v5 does not run
// cleanly *inside* another Web Worker (its own worker/core path resolution breaks in a nested/blob
// context — "importScripts … invalid URL"). The robust, supported pattern is to call createWorker from
// the main thread; Tesseract then spawns ITS worker (the self-hosted /assets/tesseract/worker.min.js)
// and every bit of OCR runs off the main thread in THAT worker. So the "OCR engine runs isolated off
// the main thread" requirement is met — worker.min.js IS the OCR execution worker; we just self-host
// and configure it (no CDN, so the app's CSP + offline both hold). The UMD lib is lazy-loaded (a
// <script> injected on the FIRST scanned page) so a text-PDF session never pays for it.
//
// Lifecycle (§2 on-demand): NEVER auto-OCRs the whole doc. ocrMaybePage(pv) is called from the lazy
// paint hook (createEditableTextBoxes, before its empty-page early-return) and OCRs a page ONLY if it
// is image-only / scanned (0 extractable text) and not already done/queued. One page at a time.
//
// Overlay (§3): each word's bbox is already in this canvas's pixel space (we OCR pv.canvas) = the SAME
// "canvas px" space extractedTextItems uses — so we push the words as ocr:true items and rebuild the
// page's text layer via the EXISTING engine. Flagged ocr:true, the boxes render TRANSPARENT over the
// scan (no cover strip) yet stay fully selectable / searchable / editable / draggable.

export const OcrMethods = {
  ocrInit() {
    if (this._ocr !== undefined) return this._ocr;
    this._ocr = { tw: null, libP: null, queue: [], busy: false, done: new Set(), pending: new Set(), curPv: null };
    return this._ocr;
  },

  /** Lazy-load the self-hosted Tesseract UMD lib (once). script-src 'self' → no CDN, no CSP change. */
  _ocrLoadLib() {
    const o = this._ocr;
    if (o.libP) return o.libP;
    o.libP = new Promise((resolve, reject) => {
      if (window.Tesseract) return resolve(window.Tesseract);
      const s = document.createElement('script');
      s.src = '/assets/tesseract/tesseract.min.js';
      s.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error('Tesseract global missing')));
      s.onerror = () => reject(new Error('failed to load /assets/tesseract/tesseract.min.js'));
      document.head.appendChild(s);
    });
    return o.libP;
  },

  async _ocrEnsureWorker() {
    const o = this._ocr;
    if (o.tw) return o.tw;
    const T = await this._ocrLoadLib();
    const base = '/assets/tesseract/';
    // oem 1 = LSTM_ONLY → matches the best_int LSTM traineddata + the SIMD-LSTM core (smallest fit).
    o.tw = await T.createWorker('eng', 1, {
      workerPath: base + 'worker.min.js',
      corePath: base,                 // dir; the worker appends tesseract-core-simd-lstm.wasm.js
      langPath: base,                 // dir; fetches eng.traineddata.gz (gzip handled), IndexedDB-cached
      logger: (m) => { if (m && m.status && o.curPv) this._ocrShowSpinner(o.curPv, this._ocrLabel(m.status), m.progress || 0); },
    });
    return o.tw;
  },

  /** Lazy hook: called when page `pv` paints. OCR it only if it's a scanned / image-only page. */
  ocrMaybePage(pv) {
    if (!pv || !pv.canvas) return;
    this.ocrInit();
    const pi = pv.pageNum, o = this._ocr;
    if (o.done.has(pi) || o.pending.has(pi)) return;
    if (!this._ocrIsImageOnly(pv)) return;
    o.pending.add(pi);
    o.queue.push(pi);
    this._ocrPump();
  },

  /** A scan / image-only page → OCR candidate. TOLERANT of trivial stray text: a real-world scan often
   *  carries a few characters of genuine text — a scanner-stamped page number, or a small edit a user
   *  added in THIS editor and saved (which bakes real text onto the scan). A strict zero-text gate made
   *  one leftover "5" permanently block OCR for the whole page. A page still counts as a scan when its
   *  real text is at most a few tiny fragments; anything more (a real text page) never OCRs. */
  _ocrIsImageOnly(pv) {
    const pi = pv.pageNum;
    const real = (this.extractedTextItems || []).filter((t) => t.pageIndex === pi && !t.ocr && (t.text || '').trim());
    if (real.length > 4 || real.reduce((n, t) => n + t.text.trim().length, 0) > 24) return false;
    const imgs = pv._pageImages;
    return !imgs || imgs.length > 0;   // has raster content (or unknown, before the ink pass) → OCR it
  },

  async _ocrPump() {
    const o = this._ocr;
    if (!o || o.busy || !o.queue.length) return;
    const pi = o.queue.shift();
    const pv = (this.pageViews || [])[pi];
    if (!pv || !pv.canvas) { o.pending.delete(pi); this._ocrPump(); return; }
    o.busy = true; o.curPv = pv;
    this._ocrShowSpinner(pv, 'Loading OCR…', 0);
    try {
      const tw = await this._ocrEnsureWorker();
      // Cap the pixels fed to Tesseract at ~2 MP (Lege-style): a poster-sized scan renders a 20 MP
      // canvas here — a huge PNG round-trip, ~3× slower recognition, and mobile memory pressure — while
      // LSTM accuracy saturates well below that. Downscale into an offscreen canvas and scale the
      // returned word boxes back up so the overlay still lands in pv.canvas pixel space.
      const MAX_PIXELS = 2_000_000;
      let src = pv.canvas, inv = 1;
      const px = pv.canvas.width * pv.canvas.height;
      if (px > MAX_PIXELS) {
        const s = Math.sqrt(MAX_PIXELS / px);
        const oc = document.createElement('canvas');
        oc.width = Math.max(1, Math.round(pv.canvas.width * s));
        oc.height = Math.max(1, Math.round(pv.canvas.height * s));
        oc.getContext('2d').drawImage(pv.canvas, 0, 0, oc.width, oc.height);
        src = oc; inv = pv.canvas.width / oc.width;
      }
      const dataUrl = src.toDataURL('image/png');
      const { data } = await tw.recognize(dataUrl);
      // Confidence gate: rotated banners / decorations / specks come back as junk words ("KZ" for a
      // diagonal "4th") at low confidence. They pollute search AND widen their line's bbox, so an
      // edit's background cover erases innocent neighbours. Keep words Tesseract is at least ~45%
      // sure about (real text is typically 80+; junk under 40); no confidence field → keep.
      const words = (data.words || []).filter((w) => w && w.text && w.text.trim() && w.bbox && !(typeof w.confidence === 'number' && w.confidence < 45))
        .map((w) => ({ text: w.text, bbox: inv === 1 ? w.bbox : { x0: w.bbox.x0 * inv, y0: w.bbox.y0 * inv, x1: w.bbox.x1 * inv, y1: w.bbox.y1 * inv } }));
      o.done.add(pi); o.pending.delete(pi);
      this._ocrHideSpinner(pv);
      this._ocrApplyOverlay(pv, words);
    } catch (e) {
      console.warn('[OCR] page', pi, 'failed:', e && e.message);
      o.pending.delete(pi);
      this._ocrHideSpinner(pv);
    } finally {
      o.busy = false; o.curPv = null;
      this._ocrPump();
    }
  },

  _ocrLabel(status) {
    if (/recogniz/i.test(status)) return 'Reading page…';
    if (/load|initial/i.test(status)) return 'Loading OCR…';
    return 'Reading page…';
  },

  // ---- spinner overlay (pure, non-blocking) ----
  _ocrShowSpinner(pv, label, progress) {
    if (!pv.wrapper) return;
    let el = pv.wrapper.querySelector('.ocr-spinner');
    if (!el) {
      el = document.createElement('div');
      el.className = 'ocr-spinner';
      el.innerHTML = '<span class="ocr-spin" aria-hidden="true"></span><span class="ocr-label"></span>';
      pv.wrapper.appendChild(el);
    }
    el.querySelector('.ocr-label').textContent = `${label} ${Math.round((progress || 0) * 100)}%`;
  },
  _ocrHideSpinner(pv) { const el = pv.wrapper && pv.wrapper.querySelector('.ocr-spinner'); if (el) el.remove(); },

  // ---- overlay: OCR words → ocr:true text items → the existing interactive text layer ----
  _ocrApplyOverlay(pv, words) {
    const pi = pv.pageNum;
    // The tolerant gate lets a scan carry a few REAL text fragments (a page number, a prior edit made
    // here). Tesseract re-reads those printed/drawn glyphs too — drop any OCR word whose box overlaps
    // a real item, so the page gets ONE editable box per word, not a duplicate ghost.
    const real = (this.extractedTextItems || []).filter((t) => t.pageIndex === pi && !t.ocr && (t.text || '').trim());
    const overlapsReal = (b) => real.some((t) => {
      const ox = Math.min(b.x1, t.right) - Math.max(b.x0, t.left);
      const oy = Math.min(b.y1, t.bottom) - Math.max(b.y0, t.top);
      return ox > 0 && oy > 0 && (ox * oy) > 0.4 * Math.max(1, (b.x1 - b.x0) * (b.y1 - b.y0));
    });
    const items = (words || [])
      .filter((w) => w && w.text && w.text.trim() && w.bbox && !overlapsReal(w.bbox))
      .map((w) => {
        const b = w.bbox, h = Math.max(1, b.y1 - b.y0);
        return {
          text: w.text, pageIndex: pi, ocr: true,
          left: b.x0, right: b.x1, top: b.y0, bottom: b.y1,
          baseline: b.y0 + h * 0.8,
          width: Math.max(1, b.x1 - b.x0), height: h, fontSizePx: h,
          fontName: 'sans-serif', bold: false, italic: false, serif: false,
          angle: 0, rotated: false,
        };
      });
    this.extractedTextItems = (this.extractedTextItems || []).filter((t) => !(t.pageIndex === pi && t.ocr));
    if (!items.length) return;
    this.extractedTextItems.push(...items);
    this._ocrRebuildLayer(pv);
  },

  /** Rebuild the page's interactive text layer through whatever the engine exposes. */
  _ocrRebuildLayer(pv) {
    // createEditableTextBoxes APPENDS boxes: clear THIS page's existing ones first (scoped to its
    // wrapper — never other pages), or a scan that carried a few real text items (the tolerant gate:
    // a page number, a previous edit) gets those items' boxes DUPLICATED by the rebuild.
    if (pv.wrapper) {
      pv.wrapper.querySelectorAll('.editable-text-box, .qpe-move-grip, .qpe-snap-guide').forEach((el) => el.remove());
      if (Array.isArray(this.editableTextBoxes)) {
        this.editableTextBoxes = this.editableTextBoxes.filter((bx) => {
          const el = bx && (bx.el || bx.div || bx);
          return !(el instanceof Element) || el.isConnected;
        });
      }
    }
    if (typeof this.createEditableTextBoxes === 'function') this.createEditableTextBoxes(pv);
    else if (typeof this.refresh === 'function') this.refresh({ only: pv.pageNum });
  },

  async ocrDispose() {
    const o = this._ocr;
    if (o && o.tw) { try { await o.tw.terminate(); } catch (_) {} }
    this._ocr = undefined;
  },
};
