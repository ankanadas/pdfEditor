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

import { binarizeForOcr } from '../util/binarize.js';
import { isPhoneDevice } from '../core/limits.js';
import { MupdfService } from '../services/mupdfService.js';
import { orderLinesForReading } from '../util/readingOrder.js';
import { buildDocumentText, isNoiseLine, cleanNoiseTokens } from '../util/textExport.js';
import { sampleLineColors } from '../util/canvas.js';
import { detectTableLines } from '../util/tableLines.js';

export const OcrMethods = {
  // NOTE: there is deliberately NO boot pre-warm. The OCR engine (worker + ~7 MB wasm core + language
  // pack) loads strictly ON DEMAND, the first time an image-only page is actually recognized
  // (_ocrEnsureWorker), so a text-PDF (or no-PDF) session never downloads any of it. The load is a
  // one-time cost for scan users and is cached (IndexedDB + service worker) for later sessions.
  ocrInit() {
    if (this._ocr !== undefined) return this._ocr;
    this._ocr = { tw: null, libP: null, queue: [], busy: false, done: new Set(), pending: new Set(), curPv: null, upgradeQueue: [] };
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

  /** Construct ONE tesseract worker. `withLogger` wires the progress spinner (used by the primary
   *  worker only — extra pool workers stay silent; a big page's progress is driven by tile COMPLETIONS
   *  in _ocrPump, and several loggers writing the same spinner would just fight each other). */
  async _ocrNewWorker(withLogger, lang) {
    const base = '/assets/tesseract/';
    const T = await this._ocrLoadLib();
    const opts = {
      workerPath: base + 'worker.min.js',
      corePath: base,                 // dir; the worker appends tesseract-core-simd-lstm.wasm.js
      langPath: base,                 // dir; fetches eng.traineddata.gz (gzip handled), IndexedDB-cached
    };
    if (withLogger) {
      const o = this._ocr;
      opts.logger = (m) => {
        if (!(m && m.status && o.curPv)) return;
        // A TILED page's progress is driven by tile completions (_ocrPump) — ignore the raw per-tile
        // logger there (it resets to 0 every tile and, with a worker pool, several fire at once).
        if (o.tileProg && o.tileProg.total > 1) return;
        this._ocrShowSpinner(o.curPv, this._ocrLabel(m.status), m.progress || 0);
      };
    }
    // oem 1 = LSTM_ONLY → matches the best_int LSTM traineddata + the SIMD-LSTM core (smallest fit).
    // NOTE: page-segmentation mode (PSM) is set PER RECOGNITION (see _ocrRecognize), not here — a normal
    // doc scan wants the full layout analysis (PSM 3) for accuracy, while a big noisy MAP tile wants
    // sparse mode (PSM 11) for speed. Setting it globally here regressed doc-scan accuracy.
    // `lang` defaults to eng; 'hin' (or others) fetches that traineddata for a legacy/non-English page.
    return T.createWorker(lang || 'eng', 1, opts);
  },

  /** Recognise one image with an explicit PSM. PSM 3 (AUTO, full layout analysis) = accurate on a normal
   *  document scan — recovers logo/heading text and groups lines properly. PSM 11 (SPARSE_TEXT) skips
   *  layout analysis so a dense MAP tile isn't pathologically slow; we rebuild lines/reading-order
   *  ourselves so nothing is lost there but wall-clock. Set per-call so a warm worker reused across a
   *  tiled page then a plain page never carries the wrong mode. */
  async _ocrRecognize(worker, image, psm) {
    // PER-WORKER MUTEX: setParameters(psm) then recognize must be ATOMIC on a worker — a worker holds ONE
    // page-seg mode. Two flows sharing a worker (the background searchability upgrade + a "Save as Readable",
    // or a direct readable pass) would otherwise interleave as setParams(6)/setParams(3)/recognize/recognize
    // and read a page with the WRONG PSM. Chained per worker, so different POOL workers still run in parallel.
    const prev = worker.__recLock || Promise.resolve();
    let release; worker.__recLock = new Promise((r) => { release = r; });
    await prev.catch(() => {});
    try {
      try { await worker.setParameters({ tessedit_pageseg_mode: String(psm) }); } catch (_) {}
      return await worker.recognize(image);
    } finally { release(); }
  },

  // ── Phase 5: MULTI-LANGUAGE scan OCR ─────────────────────────────────────────────────────────────────
  /** The English pass read this page with LOW mean confidence — it may be the wrong script. (A "few Latin
   *  words" test is unreliable: English OCR of Devanagari coins Latin-LOOKING garbage like "TINT"/"ASTUTE".)
   *  Low confidence is the robust trigger; the detection below only SWITCHES when a candidate BEATS English,
   *  so a merely-blurry English page harmlessly stays English. */
  _ocrLooksNonLatin(words) {
    if (!words || words.length < 3) return false;
    const cs = words.map((w) => w.conf).filter((c) => typeof c === 'number');
    const meanConf = cs.length ? cs.reduce((a, b) => a + b, 0) / cs.length : 100;
    return meanConf < 50;
  },

  /** Detect a non-English scan's language by re-recognising a small DOWNSCALED copy with English AND each
   *  candidate script's traineddata (lazy), keeping the best mean confidence. Returns the winning NON-English
   *  language (hin/ara/chi_sim) only when it clearly reads better than English (conf ≥ 55 and highest); else
   *  null → stay English. One cheap pass per language, detection-only. */
  async _ocrDetectLang(src) {
    const cap = 1200000, px = src.width * src.height;
    let img = src;
    if (px > cap) {
      const s = Math.sqrt(cap / px);
      const c = document.createElement('canvas'); c.width = Math.max(8, Math.round(src.width * s)); c.height = Math.max(8, Math.round(src.height * s));
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height); img = c;
    }
    let best = { lang: 'eng', conf: -1 };
    for (const lang of ['eng', 'hin', 'ara', 'chi_sim']) {
      try {
        const w = await this._ocrEnsureWorker(lang);
        const { data } = await this._ocrRecognize(w, img, 6);   // PSM 6 = a uniform text block
        const conf = typeof data.confidence === 'number' ? data.confidence : 0;
        if (conf > best.conf) best = { lang, conf };
      } catch (_) {}
    }
    return (best.lang !== 'eng' && best.conf >= 55) ? best.lang : null;
  },

  async _ocrEnsureWorker(lang) {
    const o = this._ocr;
    // ENGLISH (default) — the primary worker `o.tw`, shared with the tile pool. Unchanged.
    if (!lang || lang === 'eng') {
      if (o.tw) return o.tw;
      // Cache the in-flight PROMISE, not just the result: several pages (or the pump + a searchable pass)
      // can call this before the first worker resolves, and without this each would spawn its OWN worker
      // → duplicate ~7 MB core + traineddata downloads and memory. One worker, shared.
      if (o.twPromise) return o.twPromise;
      o.twPromise = this._ocrNewWorker(true, 'eng').then((tw) => { o.tw = tw; return tw; });
      o.twPromise.catch(() => { o.twPromise = null; });   // a failed load can be retried on the next scan
      return o.twPromise;
    }
    // OTHER LANGUAGE (e.g. 'hin' for a legacy Devanagari page) — its own cached worker, single-shot use.
    o.langW = o.langW || {}; o.langWP = o.langWP || {};
    if (o.langW[lang]) return o.langW[lang];
    if (o.langWP[lang]) return o.langWP[lang];
    o.langWP[lang] = this._ocrNewWorker(true, lang).then((tw) => { o.langW[lang] = tw; return tw; });
    o.langWP[lang].catch(() => { o.langWP[lang] = null; });
    return o.langWP[lang];
  },

  /** A POOL of `n` workers for parallel TILE recognition on a big scan (a 20 MP poster is 12 serial
   *  tiles ≈ 68 s on one worker; N workers cut that ~N×). Desktop only — phones/iPad keep n=1 (each
   *  worker holds a ~100 MB wasm heap; the extra copies would OOM a tablet). The primary worker is
   *  reused as pool member 0; extras load from the now-warm core/traineddata cache. Built once and
   *  reused within a document; torn down in ocrResetForNewDoc. */
  async _ocrEnsurePool(n) {
    const o = this._ocr;
    const first = await this._ocrEnsureWorker();
    if (n <= 1) return [first];
    if (!o.pool) o.pool = [first];
    if (o.pool.length >= n) return o.pool.slice(0, n);
    if (!o.poolPromise) {
      o.poolPromise = (async () => {
        const need = [];
        for (let i = o.pool.length; i < n; i++) need.push(this._ocrNewWorker(false));
        const extra = await Promise.all(need);   // parallel: extras share the warm core cache
        o.pool.push(...extra);
        return o.pool;
      })();
      o.poolPromise.catch(() => { o.poolPromise = null; });
    }
    try { return await o.poolPromise; } catch (_) { return [first]; }   // any failure → just use worker 0
  },

  /** Terminate the EXTRA pool workers, keeping the primary alive. Frees ~100 MB per extra worker once a
   *  big scan is done / a new doc opens, without paying to re-create the always-on primary. */
  _ocrTeardownPool() {
    const o = this._ocr;
    if (!o || !o.pool) return;
    for (const w of o.pool) { if (w && w !== o.tw) { try { w.terminate(); } catch (_) {} } }
    o.pool = null; o.poolPromise = null;
  },

  /** Lazy hook: called when page `pv` paints. OCR it only if it's a scanned / image-only page. */
  ocrMaybePage(pv) {
    if (!pv || !pv.canvas) return;
    this.ocrInit();
    const pi = pv.pageNum, o = this._ocr;
    // A full-page SCAN carrying a JUNK embedded OCR text layer → drop that garbage text and OCR the page
    // fresh (clean boxes + the readable option). Deferred rebuild avoids re-entering the box builder that
    // called us; the OCR overlay then replaces the (now removed) misaligned boxes when recognition lands.
    if (!o.done.has(pi) && !o.pending.has(pi) && this._ocrScanWithJunkText(pv)) {
      const before = (this.extractedTextItems || []).length;
      this.extractedTextItems = (this.extractedTextItems || []).filter((t) => !(t.pageIndex === pi && !t.ocr));
      if ((this.extractedTextItems || []).length !== before) {
        console.info('[OCR] scanned page with a junk text layer → dropping it and OCR-ing fresh (page', pi, ')');
        // Tell the box builder that called us to ABORT this pass (before it paints cover strips over the
        // scan / builds the misaligned boxes) — OCR will lay down clean, aligned boxes when it lands.
        pv._ocrJunkScanDropped = true;
      }
    }
    // Reveal the Searchable UI EARLY once this is a CONFIRMED scan — raster images present AND minimal
    // real text. This fires even on the re-check after the page is already queued (textEditing calls us
    // again once pv._pageImages is known), so a big poster asks "make searchable?" UP FRONT instead of
    // after ~1 minute of recognition. A blank page (no images) or a sparse TEXT page never reaches here;
    // the speculative imgs-unknown/empty path stays silent until _ocrApplyOverlay confirms real words.
    if (pv._pageImages && pv._pageImages.length && this._ocrIsImageOnly(pv)) this._ocrRevealTextExport();
    if (o.done.has(pi) || o.pending.has(pi)) return;
    if (!this._ocrIsImageOnly(pv)) return;
    o.pending.add(pi);
    o.queue.push(pi);
    this._ocrPump();
  },

  /** LEGACY non-Unicode Devanagari page (Kruti/APS/DevLys — the font DRAWS correct Hindi but the text
   *  extracts as accented-Latin garbage). Called by the box builder when isLegacyGarbledPage fires. The page
   *  renders crisp vector Devanagari, so we OCR that RENDER with HINDI → the text becomes correct, selectable,
   *  copyable, EDITABLE Unicode (Phase 4) — general across legacy fonts (no per-font remap table needed). The
   *  garbage text layer is dropped so the OCR'd Unicode replaces it; the page stays VIEW-ONLY until OCR lands. */
  ocrMaybePageLegacy(pv) {
    if (!pv || !pv.canvas) return;
    this.ocrInit();
    const pi = pv.pageNum, o = this._ocr;
    if (o.done.has(pi) || o.pending.has(pi)) return;
    pv._ocrLang = 'hin';
    this.extractedTextItems = (this.extractedTextItems || []).filter((t) => !(t.pageIndex === pi && !t.ocr));
    o.pending.add(pi);
    o.queue.push(pi);
    this._ocrPump();
  },

  /** Reset per-DOCUMENT OCR state when a new PDF is opened — WITHOUT tearing down the warm worker.
   *  Fixes: a second scanned upload never OCR'd because the previous doc's page indices lingered in
   *  `done`; and the Searchable/Text-export UI stayed visible on the next (possibly non-scanned) doc.
   *  Called from the file-open path (guarded there). */
  ocrResetForNewDoc() {
    const o = this._ocr;
    if (o) {
      o.queue.length = 0; o.pending.clear(); o.done.clear();
      if (o.upgradeQueue) o.upgradeQueue.length = 0;
      // If a background upgrade currently HOLDS the worker, leave busy set so the new doc's OCR waits for it
      // to drain (it self-cancels via the gen check) rather than racing it on the shared worker's PSM.
      if (!o.upgrading) o.busy = false;
      o.curPv = null; o.tileProg = null;
    }
    // Bump the doc generation so a background searchability upgrade that is MID-FLIGHT (its region re-OCR
    // takes seconds) from the previous document does not apply its result — and re-reveal the OCR UI /
    // leak stale OCR items — onto the newly-opened doc. _ocrUpgradeSearchable re-checks this after awaiting.
    this._ocrGen = (this._ocrGen || 0) + 1;
    this._ocrReadableCache = null;
    this._ocrTeardownPool();   // free the extra parallel-tile workers held from the previous doc
    this.extractedTextItems = (this.extractedTextItems || []).filter((t) => !t.ocr);   // drop stale OCR items
    const ex = document.getElementById('textExportWrap'); if (ex) ex.hidden = true;
  },

  /** No-op (kept for the overlay/apply/save callers). The readable-PDF option is no longer a persistent
   *  top button — on a scanned/OCR'd doc, clicking Save opens a choice dialog ("Save as Readable PDF" —
   *  the default/highlighted — vs "Save Original PDF"); see app.js. Searchable text is still always baked
   *  into a normal save automatically (saveService). */
  _ocrRevealTextExport() {},

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
    // A page that carries SOME (sparse) real text is a scan only when raster content is CONFIRMED. The
    // ink/image pass runs AFTER the first ocrMaybePage() call (createEditableTextBoxes hits us before
    // pv._pageImages is set), so treating "images unknown" as a scan here false-flags a genuinely
    // sparse text page — a divider or a one-phrase page like "AAA-PAGE" — as scanned, popping the OCR /
    // searchable dialog (whose backdrop then blocks every click). textEditing re-checks us once
    // pv._pageImages IS known, so a real scan with a few stray chars (a stamped page number) still OCRs.
    if (real.length > 0) return !!(imgs && imgs.length > 0);
    // NO extractable text at all → a scan candidate even before the image pass (imgs unknown): the
    // empty-page early-return in createEditableTextBoxes would otherwise skip its only OCR trigger.
    return !imgs || imgs.length > 0;
  },

  /** A "searchable SCAN carrying a JUNK embedded OCR text layer" (e.g. a scanned SSA-89): the visible page
   *  is a full-page raster scan, but it ships an INVISIBLE, low-quality OCR text layer whose boxes are
   *  misaligned with the printed ink. Without this the app treats it as a text document — rendering those
   *  garbage boxes doubled over the scan and hiding "Save as readable PDF". Detected so we DROP that junk
   *  text and OCR the page fresh (clean, aligned boxes + the readable option), like any other scan.
   *  Conservative gate (dropping real text is consequential): a near-FULL-page image (a genuine scan, not
   *  a doc with one big figure) AND a substantial text layer. A normal text page (no full-page image) and
   *  an already-image-only scan (little/no native text) both fall through unchanged. */
  _ocrScanWithJunkText(pv) {
    if (!pv || !pv.canvas) return false;
    const s = this.scale || 1;
    const area = pv.canvas.width * pv.canvas.height;
    if (area <= 0) return false;
    const imgs = pv._pageImages || [];
    const fullPageScan = imgs.some((im) => ((im.x1 - im.x0) * s) * ((im.y1 - im.y0) * s) > 0.75 * area);
    if (!fullPageScan) return false;
    const real = (this.extractedTextItems || []).filter((t) => t.pageIndex === pv.pageNum && !t.ocr && (t.text || '').trim());
    if (real.length < 25) return false;
    // JUNK discriminator (so a GOOD searchable scan keeps its embedded text instead of being re-OCR'd):
    // a scrambled OCR layer jumps around out of reading order — consecutive items leap UP by more than a
    // line-height often. A clean/native text layer flows in order. Measured: junk scan ≈ 44%, good scans
    // & normal docs ≤ 2%. Items are in the PDF's content order (as PDF.js extracted them).
    return this._ocrLayerScramble(real) > 0.20;
  },

  /** Fraction of consecutive text items (content order) that jump UP by > ~1 line-height — a reading-order
   *  violation. High on a scrambled OCR text layer; ~0 on a clean/native one. */
  _ocrLayerScramble(items) {
    if (!items || items.length < 10) return 0;
    const hs = items.map((t) => t.bottom - t.top).filter((h) => h > 0).sort((a, b) => a - b);
    const med = hs[hs.length >> 1] || 1;
    let viol = 0;
    for (let i = 0; i < items.length - 1; i++) {
      const dy = (items[i + 1].top + items[i + 1].bottom) / 2 - (items[i].top + items[i].bottom) / 2;
      if (dy < -med * 1.3) viol++;
    }
    return viol / (items.length - 1);
  },

  async _ocrPump() {
    const o = this._ocr;
    if (!o || o.busy) return;
    if (!o.queue.length) {
      // Recognition queue drained → the shared worker is free. Run one pending SEARCHABILITY UPGRADE (the
      // accurate region-bounded re-OCR that makes the editor's Search match the readable save). Strictly one
      // at a time and NEVER concurrent with a recognition — both flip the worker's PSM, so overlapping them
      // corrupts a page's result. A newly-queued recognition always pre-empts (queue is checked first).
      if (o.upgradeQueue && o.upgradeQueue.length) {
        const upi = o.upgradeQueue.shift();
        const upv = (this.pageViews || [])[upi];
        o.busy = true; o.upgrading = true;        // hold the worker; a doc-reset lets this DRAIN, not race
        try { if (upv && upv.canvas) await this._ocrUpgradeSearchable(upv); } catch (_) {}
        o.busy = false; o.upgrading = false; o.curPv = null;
        this._ocrPump();
        return;
      }
      this._ocrTeardownPool(); return;   // queue drained → free the extra pool workers
    }
    const pi = o.queue.shift();
    const pv = (this.pageViews || [])[pi];
    if (!pv || !pv.canvas) { o.pending.delete(pi); this._ocrPump(); return; }
    o.busy = true; o.curPv = pv;
    this._ocrShowSpinner(pv, 'Loading OCR…', 0);
    try {
      const lang = pv._ocrLang || 'eng';          // 'hin' for a legacy Devanagari page (see ocrMaybePage)
      const tw = await this._ocrEnsureWorker(lang);
      // TILED recognition (Lege-style region fan-out): a canvas bigger than one tile is recognised as a
      // grid of tiles (overlapped so no word is cut at a seam; seam-touching words dropped — the
      // neighbouring tile sees them whole; the overlap zone deduped by IoU), the tiles fanned across a
      // worker pool in parallel. Small pages keep the single-shot path.
      const OVERLAP = 64, EDGE = 8;
      // Cap OCR resolution. A 20 MP scan's NOISE (map lines / speckle) costs Tesseract SUPERLINEAR time
      // — a single dense map tile took ~14 s. Above MAX_OCR_PX we recognise a DOWNSCALED copy: modest
      // enough that notice / body text stays legible, but it collapses the pathological map-tile cost.
      // The old flat 2 MP cap was far too aggressive (12pt table text fell under Tesseract's floor); a
      // ~13 MP cap keeps ~85 DPI. Word boxes are scaled back to canvas space (×1/ocrScale) before overlay.
      const MAX_OCR_PX = isPhoneDevice() ? 6_000_000 : 13_000_000;
      const rawPx = pv.canvas.width * pv.canvas.height;
      let src = pv.canvas, ocrScale = 1;
      if (rawPx > MAX_OCR_PX) {
        ocrScale = Math.sqrt(MAX_OCR_PX / rawPx);
        src = document.createElement('canvas');
        src.width = Math.max(1, Math.round(pv.canvas.width * ocrScale));
        src.height = Math.max(1, Math.round(pv.canvas.height * ocrScale));
        src.getContext('2d').drawImage(pv.canvas, 0, 0, src.width, src.height);
      }
      const W = src.width, H = src.height, px = W * H;
      // Parallel tile pool: use most cores on desktop (each worker holds a ~100 MB wasm heap, so a
      // phone/iPad stays at 1). Below SINGLE_MAX a page is one-shot; above it, a grid of ≤ MAX_TILE
      // tiles recognised in parallel — aim for ~one tile PER WORKER so it's a SINGLE parallel round.
      const POOL_N = isPhoneDevice() ? 1 : Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4));
      const MAX_TILE = isPhoneDevice() ? 1_600_000 : 4_000_000;
      const SINGLE_MAX = isPhoneDevice() ? 1_600_000 : 2_600_000;
      // Confidence gate: rotated banners / decorations / specks come back as junk words ("KZ" for a
      // diagonal "4th") — Tesseract scores them low. Keep words it's ≥45% sure about. BUT also keep a
      // LOW-confidence word that is clearly WORD-LIKE (≥4 letters, almost all alphabetic): a stylised
      // LOGO ("O'REILLY") scores 0 yet is real text the user wants to select/search. The specks the gate
      // drops are short (1–3 chars) or symbols, so requiring ≥4 letters keeps them out.
      const keepWord = (w) => {
        const conf = typeof w.confidence === 'number' ? w.confidence : 100;
        if (conf >= 45) return true;
        // ≥4 letters AND mostly letters (≥60%) — recovers a stylised logo ("O'REILLY") or a slash/space
        // separated caps run ("/THEORY/IN/PRACTICE") that Tesseract scores 0, while still dropping the
        // 1–3 char specks / lone symbols the confidence gate exists to remove.
        const letters = (w.text.match(/[A-Za-z]/g) || []).length;
        return letters >= 4 && letters >= w.text.trim().length * 0.6;
      };
      const collect = (data, ox, oy) => (data.words || [])
        .filter((w) => w && w.text && w.text.trim() && w.bbox && keepWord(w))
        .map((w) => ({ text: w.text, conf: typeof w.confidence === 'number' ? w.confidence : 100,
          bbox: { x0: w.bbox.x0 + ox, y0: w.bbox.y0 + oy, x1: w.bbox.x1 + ox, y1: w.bbox.y1 + oy } }));
      let words = [];
      // A non-English page (legacy → 'hin') uses its own single worker, so keep it SINGLE-SHOT — the tile
      // pool is the English primary. A rendered legacy book page is crisp + letter-sized, so no tiling need.
      if (lang !== 'eng' || px <= SINGLE_MAX * 1.25) {
        // Binarization pre-pass (Otsu): a DIRTY document scan reads far better as crisp black-on-
        // white. Gated inside binarizeForOcr — photos and already-crisp scans pass through untouched.
        const bin = binarizeForOcr(src);
        o.lastBin = { page: pi, applied: bin.applied, threshold: bin.stats && bin.stats.threshold };   // test observability
        const { data } = await this._ocrRecognize(tw, bin.applied ? bin.canvas : src, 3);   // PSM 3 (layout) — accurate doc scan; canvas direct (no PNG)
        words = collect(data, 0, 0);
      } else {
        // Grid sized to ~POOL_N tiles (one parallel round) while each stays ≤ MAX_TILE. Cols/rows from
        // the page aspect so tiles are squareish rather than thin slivers.
        let cols = Math.max(1, Math.round(Math.sqrt(POOL_N * W / H)));
        let rows = Math.max(1, Math.ceil(POOL_N / cols));
        while ((W / cols) * (H / rows) > MAX_TILE) { if (W / cols >= H / rows) cols++; else rows++; }
        const tileW = Math.ceil(W / cols), tileH = Math.ceil(H / rows);
        const total = cols * rows;
        o.lastTiles = { page: pi, tiles: total };                                                     // test observability
        // Tile geometry list — workers pull from it in parallel.
        const jobs = [];
        for (let ry = 0; ry < rows; ry++) {
          for (let cx = 0; cx < cols; cx++) {
            jobs.push({
              x0: Math.max(0, cx * tileW - OVERLAP), y0: Math.max(0, ry * tileH - OVERLAP),
              x1: Math.min(W, (cx + 1) * tileW + OVERLAP), y1: Math.min(H, (ry + 1) * tileH + OVERLAP),
            });
          }
        }
        // PARALLEL tiles across the worker POOL — the big win on a poster scan (12 serial tiles ≈ 68 s →
        // one round of ~POOL_N). Each tile crops to its OWN canvas (a shared scratch canvas can't be
        // recognised concurrently). next++/done++/push are safe: JS is single-threaded, so they never
        // interleave mid-statement — only the recognises overlap.
        const pool = await this._ocrEnsurePool(Math.min(POOL_N, total));
        let next = 0, done = 0;
        o.tileProg = { done: 0, total };                                   // progress = completed tiles / total
        this._ocrShowSpinner(pv, `Reading page… (0/${total})`, 0);
        const runWorker = async (worker) => {
          for (let idx = next++; idx < jobs.length; idx = next++) {
            const j = jobs[idx];
            const tc = document.createElement('canvas');
            tc.width = j.x1 - j.x0; tc.height = j.y1 - j.y0;
            tc.getContext('2d').drawImage(src, j.x0, j.y0, tc.width, tc.height, 0, 0, tc.width, tc.height);
            const bin = binarizeForOcr(tc);
            if (idx === 0) o.lastBin = { page: pi, applied: bin.applied, threshold: bin.stats && bin.stats.threshold };
            const { data } = await this._ocrRecognize(worker, bin.applied ? bin.canvas : tc, 11);   // PSM 11 (sparse) — fast on a big noisy tile; canvas direct (no PNG)
            // Drop words touching an INNER tile edge (not a page edge): they may be cut mid-word here
            // and the neighbouring tile's overlap sees them whole.
            const inner = collect(data, j.x0, j.y0).filter((wd) => {
              const b = wd.bbox;
              if (j.x0 > 0 && b.x0 - j.x0 < EDGE) return false;
              if (j.y0 > 0 && b.y0 - j.y0 < EDGE) return false;
              if (j.x1 < W && j.x1 - b.x1 < EDGE) return false;
              if (j.y1 < H && j.y1 - b.y1 < EDGE) return false;
              return true;
            });
            words.push(...inner);
            done++;
            o.tileProg = { done, total };
            this._ocrShowSpinner(pv, `Reading page… (${done}/${total})`, done / total);
          }
        };
        await Promise.all(pool.map((w) => runWorker(w)));
        // Dedupe the overlap zones: same text + IoU > 0.5 → keep the higher-confidence copy.
        const iou = (a, b) => {
          const ix = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
          const iy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
          if (ix <= 0 || iy <= 0) return 0;
          const inter = ix * iy;
          const ua = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
          return ua > 0 ? inter / ua : 0;
        };
        words.sort((p, q) => q.conf - p.conf);
        const kept = [];
        for (const wd of words) {
          if (!kept.some((k) => k.text.trim() === wd.text.trim() && iou(k.bbox, wd.bbox) > 0.5)) kept.push(wd);
        }
        words = kept;
      }
      // Map word boxes from the (possibly downscaled) OCR space back to canvas space for the overlay.
      if (ocrScale !== 1) {
        const s = 1 / ocrScale;
        words = words.map((w) => ({ text: w.text, conf: w.conf, bbox: {
          x0: w.bbox.x0 * s, y0: w.bbox.y0 * s, x1: w.bbox.x1 * s, y1: w.bbox.y1 * s } }));
      }
      o.tileProg = null;
      // Phase 5 — MULTI-LANGUAGE scan: English read this page as NON-LATIN garbage → detect the script's
      // language and RE-OCR the page with it. Only a fresh English scan (not the legacy 'hin' path, not
      // already tried). Re-queues the page; the finally pumps it again with the detected language.
      if (lang === 'eng' && !pv._ocrLangTried && this._ocrLooksNonLatin(words)) {
        pv._ocrLangTried = true;
        const detected = await this._ocrDetectLang(src);
        if (detected && detected !== 'eng') {
          pv._ocrLang = detected;
          o.queue.unshift(pi);            // re-recognise this page (still pending) with `detected`
          this._ocrHideSpinner(pv);
          return;
        }
      }
      o.done.add(pi); o.pending.delete(pi);
      this._ocrHideSpinner(pv);
      this._ocrApplyOverlay(pv, words);
      // Queue the background searchability upgrade (skip phones — the region upscale is memory-heavy there,
      // and the fast overlay + "Save as Readable" already cover them). Runs when the recognise queue idles.
      // ONLY for English pages: the readable pass re-OCRs with the ENGLISH worker (its region seeding /
      // PSM 6-7 tuning is English-specific), so on a page recognised in another language (a legacy Hindi
      // page, or a Phase-5 detected-language scan) it reads Devanagari/CJK as sparse Latin garbage and
      // _ocrApplyOverlay would REPLACE the good non-Latin items with it — gutting the page's editable text.
      const engPage = !pv._ocrLang || pv._ocrLang === 'eng';
      if (engPage && !isPhoneDevice() && words && words.length && !pv._ocrUpgraded && o.upgradeQueue && !o.upgradeQueue.includes(pi)) o.upgradeQueue.push(pi);
    } catch (e) {
      console.warn('[OCR] page', pi, 'failed:', e && e.message);
      o.tileProg = null;
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

  // ---- spinner + progress shimmer overlay (pure, non-blocking) ----
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
    // Progressive feedback (perf spec §3): tesseract's native progress callback (0..1, via the worker
    // logger) drives a soft shimmer veil over the page — the user SEES recognition sweeping the scan
    // instead of a frozen page. Pure CSS translate/opacity: no layout, no canvas writes.
    let sh = pv.wrapper.querySelector('.ocr-shimmer');
    if (!sh) {
      sh = document.createElement('div');
      sh.className = 'ocr-shimmer';
      sh.innerHTML = '<span class="ocr-shimmer-bar" aria-hidden="true"></span>';
      pv.wrapper.appendChild(sh);
    }
    const p = Math.max(0, Math.min(1, progress || 0));
    sh.style.opacity = String(0.9 - p * 0.55);                     // veil fades as recognition completes
    sh.querySelector('.ocr-shimmer-bar').style.top = `${Math.round(p * 92)}%`;   // sweep tracks progress
  },
  _ocrHideSpinner(pv) {
    if (!pv.wrapper) return;
    pv.wrapper.querySelectorAll('.ocr-spinner, .ocr-shimmer').forEach((el) => el.remove());
  },

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
          text: w.text, pageIndex: pi, ocr: true, ocrConf: (typeof w.conf === 'number' ? w.conf : 100),
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
    this._ocrRevealTextExport();   // recognised words exist → surface the Download-text buttons
    this._ocrRebuildLayer(pv);
  },

  /**
   * Background SEARCHABILITY UPGRADE: re-read a scanned page with the accurate region-bounded pass (upscaled,
   * PSM-6/7, gap-filled) and swap the fast full-page overlay for it, so the editor's Search / selection finds
   * the small text the quick pass missed (a table header like "Place of Employment", an address row) — making
   * the editor consistent with "Save as Readable". Runs on the idle OCR worker via _ocrPump, one page at a
   * time. Cached so ocrSaveReadable reuses it instead of paying the ~seconds cost a second time.
   */
  async _ocrUpgradeSearchable(pv) {
    if (!pv || pv._ocrUpgraded || !pv.canvas) return;
    // Never upgrade a non-English page: the readable pass uses the ENGLISH worker and would replace this
    // page's good Devanagari/CJK OCR with Latin garbage (belt-and-suspenders — the queue push is gated too).
    if (pv._ocrLang && pv._ocrLang !== 'eng') return;
    pv._ocrUpgraded = true;                       // once per page — never loops even if it yields nothing
    // Don't yank the layer out from under an OPEN editor (would drop the user's focus / in-flight text).
    if (pv.wrapper && pv.wrapper.querySelector('.editable-text-box:focus-within, .editable-text-box.editing')) return;
    const gen = this._ocrGen || 0;                // the doc this upgrade belongs to
    let tw; try { tw = await this._ocrEnsureWorker(); } catch (_) { return; }
    let words; try { words = await this._ocrReadablePass(pv, tw); } catch (_) { return; }
    if (!words || !words.length) return;
    // The re-OCR took seconds — bail if the user has since opened another document (stale result must not
    // leak OCR items / re-reveal the OCR UI onto it) or has started editing this page.
    if ((this._ocrGen || 0) !== gen || !(this.pageViews || []).includes(pv)) return;
    if (pv.wrapper && pv.wrapper.querySelector('.editable-text-box:focus-within, .editable-text-box.editing')) return;
    (this._ocrReadableCache || (this._ocrReadableCache = {}))[pv.pageNum] = { words, scale: this.scale || 1, w: pv.canvas.width, h: pv.canvas.height };
    this._ocrApplyOverlay(pv, words);             // replaces this page's OCR items → Search now finds them
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

  /**
   * Recognize EVERY image-only page (not just the ones scrolled into view) — the "Save as searchable"
   * pass. Hydrates lazy pages through the same painter Search uses, then rides the normal one-at-a-
   * time OCR queue. onProgress(done, total) drives the progress overlay.
   */
  async ocrRecognizeAllPages(onProgress) {
    this.ocrInit();
    const o = this._ocr;
    const targets = [];
    for (const pv of this.pageViews || []) {
      if (!pv) continue;
      if (!pv.canvas || (!pv._lePainted && this._lePaint && this.lazyEditMode)) {
        try { await this._lePaint(pv); } catch (_) {}
      }
      if (pv.canvas && this._ocrIsImageOnly(pv) && !o.done.has(pv.pageNum)) targets.push(pv);
    }
    let done = 0;
    if (onProgress) onProgress(done, targets.length);
    for (const pv of targets) {
      this.ocrMaybePage(pv);
      // the pump is serial — wait for THIS page to finish (or fail out of pending)
      await new Promise((resolve) => {
        const tick = () => ((o.done.has(pv.pageNum) || !o.pending.has(pv.pageNum)) ? resolve() : setTimeout(tick, 150));
        tick();
      });
      done++;
      if (onProgress) onProgress(done, targets.length);
    }
  },

  /**
   * "Save as searchable PDF" (opt-in): bake every recognised word into `bytes` as an INVISIBLE text
   * run (render mode 3) at its printed position — the scan looks pixel-identical but becomes
   * selectable / searchable / copyable / indexable in ANY viewer. Reuses the mupdf insert path
   * (fonts, encoding, sanitising) via synthetic insert edits carrying `invisible: true`.
   * Returns the new bytes, or null when there is nothing to bake / the tier is unavailable.
   */
  async ocrBakeSearchable(bytes) {
    if (!MupdfService.isSupported()) return null;
    const overlay = this._ocrProgressOverlay('Making the PDF searchable…');
    try {
      await this.ocrRecognizeAllPages((d, t) => overlay.set(`Reading page ${Math.min(d + 1, t)} of ${t}…`));
      const s = this.scale || 1;
      const edits = [];
      for (const it of this.extractedTextItems || []) {
        if (!it.ocr || !(it.text || '').trim()) continue;
        // words the user EDITED are already baked visibly by the edit path — don't double them
        const consumed = (this.edits || []).some((e) => e.pageIndex === it.pageIndex && e.redact !== false &&
          Math.min(e.right * s, it.right) - Math.max(e.x * s, it.left) > 0 &&
          Math.min(e.bottom * s, it.bottom) - Math.max(e.top * s, it.top) > 0);
        if (consumed) continue;
        edits.push({
          redact: false, invisible: true, pageIndex: it.pageIndex,
          x: it.left / s, baseline: it.baseline / s, top: it.top / s, bottom: it.bottom / s,
          right: it.right / s, fontSize: Math.max(4, (it.height / s) * 0.85),
          newText: it.text,
        });
      }
      if (!edits.length) return null;
      overlay.set('Embedding the text layer…');
      return await MupdfService.editPDF(bytes, edits, []);
    } catch (e) {
      console.warn('searchable-PDF bake failed (saving the plain file instead):', e && e.message);
      return null;
    } finally {
      overlay.remove();
    }
  },

  /** Hard local contrast stretch on a crop before re-OCR: push near-white to pure white and near-black
   *  to pure black, leave mid-tones. This WHITENS OUT scanner gradients / edge shadows (which degrade a
   *  faint header/footer page number to below Tesseract's detection floor) and crisps character edges, so
   *  an isolated text strip reads far more accurately than the same pixels inside the noisy full page.
   *  `hi`/`lo` are per-channel-sum-over-3 (0..255) cutoffs; margins use a MORE aggressive whiten. */
  _ocrContrastBoost(canvas, opts = {}) {
    // Hard contrast CLIP: push near-white to pure white and near-black to pure black, leave mid-tones. On
    // this scan a clip beat a linear stretch (88 % vs 85 % recall) — the stretch greyed the paper enough to
    // cost more than it recovered. It WHITENS scanner gradients / edge shadows (which drop a faint header
    // /footer page number below Tesseract's floor) and crisps edges, so a bounded strip reads far cleaner
    // than the same pixels in the noisy full page. Margins pass a narrow, aggressive [lo,hi] to wipe shadow.
    const hi = opts.hi != null ? opts.hi : 172, lo = opts.lo != null ? opts.lo : 108;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let im;
    try { im = ctx.getImageData(0, 0, canvas.width, canvas.height); } catch (_) { return canvas; }
    const d = im.data;
    for (let i = 0; i < d.length; i += 4) {
      const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
      const v = l > hi ? 255 : (l < lo ? 0 : l);
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(im, 0, 0);
    return canvas;
  },

  /**
   * Estimate a crop's text skew (degrees) by horizontal projection-profile variance over ±5°. A page whose
   * text lines are horizontal projects to a row-sum profile with sharp peaks (dense text rows) and deep
   * troughs (line gaps) → HIGH variance; a tilted page smears ink across rows → low variance. The shear
   * angle that maximises the variance is the skew. Returns 0 OUTSIDE the [0.5°,5°] band — either the scan is
   * already straight (don't touch it) or the estimate is too large to be a plausible scan tilt (don't trust
   * it). Runs on a ≤320 px downsample (skew is scale-invariant) so it stays cheap per region.
   */
  _ocrEstimateSkewDeg(src) {
    const sc = Math.min(1, 320 / Math.max(src.width, src.height));
    const w = Math.max(8, Math.round(src.width * sc)), h = Math.max(8, Math.round(src.height * sc));
    if (h < 24) return 0;                         // too short to read a line rhythm
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h); cx.drawImage(src, 0, 0, w, h);
    let im; try { im = cx.getImageData(0, 0, w, h); } catch (_) { return 0; }
    const d = im.data, ink = new Uint8Array(w * h); let any = 0;
    for (let i = 0, p = 0; i < d.length; i += 4, p++) if ((d[i] + d[i + 1] + d[i + 2]) / 3 < 128) { ink[p] = 1; any++; }
    if (any < w) return 0;                         // barely any ink — nothing to align
    const OFF = 24, len = h + 2 * OFF, midX = w / 2;
    let bestVar = -1, bestDeg = 0;
    for (let deg = -5; deg <= 5.0001; deg += 0.5) {
      const t = Math.tan(deg * Math.PI / 180);
      const rows = new Float32Array(len);
      for (let y = 0; y < h; y++) {
        const base = y * w;
        for (let x = 0; x < w; x++) { if (!ink[base + x]) continue; const yy = y - Math.round((x - midX) * t) + OFF; if (yy >= 0 && yy < len) rows[yy]++; }
      }
      let mean = 0; for (let k = 0; k < len; k++) mean += rows[k]; mean /= len;
      let v = 0; for (let k = 0; k < len; k++) { const dd = rows[k] - mean; v += dd * dd; }
      if (v > bestVar) { bestVar = v; bestDeg = deg; }
    }
    return (Math.abs(bestDeg) >= 0.5 && Math.abs(bestDeg) <= 5) ? bestDeg : 0;
  },

  /**
   * Build the image fed to Tesseract for one region: crop → contrast-boost → (optional) shear-straighten by
   * an estimated skew → (optional) bicubic UPSCALE. Returns the canvas plus mapBack(bbox), which converts a
   * recognised word box back to ORIGINAL page-canvas coordinates (undoing the upscale and the shear).
   *
   * Upscaling small text is the single biggest recall win: Tesseract wants a ~30 px x-height, so a low-DPI
   * table cell / address line at ~16–20 px reads far better blown up 2–3× (bicubic) than at native size —
   * that recovers cells the raw crop dropped. Deskew only fires in the 0.5°–5° band (see estimate) and uses
   * a vertical shear (≈ rotation for small angles) so line-mapping back is a clean per-x y-offset.
   */
  _ocrPrepRegion(src, r, opts = {}) {
    const cw = r.x1 - r.x0, ch = r.y1 - r.y0;
    const crop = document.createElement('canvas'); crop.width = cw; crop.height = ch;
    crop.getContext('2d', { willReadFrequently: true }).drawImage(src, r.x0, r.y0, cw, ch, 0, 0, cw, ch);
    this._ocrContrastBoost(crop, r.margin ? { lo: 120, hi: 150 } : {});
    const deg = opts.deskew ? this._ocrEstimateSkewDeg(crop) : 0;
    const t = deg ? Math.tan(deg * Math.PI / 180) : 0;
    let work = crop;
    if (t) {
      const rot = document.createElement('canvas'); rot.width = cw; rot.height = ch;
      const rx = rot.getContext('2d');
      rx.fillStyle = '#fff'; rx.fillRect(0, 0, cw, ch);
      rx.setTransform(1, -t, 0, 1, 0, t * (cw / 2));     // straighten: y' = y - t·(x - cw/2)
      rx.drawImage(crop, 0, 0);
      rx.setTransform(1, 0, 0, 1, 0, 0);
      work = rot;
    }
    const us = Math.max(1, Math.min(3, opts.upscale || 1));
    let outc = work;
    if (us > 1) {
      const up = document.createElement('canvas'); up.width = Math.round(cw * us); up.height = Math.round(ch * us);
      const ux = up.getContext('2d'); ux.imageSmoothingEnabled = true; ux.imageSmoothingQuality = 'high';
      ux.drawImage(work, 0, 0, up.width, up.height);
      outc = up;
    }
    const mapBack = (bb) => {
      const xc = ((bb.x0 + bb.x1) / 2) / us;
      const dy = t ? t * (xc - cw / 2) : 0;          // inverse shear (const across a word's small width)
      return { x0: bb.x0 / us + r.x0, x1: bb.x1 / us + r.x0, y0: bb.y0 / us + dy + r.y0, y1: bb.y1 / us + dy + r.y0 };
    };
    return { canvas: outc, mapBack, deg, us };
  },

  /**
   * REGION-BOUNDED re-OCR for the readable PDF (Lege-style bounded extraction). The full-page pass is
   * polluted by the map / speckle and reads the notice at ~79 %; feeding Tesseract the WHOLE page also
   * makes it hallucinate glyphs in blank/graphic areas. This re-reads ONLY the text regions — each
   * isolated, contrast-boosted and recognised as a single column (PSM 4) — which lifts recall to ~90 %
   * AND cannot invent text in whitespace/graphics because those pixels are never fed to the engine.
   *
   * Text regions are SEEDED from the confident full-page items (the notice reads high-confidence; the map
   * speckle reads low and drops out), then split into blocks wherever a big vertical gap breaks the column
   * (a map / figure / whitespace band) so a text crop never swallows the map. Two extra margin bands
   * (top/bottom 10 %, aggressively whitened, PSM 11 sparse) recover a faint page number / date the full
   * page skipped. Returns words in CANVAS coordinates, or null when there is no seed text.
   */
  async _ocrReadablePass(pv, worker) {
    const src = pv.canvas;
    if (!src) return null;
    const W = src.width, H = src.height;
    const seed = (this.extractedTextItems || []).filter((t) => t.ocr && t.pageIndex === pv.pageNum && (t.text || '').trim()
      && (typeof t.ocrConf !== 'number' || t.ocrConf >= 50 || (t.text.match(/[A-Za-z]/g) || []).length >= 4));
    const seedLinesRaw = seed.length ? this.groupTextItemsByLine(seed).slice().sort((a, b) => a.top - b.top) : [];
    // Drop SPECKLE seed lines (a lone 1–2 char misread of map / signature / handwriting noise) BEFORE forming
    // blocks — keep a line only if it carries a real word (≥3 letters) or a ≥2-digit run. Speckle otherwise
    // (a) drags the MEDIAN line height down so the gap-split threshold collapses and the real text chains into
    // one page-spanning block that can neither be isolated (a table row swallowed by the map) nor upscaled
    // (too big for the memory cap), and (b) seeds junk crop regions. Removing it repairs both.
    const hasRealText = (t) => (t || '').split(/\s+/).some((w) => (w.match(/[A-Za-z]/g) || []).length >= 3) || /\d{2,}/.test(t || '');
    const seedLines = seedLinesRaw.filter((l) => hasRealText(l.text));
    if (!seedLines.length) return null;
    const hs = seedLines.map((l) => l.bottom - l.top).sort((a, b) => a - b);
    const medH = hs[hs.length >> 1] || 20;
    // Split seed lines into column BLOCKS at any vertical gap wider than ~2.5 line-heights (a map/figure
    // /whitespace break) — each block is cropped on its own so a text region never includes the map. Also cap
    // a block's HEIGHT so it stays isolatable and upscalable (a table/address block must not fuse into a
    // full-page slab that then can't be blown up 2× within the memory budget).
    const maxBlockH = Math.max(700, Math.round(H * 0.3));
    const blocks = [];
    for (const l of seedLines) {
      const lh = Math.max(1, l.bottom - l.top);
      const b = blocks[blocks.length - 1];
      if (b && l.top - b.y1 <= medH * 2.5 && (l.bottom - b.y0) <= maxBlockH) { b.x0 = Math.min(b.x0, l.left); b.x1 = Math.max(b.x1, l.right); b.y1 = Math.max(b.y1, l.bottom); b.hs.push(lh); }
      else blocks.push({ x0: l.left, y0: l.top, x1: l.right, y1: l.bottom, hs: [lh] });
    }
    const PAD = Math.max(8, Math.round(medH * 1.3));   // generous — a faint un-seeded line at a block edge still gets into the crop
    const band = Math.round(H * 0.1);
    // STRICT PSM per block: a single line reads best as ONE text line (PSM 7); a multi-line block whose rows
    // are all a similar size (a table column, an address stack, body prose) reads best as a single UNIFORM
    // block (PSM 6); a MIXED-size block (a big heading sitting above smaller body) keeps AUTO column layout
    // (PSM 4) — PSM 6 would misread the size jump. This lifts a small uniform table/address from the looser
    // PSM 4. medH per block also drives the upscale factor below.
    const regions = blocks.map((b) => {
      const shs = b.hs.slice().sort((p, q) => p - q);
      const lineH = shs[shs.length >> 1] || medH;
      const uniform = shs.length >= 2 && shs[shs.length - 1] <= shs[0] * 1.6;
      const psm = shs.length <= 1 ? 7 : (uniform ? 6 : 4);
      return { x0: Math.max(0, b.x0 - PAD), y0: Math.max(0, b.y0 - PAD), x1: Math.min(W, b.x1 + PAD), y1: Math.min(H, b.y1 + PAD), psm, margin: false, lineH, nLines: shs.length };
    });
    // GAP-FILL: a real printed row the FULL-PAGE pass missed ENTIRELY (e.g. a table row whose neighbour cell
    // holds handwriting that confused the layout — the LCA "9 Royal Crest Dr" address) never seeds a block, so
    // it falls in the GAP between two detected blocks. Re-OCR each MODERATE inter-block gap (≈1.2–8 line-heights
    // — a plausibly-missed row or two, not a large figure/whitespace band) as its own upscaled uniform block.
    // Any speckle this turns up is dropped by the downstream per-word + per-line filters. x-range = the union
    // of the two neighbours so a full-width table row is fully covered.
    for (let i = 1; i < blocks.length; i++) {
      const a = blocks[i - 1], b = blocks[i];
      const gap = b.y0 - a.y1;
      // Fill a gap that's plausibly a couple of MISSED rows, not a figure/map/whitespace band. Bound it by the
      // taller neighbour block's OWN height (a missed row's gap is comparable to a text block; a figure gap is
      // far larger) — this is scale-robust where a global median line-height is not (surviving signature/hand-
      // writing speckle drags the median down and would wrongly reject the real LCA row-2 gap).
      const ref = Math.max(a.y1 - a.y0, b.y1 - b.y0);
      if (gap < medH * 1.2 || gap > ref * 2) continue;
      regions.push({ x0: Math.max(0, Math.min(a.x0, b.x0) - PAD), y0: Math.max(0, a.y1), x1: Math.min(W, Math.max(a.x1, b.x1) + PAD), y1: Math.min(H, b.y0), psm: 6, margin: false, lineH: medH, nLines: 2 });
    }
    // Margin bands catch text OUTSIDE the blocks (a footer page number / header sitting below/above the
    // body). They MUST stop at the nearest block edge: if a block reaches into the band, re-OCR-ing that
    // overlap re-reads the block's own last line as an OVERSIZED duplicate that then covers the line below
    // it (a bottom URL got hidden this way). Clamp the top band to ABOVE the first block, the bottom band
    // to BELOW the last block; an empty band (a block fills it) is skipped by the size guard below.
    const topBlock = blocks.reduce((m, b) => Math.min(m, b.y0), H);
    const botBlock = blocks.reduce((m, b) => Math.max(m, b.y1), 0);
    regions.push({ x0: 0, y0: 0, x1: W, y1: Math.min(band, Math.max(0, topBlock - PAD)), psm: 11, margin: true });
    regions.push({ x0: 0, y0: Math.max(H - band, Math.min(H, botBlock + PAD)), x1: W, y1: H, psm: 11, margin: true });
    const out = [];
    for (const r of regions) {
      const cw = r.x1 - r.x0, ch = r.y1 - r.y0;
      if (cw < 8 || ch < 8) continue;
      // UPSCALE the text region ~2× (bicubic). This is the biggest recall win: the interpolation SMOOTHS
      // scanner/JPEG noise and crisps glyph edges, so Tesseract reads a row it garbled at native size — even
      // when the text is already large (a 2× blow-up of an 80 px line recovered a whole address row the raw
      // crop dropped). 3× for genuinely small text. (2.5× recovered one extra body word but jittered the
      // saved font sizes and slowed the pass — not worth it.) Capped at ~24 MP so a big block never OOMs.
      let us = 1;
      if (!r.margin) {
        us = (r.lineH > 0 && r.lineH < 26) ? 3 : 2;
        while (us > 1 && cw * us * ch * us > 24000000) us -= 0.5;
      }
      // DESKEW only a genuinely multi-line block (≥3 lines give the projection profile a rhythm to lock to);
      // a single line's tilt can't be told from its own bbox, so leave it (upscale still applies).
      const pre = this._ocrPrepRegion(src, r, { upscale: us, deskew: !r.margin && r.nLines >= 3 });
      let data;
      try { ({ data } = await this._ocrRecognize(worker, pre.canvas, r.psm)); } catch (_) { continue; }
      for (const w of (data.words || [])) {
        if (!w || !w.text || !w.text.trim() || !w.bbox) continue;
        const conf = typeof w.confidence === 'number' ? w.confidence : 100;
        const letters = (w.text.match(/[A-Za-z]/g) || []).length;
        const digits = (w.text.match(/[0-9]/g) || []).length;
        // Margin band: keep only a page-number-/date-like token (a real digit run or a ≥3-letter word at
        // decent confidence) — the aggressive whiten there can otherwise coin specks from shadow edges.
        if (r.margin) { if (!(conf >= 55 && (digits >= 1 || letters >= 3))) continue; }
        // Block / gap region: keep a decent word, a SHORT real word (≥3 letters — "End", "Dr", "Ten" — the
        // form label "End Date" was vanishing because "End" fell under a 4-letter floor), OR a DIGIT RUN (a
        // zip / date / id — "03060", "01570"). Isolated speckle that slips through is caught by the outer
        // LINE-level keep/drop in ocrSaveReadable (a lone junk token never forms a coherent prose line), so
        // this inner gate can afford to be generous and not lose address tails / label words.
        else if (!(conf >= 40 || (letters >= 3 && letters >= w.text.trim().length * 0.5) || (digits >= 3 && conf >= 20))) continue;
        out.push({ text: w.text, conf, bbox: pre.mapBack(w.bbox) });
      }
    }
    // Dedupe words shared by an overlapping block + margin band (keep the higher-confidence copy).
    out.sort((a, b) => b.conf - a.conf);
    const iou = (a, b) => {
      const ix = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), iy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (ix <= 0 || iy <= 0) return 0;
      const inter = ix * iy, u = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
      return u > 0 ? inter / u : 0;
    };
    const kept = [];
    for (const w of out) if (!kept.some((k) => k.text.trim() === w.text.trim() && iou(k.bbox, w.bbox) > 0.4)) kept.push(w);
    return kept.length ? kept : null;
  },

  /**
   * "Save as readable PDF" (scans only): rebuild every recognised line as REAL, selectable text at its
   * EXACT printed position — same colour, size and line background — so the page looks like the scan but
   * its text is now readable / selectable / editable. Only the recognised TEXT lines are covered (with
   * their own sampled background) and redrawn; EVERYTHING ELSE — images, graphics, logos, HANDWRITING,
   * anything OCR didn't turn into a confident word — is the untouched scan, so it stays pixel-exact in
   * place. Reuses the mupdf edit engine by synthesising one OCR-line edit per line (identical to editing
   * that line to its own text).
   */
  async ocrSaveReadable() {
    if (!MupdfService.isSupported() || !this.originalFileData) {
      this.showStatus('Readable PDF needs the in-browser engine (reload and try again).', 'error'); return;
    }
    const overlay = this._ocrProgressOverlay('Building a readable PDF…');
    try {
      await this.ocrRecognizeAllPages((d, t) => { if (t) overlay.set(`Reading page ${Math.min(d + 1, t)} of ${t}…`); });
      overlay.set('Re-reading the text regions…');
      const s = this.scale || 1;
      let tw = null;
      try { tw = await this._ocrEnsureWorker(); } catch (_) {}
      const edits = [];
      const pageLines = {};      // pageNum -> detected table/grid rules (canvas px) for the vector overlay
      for (const pv of this.pageViews || []) {
        if (!pv || !pv.canvas) continue;
        // NON-ENGLISH page (legacy Devanagari page, or a Phase-5 detected-language scan): the stored OCR is
        // already in the correct language and the page's OWN pixels render the script — so add an INVISIBLE
        // searchable layer (OCRmyPDF principle) and keep the original render, exactly like the always-on
        // searchable bake. The English readable pass below MUST be skipped for these: it re-OCRs with the
        // ENGLISH worker and its Latin-only sanitize()/realWords()/isVisible gates (`/[A-Za-z0-9]/`, 3+ Latin
        // letters) strip every Devanagari/CJK token — 0 of N lines survive, producing a blank-text PDF. We
        // don't re-draw the text visibly (would double the already-rendered glyphs, and drawing OCR-guessed
        // shaped glyphs risks the wrong ones); the invisible layer makes it selectable/searchable in any viewer.
        if (pv._ocrLang && pv._ocrLang !== 'eng') {
          const stored = (this.extractedTextItems || []).filter((t) => t.ocr && t.pageIndex === pv.pageNum && (t.text || '').trim());
          for (const it of stored) {
            // Skip words the user already EDITED — the edit path bakes those visibly; a second invisible copy
            // would double them for search.
            const consumed = (this.edits || []).some((e) => e.pageIndex === it.pageIndex && e.redact !== false &&
              Math.min(e.right * s, it.right) - Math.max(e.x * s, it.left) > 0 &&
              Math.min(e.bottom * s, it.bottom) - Math.max(e.top * s, it.top) > 0);
            if (consumed) continue;
            const ih = Math.max(1, it.bottom - it.top);
            edits.push({
              redact: false, invisible: true, pageIndex: pv.pageNum,
              x: it.left / s, right: it.right / s, top: it.top / s, bottom: it.bottom / s,
              baseline: (it.baseline || it.bottom) / s, fontSize: Math.max(4, (ih / s) * 0.85),
              newText: it.text,
            });
          }
          continue;   // no visible redraw / cover strips / table vectorisation for a non-English page
        }
        // REGION-BOUNDED re-OCR (readable ≠ search overlay): the full-page overlay is what stays
        // searchable, but the readable PDF re-reads only the TEXT regions in isolation (contrast-boosted,
        // single-column PSM 4 + whitened margin bands) — that lifts recall ~79 %→~90 % on a poor scan AND
        // cannot invent glyphs in the map / blank / handwriting areas, because those pixels are never fed
        // to the engine. Falls back to the stored full-page items when there is no seed / no worker.
        let items = null;
        // Reuse the background upgrade's result when it already re-read THIS page at the current scale/size —
        // the editor's search-upgrade and the readable save run the identical pass, so don't pay it twice.
        const cache = this._ocrReadableCache && this._ocrReadableCache[pv.pageNum];
        const cachedWords = (cache && cache.scale === s && cache.w === pv.canvas.width && cache.h === pv.canvas.height) ? cache.words : null;
        if (tw || cachedWords) { try { const words = cachedWords || await this._ocrReadablePass(pv, tw); if (words) items = words.map((w) => { const b = w.bbox, h = Math.max(1, b.y1 - b.y0); return { text: w.text, ocr: true, pageIndex: pv.pageNum, ocrConf: w.conf, left: b.x0, right: b.x1, top: b.y0, bottom: b.y1, baseline: b.y0 + h * 0.8, width: Math.max(1, b.x1 - b.x0), height: h }; }); } catch (_) {} }
        if (!items) items = (this.extractedTextItems || []).filter((t) => t.ocr && t.pageIndex === pv.pageNum && (t.text || '').trim());
        if (!items.length) continue;
        // LINE-LEVEL keep/drop (NOT per-word): a per-word confidence cut left GAPS mid-sentence — a real
        // word Tesseract was unsure of vanished ("211 Main" → "Street …", "ten"/"from" gone). Instead we
        // group ALL items into lines, then keep a WHOLE line when it reads as prose (decent average
        // confidence OR ≥2 real words) and draw it COMPLETE; a SPECKLE line (map noise, a stray misread)
        // is dropped whole → it stays as the scan's own pixels. No cross-line merging (that jumbled the
        // two bullet lines together).
        const lineConf = (l) => { const cs = (l.items || []).map((i) => i.ocrConf).filter((c) => typeof c === 'number'); return cs.length ? cs.reduce((a, b) => a + b, 0) / cs.length : 100; };
        const realWords = (t) => (t || '').split(/\s+/).filter((w) => (w.match(/[A-Za-z]/g) || []).length >= 3).length;
        // §4 sanitize: strip isolated PURE-SYMBOL tokens ("~", ".,,", "`^", "|", "§") that OCR coins from
        // speckle/shadow — any whitespace-delimited token with NO letter or digit is garbage. Punctuation
        // attached to a real word ("Webster,", "01570.") keeps its alphanumerics, so it survives.
        const sanitize = (t) => (t || '').split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).join(' ');
        const pageH = pv.canvas.height;
        // Every real (non-speckle) recognised line. A line is REDRAWN VISIBLY only when it is CONFIDENTLY
        // machine-printed text (avg word confidence ≥ VIS_CONF). HANDWRITING and garbled reads (a hand-filled
        // table cell "Bed Room Wall", a hand-written date, a mangled URL tail "…eTAGreCment.pal") score much
        // lower — on real scans printed text lands ~84–97 while handwriting/garbage lands ≤ ~60, a clean gap —
        // and drawing their uncertain glyphs would print WRONG text over the scan (the user's "STOP CONVERTING
        // HANDWRITING"). Those stay as the ORIGINAL scan pixels (readable) and, per the OCRmyPDF principle, are
        // still added to the INVISIBLE searchable layer so nothing readable becomes unsearchable. The old
        // `|| rw >= 2` branch (no confidence floor) is exactly what let a 2-token handwriting/URL misread
        // through — removed.
        const VIS_CONF = 70;
        const allLines = this.groupTextItemsByLine(items)
          .map((l) => { l.text = sanitize(cleanNoiseTokens(l.text)); return l; })
          .filter((l) => { const t = (l.text || '').trim(); return t && !isNoiseLine(t); });
        const isVisible = (l) => realWords(l.text) >= 1 && lineConf(l) >= VIS_CONF;
        const lines = allLines.filter(isVisible);                                        // confident PRINTED text → redrawn
        // Invisible searchable-only: a low-confidence line that still carries a real word OR a digit run (a
        // ZIP / id / number like "03060" that has no ≥3-letter word would otherwise fall out and be
        // searchable in the editor but NOT in the saved file — the two must match).
        const searchOnly = allLines.filter((l) => !isVisible(l) && (realWords(l.text) >= 1 || /\d{3,}/.test(l.text))); // handwriting/low-conf → invisible, searchable only, scan kept
        // Invisible searchable layer for the low-confidence lines — keeps "End Date" & co findable without
        // painting uncertain glyphs over the scan (same insert path as ocrBakeSearchable, invisible:true).
        // PER WORD, not per line: grouping tucks tight neighbours together ("End"+"Date" → "EndDate"), which
        // breaks a phrase search — one invisible text run per word keeps them separately findable.
        for (const line of searchOnly) {
          for (const it of (line.items || [])) {
            const wt = (it.text || '').trim();
            if (!wt || !/[A-Za-z0-9]/.test(wt)) continue;               // skip pure-symbol speckle
            const h = Math.max(1, it.bottom - it.top);
            edits.push({
              redact: false, invisible: true, pageIndex: pv.pageNum,
              x: it.left / s, right: it.right / s, top: it.top / s, bottom: it.bottom / s,
              baseline: (it.baseline || it.bottom) / s, fontSize: Math.max(4, (h / s) * 0.85),
              newText: wt,
            });
          }
        }
        if (!lines.length) continue;
        // Size basis = median WORD (item) height, NOT median LINE height. A line's bbox can get INFLATED
        // by the region re-OCR (a stray tall word, a spread baseline), and if `dom` were that inflated
        // line height the margin/global clamps below (which cap to `dom`) would cap to nothing useful — an
        // oversized bottom line then baked over the line beneath it and HALF-HID a URL. Word boxes are
        // tight, so `dom` is the real body size and the clamps actually bite. Falls back to line height.
        // TWO references: `domLine` (median LINE height) snaps the body tier so lines come out uniform;
        // `domFont` (median WORD height ≈ the true body font size) drives the clamps. They differ when the
        // region re-OCR inflates a line's bbox — using the inflated line height for the clamp let an
        // oversized bottom line bake over the URL beneath it. Word boxes are tight, so `domFont` bites.
        const itemHs = (items || []).map((t) => t.bottom - t.top).filter((h) => h > 0).sort((a, b) => a - b);
        const lineHs = lines.map((l) => l.bottom - l.top).sort((a, b) => a - b);
        const domLine = lineHs[Math.floor(lineHs.length / 2)] || 12;
        const domFont = itemHs[Math.floor(itemHs.length / 2)] || domLine;
        for (const line of lines) {
          const col = sampleLineColors(pv, line) || {};
          const h = line.bottom - line.top;
          // §2 typography clamp. Snap the BODY tier (0.55–1.7× the dominant LINE height) to one size — kills
          // per-word jitter. Then guardrails against the header/footer blow-up (an oversized bottom line
          // covered a URL below): GLOBAL cap ≤ 2× the body FONT size (a real heading is ≤2×), and in the
          // top/bottom band hold to ~the body font size so a margin line can't overrun the line beneath it.
          const cy = (line.top + line.bottom) / 2;
          let sizePx = (h > domLine * 0.55 && h < domLine * 1.7) ? domLine : h;
          sizePx = Math.min(sizePx, domFont * 2.0);
          if (cy < pageH * 0.15 || cy > pageH * 0.82) sizePx = Math.min(sizePx, domFont * 1.1);
          const size = sizePx / s;
          // TIGHT BOX for an INFLATED OCR line: when the bbox height ≫ the glyph size, its baseline drifts
          // to the box BOTTOM (onto the line below), and its COVER blankets that line — a bottom URL got
          // covered this way. Re-seat such a line to a tight box measured from its TOP (the ink sits near
          // the top of an inflated box), so both the cover and the text stay on their own line.
          let eTop = line.top, eBot = line.bottom, eBaseline = line.baseline || line.bottom;
          if (h > sizePx * 1.6) { eBot = Math.min(line.bottom, line.top + sizePx * 1.35); eBaseline = line.top + sizePx * 0.9; }
          edits.push({
            pageIndex: pv.pageNum, ocr: true, style: 'text',
            x: line.left / s, right: line.right / s, top: eTop / s, bottom: eBot / s,
            baseline: eBaseline / s, fontSize: Math.max(4, size),
            bold: false, italic: false, serif: false,
            angle: line.angle || 0, rotated: !!line.rotated,
            newText: line.text,
            color: (col.text || null), bgColor: (col.bg || null),
          });
        }
        // §1 table/grid vectorisation: find the raster rules so we can overlay crisp native vector lines.
        try { pageLines[pv.pageNum] = detectTableLines(pv.canvas); } catch (_) {}
      }
      if (!edits.length) { this.showStatus('No recognised text to make readable.', 'info'); return; }
      overlay.set('Saving the readable PDF…');
      const fabric = this.annotationManager ? this.annotationManager.serialize() : [];
      let bytes = await MupdfService.editPDF(this.originalFileData, edits, fabric);
      bytes = await this._ocrDrawVectorRules(bytes, pageLines, s);
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'readable.pdf';
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
      this.showStatus('Readable PDF saved — the scanned text is now real, selectable text; images & handwriting kept in place.', 'success');
    } catch (e) {
      console.warn('readable-PDF save failed:', e && e.message);
      this.showStatus('Could not build the readable PDF.', 'error');
    } finally {
      overlay.remove();
    }
  },

  /** Overlay CRISP native vector lines at the detected table/grid rules (§1). Post-processes the readable
   *  bytes with pdf-lib (drawLine) — canvas px → PDF pts (÷ scale) with the y-axis flipped to pdf-lib's
   *  bottom origin. Best-effort: any failure returns the text-only readable PDF unchanged. */
  async _ocrDrawVectorRules(bytes, pageLines, s) {
    try {
      const any = Object.values(pageLines || {}).some((L) => L && (L.horizontal.length || L.vertical.length));
      if (!any) return bytes;
      const { PDFDocument, rgb } = await import('pdf-lib');
      const doc = await PDFDocument.load(bytes);
      const pages = doc.getPages();
      const col = rgb(0.1, 0.1, 0.1);
      for (const [pnStr, L] of Object.entries(pageLines)) {
        const page = pages[+pnStr];
        if (!page || !L) continue;
        const ph = page.getHeight();
        for (const h of L.horizontal) {
          const y = ph - h.y / s;
          page.drawLine({ start: { x: h.x0 / s, y }, end: { x: h.x1 / s, y }, thickness: Math.max(0.6, (h.thick || 1) / s), color: col });
        }
        for (const v of L.vertical) {
          const x = v.x / s;
          page.drawLine({ start: { x, y: ph - v.y0 / s }, end: { x, y: ph - v.y1 / s }, thickness: Math.max(0.6, (v.thick || 1) / s), color: col });
        }
      }
      return await doc.save();
    } catch (e) {
      console.warn('vector-rule overlay skipped (kept text-only readable PDF):', e && e.message);
      return bytes;
    }
  },

  /**
   * "Download text" (.txt / .rtf): recognise every scanned page, collect ALL pages' lines in reading
   * order, strip headers / footers / page numbers (repetition + page-band heuristic — see
   * util/textExport.js) and download a clean text or complete RTF file. Works for scans (their whole
   * point) and carries native text lines along on mixed docs.
   */
  async ocrExportText(fmt) {
    const overlay = this._ocrProgressOverlay('Preparing text…');
    try {
      await this.ocrRecognizeAllPages((d, t) => { if (t) overlay.set(`Reading page ${Math.min(d + 1, t)} of ${t}…`); });
      overlay.set('Building the file…');
      // Confidence floor for EXPORT only (the on-page overlay keeps everything for search). A scanned
      // MAP's speckle comes back LOW-confidence (median ~58 on the real LCA map) while genuine prose —
      // content AND function words — sits high (real words p25 ≈ 80). Dropping < 68 removes the map-label
      // storm ("WTR", "WEEK", "NES") that the shape denoise can't catch (they're 3–4 letters), while the
      // notice text survives. Native (non-OCR) items have no ocrConf → always kept.
      const OCR_EXPORT_MIN_CONF = 68;
      const pages = [];
      for (const pv of this.pageViews || []) {
        if (!pv) continue;
        const items = (this.extractedTextItems || []).filter((t) => t.pageIndex === pv.pageNum
          && !(t.ocr && typeof t.ocrConf === 'number' && t.ocrConf < OCR_EXPORT_MIN_CONF));
        let lines = this.groupTextItemsByLine(items);
        if (lines.length > 2 && lines.some((l) => l.ocr) && pv.canvas) {
          lines = orderLinesForReading(lines, pv.canvas.width);
        }
        pages.push({
          height: (pv.canvas && pv.canvas.height) || (pv.viewport && pv.viewport.height) || 1,
          lines: lines.map((l) => ({ text: l.text, top: l.top, bottom: l.bottom })),
        });
      }
      // denoise = drop OCR speckle: a scanned MAP / dirty scan makes Tesseract emit a storm of 1–2 char
      // fragments and lone symbols (70%+ of the "words" on a map), which turned "Download text" into
      // gibberish. Any line with a real word is kept, so a genuine notice/letter is untouched.
      const out = buildDocumentText(pages, { strip: true, denoise: true });
      const rtf = fmt === 'rtf';
      const blob = new Blob([rtf ? out.rtf : out.txt], { type: rtf ? 'application/rtf' : 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'document-text.' + (rtf ? 'rtf' : 'txt');
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(a.href);
      const cleaned = (out.strippedCount || 0) + (out.denoisedCount || 0);
      this.showStatus(cleaned
        ? `Text downloaded — ${cleaned} noise/header/footer line${cleaned === 1 ? '' : 's'} removed.`
        : 'Text downloaded.', 'success');
    } catch (e) {
      console.warn('text export failed:', e && e.message);
      this.showStatus('Text export failed.', 'error');
    } finally {
      overlay.remove();
    }
  },

  /** Small centred progress pill for the searchable pass (non-blocking, self-cleaning). */
  _ocrProgressOverlay(initial) {
    const el = document.createElement('div');
    el.id = 'searchableProgress';
    el.textContent = initial || '';
    document.body.appendChild(el);
    return {
      set(t) { el.textContent = t; },
      remove() { el.remove(); },
    };
  },

  async ocrDispose() {
    const o = this._ocr;
    if (o && o.tw) { try { await o.tw.terminate(); } catch (_) {} }
    this._ocr = undefined;
  },
};
