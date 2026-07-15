// Inline text editing — build/clear editable line boxes, group pdf.js text into lines, detect+refine per-line style, convert a line to an edit.
// Assembled onto PDFEditorApp.prototype (mixin); verbatim from app.js (this = the app).
import { rgb } from 'pdf-lib';
import { sampleLineColors } from '../util/canvas.js';
import { rgbCss } from '../util/color.js';
import { fontStyleFromPdfjs } from '../util/fonts.js';
import { LINK_BLUE } from '../util/fontCatalog.js';
import { MupdfService } from '../services/mupdfService.js';
import { orderLinesForReading } from '../util/readingOrder.js';
import { isLegacyGarbledPage } from '../util/legacyFont.js';
import { detectScript, fontStackForScript, isRtlScript } from '../util/script.js';

export const TextEditingMethods = {
  /** Shrink an edited OCR line's font so a LONGER replacement fits the ORIGINAL line's footprint (its OCR
   *  bbox width, = the region the save redacts). An OCR overlay sits on a FIXED rendered page — editing a
   *  line cannot reflow what is drawn beside it, so a replacement wider than the original spills over the
   *  next cell or the rendered text right after it. A table on the OCR'd book broke this way: "Officer"→
   *  "Superintendent" ran over the rendered "2019" beside it (the "2019" is baked into the page image, not a
   *  separate editable box — so a neighbour-gap measure can't see it; the original footprint can). Scoped to
   *  OCR lines; normal text lines keep extending into their margin. Updates line.fontSizePx (display) AND the
   *  tracked edit's fontSize (so Save draws the same fitted size). Idempotent — once fitted it measures in. */
  _fitOcrEditWidth(line, shownText) {
    if (!line.ocr || !shownText || !(line.fontSizePx > 0)) return;
    const avail = line.right - line.left;                                        // original footprint = redacted region
    if (avail <= 4) return;
    const ctx = this._measCtx || (this._measCtx = document.createElement('canvas').getContext('2d'));
    ctx.font = `${line.italic ? 'italic ' : ''}${line.bold ? '700 ' : ''}${line.fontSizePx}px sans-serif`;
    const w = ctx.measureText(shownText).width;
    if (w <= avail) return;                                                      // already fits → no shrink
    const fit = Math.max(line.fontSizePx * (avail / w) * 0.98, line.fontSizePx * 0.35);   // shrink to fit (floor 35%)
    line.fontSizePx = fit;
    const pend = this.findLineEdit(line);
    if (pend) { pend.fontSize = fit / (this.scale || 1); pend.sizeOverride = true; }   // sizeOverride: the save
    // engine (mupdfEdit) otherwise re-uses the ORIGINAL span's size (the legacy glyphs behind this line) and
    // ignores e.fontSize — so without this flag the SAVE keeps the full size and still overflows.
  },
  /**
   * Overlay an editable box on EACH line of text. Every box sits exactly on its original
   * line (same left, baseline and size) and edits that line in place. Only the lines the
   * user actually changes are tracked, so saving leaves all other text untouched.
   */
  async createEditableTextBoxes(pv) {
    // Skip ROTATED pages: the per-line edit boxes are laid out in the page's unrotated text space, so
    // on a rotated render they land garbled/overlapping. Existing-text editing is therefore disabled
    // on rotated pages — Add text, Highlight, Sign, Stamp and Erase still work (they map clicks live).
    if (((pv.page && pv.page.rotate) || 0) % 360 !== 0) return;
    // Rotated text runs are now EDITABLE too: groupTextItemsByLine keeps each as its own single-run
    // line (carrying its angle), and the box below mirrors that rotation with a CSS transform. So they
    // are included here — the old `!item.rotated` skip (which left rotated text uneditable to avoid a
    // phantom horizontal box) is gone; a rotated line just gets a rotated box.
    const pageTextItems = this.extractedTextItems.filter(item => item.pageIndex === pv.pageNum);
    // OCR (lazy): an image-only / scanned page has NO extractable text, so trigger background OCR for it
    // HERE — BEFORE the empty-page early return below (that return is exactly why an end-of-function hook
    // never fired for scans). Re-entrant-safe; a no-op unless the OCR module is loaded and the page is a scan.
    if (this.ocrMaybePage) this.ocrMaybePage(pv);
    if (pageTextItems.length === 0) return;
    // LEGACY non-Unicode Indic font (Kruti Dev / APS / DevLys …): the font DRAWS correct Devanagari on the
    // canvas, but its text EXTRACTS as mis-mapped accented-Latin garbage ("ÙetLe keâe@efchšerMeve"). Editable
    // boxes would render that garbage (or fall back inconsistently) OVER the perfectly-rendered page. So on
    // such a page, skip the boxes + cover strips entirely — the canvas render is correct, leaving it
    // fully viewable (Add/Highlight/Sign/Stamp still work; the existing text just isn't editable, which it
    // couldn't be anyway without a font-specific Unicode remap). Marked so callers can surface it.
    if (isLegacyGarbledPage(pageTextItems)) {
      pv._legacyGarbled = true;
      // Phase 4: the font DRAWS correct Devanagari — OCR the render with Hindi so the text becomes correct,
      // selectable, EDITABLE Unicode. View-only (no garbage boxes) until the OCR overlay lands.
      if (this.ocrMaybePageLegacy) this.ocrMaybePageLegacy(pv);
      return;
    }

    // EXACT per-char ink colours from the PDF itself (mupdf structured text, worker round-trip).
    // Canvas pixel sampling drifts on WebKit (its rasteriser blends small glyphs so much that no
    // pixel is near the true ink), so sampled colours are only the fallback. The await parks this
    // invocation; the generation stamp discards it if a newer render re-entered for the same page.
    const boxGen = (pv._boxGen = (pv._boxGen || 0) + 1);
    const inkRes = await this._pageInkChars(pv.pageNum);
    if (pv._boxGen !== boxGen) return;
    // inkPage returns { colors, images }; older shape was the bare colors array — accept both.
    const inkChars = Array.isArray(inkRes) ? inkRes : ((inkRes && inkRes.colors) || null);
    // Baked raster images on this page (top-origin PDF pts). The cover strips below must NOT paint
    // over them: a signature/initials image stamped onto a form line otherwise gets chopped (its ink
    // inside the line's band erased) or hidden entirely — editor-display damage the save never had.
    pv._pageImages = (inkRes && !Array.isArray(inkRes) && inkRes.images) || [];
    // Re-check OCR now that raster content is KNOWN: the early call at line ~30 (before this ink pass)
    // deliberately skips a sparse-text page whose images were still unknown, so a genuine scan carrying
    // a few stray real chars (e.g. a scanner-stamped page number) is caught here instead. Idempotent —
    // a no-op if the page was already queued/recognised, or is a normal text page.
    if (this.ocrMaybePage && pv._pageImages.length) this.ocrMaybePage(pv);
    // The re-check just dropped this page's JUNK embedded OCR text layer (a searchable scan) — abort now,
    // BEFORE painting cover strips or building the misaligned boxes, so the scan stays clean and fresh OCR
    // provides aligned boxes + the readable option instead.
    if (pv._ocrJunkScanDropped) { pv._ocrJunkScanDropped = false; return; }

    const canvasWrapper = pv.wrapper;
    // The canvas may be displayed smaller than its intrinsic pixels (max-width:100%).
    const displayScale = (pv.canvas.clientWidth || pv.canvas.width) / pv.canvas.width;

    let lines = this.groupTextItemsByLine(pageTextItems);
    // SCAN pages read in COLUMN order: a multi-column scanned page (paper / notice) would otherwise
    // interleave its columns row-by-row in the box order (selection/copy jump across the gutter).
    // OCR overlays only — a normal text PDF keeps its existing row order untouched.
    if (lines.length > 2 && lines.some((l) => l.ocr)) {
      lines = orderLinesForReading(lines, pv.canvas.width);
    }
    // Kept for save-time: an edit whose redaction band overlaps ANOTHER segment on the same row
    // (an overlay fill-in and the blank under it) must re-add that segment, or mupdf's run-drop
    // removes it from the saved page. savePDF walks these via _withEntangledPreserves().
    pv._segments = lines;

    // Correct bold/italic from PDF.js's loaded fonts now that the page has rendered, so the edit
    // box previews the real weight (a non-embedded "Helvetica-Bold" heading the font-NAME guess
    // missed) — matching what the save produces.
    this.refineLineStylesFromPdfjs(pv, lines);

    // Sample each line's background colour from the freshly-rendered (clean) canvas BEFORE
    // we white it out. Saving then covers replaced text with the cell's OWN colour instead
    // of white, so coloured/shaded backgrounds survive an edit. (Reads first, writes after,
    // to avoid interleaving getImageData with fillRect.)
    lines.forEach((line) => {
      const c = sampleLineColors(pv, line);
      line.bgColor = c.bg;          // real background colour (used for the editable text contrast)
      line.textColor = c.text;      // real text colour (e.g. white) for the editable box
      // Per-item colour: tag each item that has a CHROMATIC ink (a real red/blue/green) with its OWN
      // colour, so a reopened line with SEVERAL differently-coloured words rebuilds every run's colour
      // (not just one — comparing to a single "dominant" colour dropped whichever word matched it). A
      // grey/black/white ink (saturation ≈ 0) is left to inherit the box colour: its per-glyph sampling is
      // unreliable for thin shapes (anti-aliasing), and tagging it would spuriously split a uniform line.
      // The EXACT mupdf char colour wins over the sampled estimate whenever one maps to the item.
      if (c.itemColors || inkChars) {
        const sat = (x) => Math.max(x[0], x[1], x[2]) - Math.min(x[0], x[1], x[2]);
        (line.items || []).forEach((it, k) => {
          const ic = (inkChars && this._itemInkColor(inkChars, line, it)) || (c.itemColors && c.itemColors[k]);
          if (ic && sat(ic) >= 45) it.color = ic;
        });
      }
      // Detect drawn underlines (per item) on the still-clean canvas, then build the per-run style
      // model so a mixed line (bold label + regular tail, partial underline) survives an edit.
      const anyUnderline = this._detectLineUnderlines(pv, line, c.bg);
      this._buildLineStyleRuns(line);
      if (anyUnderline && !line.styleRuns && line.items.every(it => !it.text.trim() || it.underline)) {
        line.underline = true;      // uniformly underlined line -> simple whole-line path
      }
      // Restore an underline applied + saved THIS session that the thin baked rule's pixel-detection
      // missed on this post-save re-render (only when no fresh pending edit already governs the line).
      if (!line.underline && this._savedUnderlines && !this.findLineEdit(line) &&
          this._savedUnderlines.some(u => u.p === pv.pageNum &&
            Math.abs(u.y - line.baseline / this.scale) < (line.bottom - line.top) / this.scale)) {
        line.underline = true;
      }
    });

    // Hide the original text by copying a CLEAN background strip from just outside each line over
    // the line's box (canvas->canvas drawImage: real page pixels — gradients/dark fills included,
    // GPU-safe, needs no getImageData). This blends the edit box into the page, so editing never
    // shows a white block even when pixel readback for colour sampling isn't available.
    pv.ctx.save();
    pv.ctx.setTransform(1, 0, 0, 1, 0, 0);   // device pixels, regardless of render state
    const cw = pv.canvas.width, ch = pv.canvas.height;
    lines.forEach((line) => {
      // OCR overlay lines sit over a SCANNED image — normally there is no original text to hide (the scan
      // itself shows the glyphs), so no cover strip. BUT a MOVED OCR line has been relocated: its box is
      // drawn VISIBLY at the new spot (.ocr-edited), so the scan's ORIGINAL glyphs must be hidden at the
      // OLD anchor (line.left/top, from the rebuilt spans) or the text reads twice. Edited-in-place OCR
      // lines don't need this (the box's own solid bg covers them); an unmoved OCR line still skips.
      if (line.ocr) {
        const pe = this.findLineEdit(line);
        if (!(pe && ((+pe.dx) || (+pe.dy)))) return;
      }
      // ROTATED line: the horizontal strip below leaves a HALF-CUT original (it hides a horizontal band
      // while the glyphs run at an angle). Cover the exact rotated text box instead — translate to the
      // baseline-left anchor, rotate, fill the em box with the line's background (white by default). Save
      // uses redaction (keeps art); this is the on-canvas preview so the rotated editable box (and a
      // moved one — the cover stays at the ORIGINAL anchor) reads as a clean replacement.
      if (line.rotated && line.angle) {
        const rad = line.angle;
        const fs = line.fontSizePx || (line.bottom - line.top) || 12;
        const L = Math.max(line.right - line.left, fs * 0.6);
        pv.ctx.save();
        pv.ctx.translate(line.left, line.baseline);
        pv.ctx.rotate(rad);
        const cc = line.bgColor;
        pv.ctx.fillStyle = cc ? `rgb(${cc[0]},${cc[1]},${cc[2]})` : '#ffffff';
        pv.ctx.fillRect(-2, -fs - 2, L + 4, fs * 1.35 + 4);
        pv.ctx.restore();
        return;
      }
      // Cursive/script faces (and tall display fonts) draw glyph ink WELL above the cap line and below
      // the baseline — beyond the nominal text bbox. Cover a vertical margin above/below so the baked
      // ink is fully hidden under the edit box; otherwise script ascenders/descenders peek out as the
      // "bars above each letter" + ghosting when editing a baked cursive line. Clamp the margin to the
      // gap to the nearest neighbouring line so we never cover an adjacent line's text.
      const lh0 = Math.max(1, line.bottom - line.top);
      let gapUp = line.top, gapDn = ch - line.bottom;
      for (const o of lines) {
        if (o === line) continue;
        if (o.bottom <= line.top) gapUp = Math.min(gapUp, line.top - o.bottom);
        if (o.top >= line.bottom) gapDn = Math.min(gapDn, o.top - line.bottom);
      }
      // The extra cover margin exists ONLY to hide cursive/script glyph ink that overflows the nominal
      // bbox (tall ascenders / long descenders). On normal text it instead swallows a horizontal rule
      // sitting in the gap above/below the line (e.g. a resume section divider), leaving the rule broken
      // in the editor (it reappears on save). So apply it only to script faces; normal text gets a tight cover.
      const rfn = `${this._realFontName(line) || ''} ${line.fontFamily || ''} ${line.fontName || ''}`;
      const cursive = /script|brush|pacific|snell|chancery|cursive|\bhand|comic|segoe.?print/i.test(rfn);
      const mUp = cursive ? Math.min(lh0 * 0.45, Math.max(0, gapUp * 0.8)) : 0;
      const mDn = cursive ? Math.min(lh0 * 0.45, Math.max(0, gapDn * 0.8)) : 0;
      const lx = Math.max(0, Math.floor(line.left) - 2);
      const ly = Math.max(0, Math.floor(line.top - mUp) - 2);
      const lw = Math.min(cw - lx, Math.ceil(line.right - line.left) + 6);
      const lh = Math.min(ch - ly, Math.ceil((line.bottom + mDn) - (line.top - mUp)) + 4);
      const band = Math.max(2, Math.round(lh0 * 0.18));
      let sy = ly - band - 2;                                            // clean strip ABOVE the (expanded) box...
      if (sy < 0) sy = Math.min(ch - band, Math.ceil(line.bottom + mDn) + 2);  // ...else just BELOW it
      // Only stretch the strip when it is genuinely CLEAN background. Next to a table border or a
      // section rule the strip catches that dark line and, stretched over the box, shows as a dark
      // band ("shadow") above the text. In that case cover with the line's solid background colour
      // instead — hides the original text with no band. A smooth gradient strip stays on drawImage.
      // Punch holes in this cover over any baked raster image it intersects (a signature ink
      // descending into a "Signature: ___" line's band, an initials stamp sitting ON a blank), so
      // the image survives on screen exactly as the saved PDF keeps it. Guards: a near-page-sized
      // image is the page's own backdrop (scanned docs) — never a hole, covering must still hide
      // the text; likewise an image that swallows the whole cover rect (letterhead behind text).
      const s = this.scale || 1;
      const holes = (pv._pageImages || []).map(im => ({
        x: im.x0 * s, y: im.y0 * s, w: (im.x1 - im.x0) * s, h: (im.y1 - im.y0) * s,
      })).filter(h =>
        h.x < lx + lw && h.x + h.w > lx && h.y < ly + lh && h.y + h.h > ly &&
        h.w * h.h < 0.4 * cw * ch &&
        !(h.x <= lx && h.y <= ly && h.x + h.w >= lx + lw && h.y + h.h >= ly + lh));
      const paintCover = (fn) => {
        if (!holes.length) return fn();
        pv.ctx.save();
        const p = new Path2D();
        p.rect(lx, ly, lw, lh);
        holes.forEach(h => p.rect(h.x, h.y, h.w, h.h));
        pv.ctx.clip(p, 'evenodd');            // cover rect minus the image rects
        fn();
        pv.ctx.restore();
      };
      const fillSolid = () => {
        const c = line.bgColor;
        pv.ctx.fillStyle = c ? `rgb(${c[0]},${c[1]},${c[2]})` : '#ffffff';
        pv.ctx.fillRect(lx, ly, lw, lh);
      };
      try {
        if (sy < 0 || lw <= 0 || lh <= 0) throw new Error('no source strip');
        if (this._coverStripState(pv.ctx, lx, sy, lw, band, line.bgColor) === 'dirty') paintCover(fillSolid);
        else paintCover(() => pv.ctx.drawImage(pv.canvas, lx, sy, lw, band, lx, ly, lw, lh));   // stretch clean bg strip
      } catch (e) {
        paintCover(fillSolid);
      }
    });
    pv.ctx.restore();

    lines.forEach((line) => {
      const div = document.createElement('div');
      div.contentEditable = 'true';
      div.className = 'editable-text-box';
      // OCR overlay: transparent text (the scan itself shows the glyphs) but a fully interactive box.
      if (line.ocr) div.classList.add('ocr-text');
      // Back-reference for the Search panel: it builds the docked text-toolbar target for a found
      // match ({kind:'line', el, line}) without waiting for the box to be focused.
      div.__line = line;
      // If this line was already edited, show the edited text (so edits persist on re-render).
      const pending = this.findLineEdit(line);
      // An EDITED OCR line shows its replacement VISIBLY on a solid cover — the display twin of the
      // save-side cover (the original is ink in the scan image; transparent replacement text over it
      // would read as both at once). Typing gets the same treatment via the .ocr-text:focus CSS.
      if (line.ocr && pending) {
        div.classList.add('ocr-edited');
        const obg = line.bgColor;
        div.style.background = obg ? `rgb(${obg[0]},${obg[1]},${obg[2]})` : '#fff';
      }
      const shownText = pending ? pending.newText : line.text;
      div.dataset.originalText = shownText;
      div.textContent = shownText;
      // Re-apply any floating-toolbar styling stored on the tracked edit. The line objects are
      // rebuilt from the PDF spans on every refresh, so without this the box reverts to the
      // original span's look (e.g. a colour set via the toolbar vanishes when another text box
      // is added/edited and the page re-renders).
      // Default this line's hyperlink to any pre-existing PDF link over it; a pending edit overrides.
      const detectedLink = this._lineLink(line);
      if (detectedLink) line.link = detectedLink;
      if (pending) {
        line.bold = !!pending.bold;
        line.italic = !!pending.italic;
        if (pending.fontSize) line.fontSizePx = pending.fontSize * this.scale;
        if (pending.underline) line.underline = true;
        if (pending.color) line.color = pending.color;
        if (pending.opacity != null) line.opacity = pending.opacity;
        if (pending.align) line.align = pending.align;
        if (pending.fontFamily) line.fontFamily = pending.fontFamily;
        if (pending.link) line.link = pending.link;
        if (pending.linkRemoved) { line.link = null; line.linkRemoved = true; }
        if (pending.linkRange) line.linkRange = pending.linkRange;
        // A committed mixed-style edit re-renders from its own runs (so its per-run B/I/U persists);
        // a plain (non-rich) edit clears any original run model so it stays a single style.
        // lineToEdit serialises a per-run font as `fontFamily`; the run renderer (_lineRunSpanHTML) reads
        // `family`, so map it back — else a partial FONT change is dropped on re-render (the box reverts to
        // the line's face) while colour (same key both ways) survives. That mismatch is the "font reverts
        // to the original when I click back into the line" bug.
        line.styleRuns = (pending.runs && pending.runs.length && !pending.linkRange)
          ? pending.runs[0].map(r => ({ ...r, family: r.family || r.fontFamily || null }))
          : null;
      }
      // SHRINK-TO-FIT an edited OCR line whose replacement is wider than the gap to the next box on its row,
      // so a longer replacement can't overflow into the adjacent cell/word (a table on the OCR'd book
      // overlapped this way — "Officer"→"Superintendent" ran into the "2019" beside it). Updates the display
      // size AND the tracked edit so the SAVE draws the same fitted size.
      if (line.ocr && pending) this._fitOcrEditWidth(line, shownText);
      // Editor-only "linked" affordance (a detected-on-load OR toolbar-applied link); never exported.
      if (line.link) div.classList.add('tt-has-link');
      // Partial link: show just the linked character range in blue + underline (matches the saved PDF).
      if (line.linkRange && shownText) {
        const a = Math.max(0, Math.min(line.linkRange.start, shownText.length));
        const b = Math.max(a, Math.min(line.linkRange.end, shownText.length));
        if (b > a) {
          const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          div.innerHTML = esc(shownText.slice(0, a))
            + `<span class="tt-has-link" style="color:${rgbCss(LINK_BLUE)};text-decoration:underline">${esc(shownText.slice(a, b))}</span>`
            + esc(shownText.slice(b));
        }
      } else if (line.styleRuns && line.styleRuns.length) {
        // Mixed-style line: render per-run styled spans so its bold/italic/underline shows while
        // editing and serialises back on commit. (Editing keeps each span's data-* style markers.)
        div.innerHTML = line.styleRuns.map(r => this._lineRunSpanHTML(r, line.serif)).join('');
      }

      const fontSizePx = line.fontSizePx * displayScale;
      const lineBoxPx = Math.max((line.bottom - line.top) * displayScale, fontSizePx);
      const halfLeading = Math.max(0, (lineBoxPx - fontSizePx) / 2);
      const ascent = fontSizePx * 0.8;

      const leftCss = line.left * displayScale;
      const topCss = line.baseline * displayScale - ascent - halfLeading;  // sit on the baseline
      const widthCss = (line.right - line.left) * displayScale;

      div.style.position = 'absolute';
      // Original (unmoved) position in CSS px — the move tool measures its dx/dy from these, so a
      // second drag doesn't compound the first. A pending moved edit re-applies its offset here.
      div.dataset.qpeLeft0 = String(leftCss - 1);
      div.dataset.qpeTop0 = String(topCss - 1);
      const mvX = (pending && pending.dx ? pending.dx : 0) * this.scale * displayScale;
      const mvY = (pending && pending.dy ? pending.dy : 0) * this.scale * displayScale;
      div.style.left = (leftCss - 1 + mvX) + 'px';
      div.style.top = (topCss - 1 + mvY) + 'px';
      div.style.minWidth = Math.max(widthCss, 20) + 'px';   // width:auto -> grows with text
      div.style.height = (lineBoxPx + 2) + 'px';
      // ROTATED line: overlay the rotated glyphs by pivoting on the baseline-left and rotating to the
      // run's own angle (same convention as the search highlight + insert overlays). Position at the
      // baseline (no half-leading offset), then transform-origin + rotate; the save re-emits the
      // identical matrix from edit.rotation (see lineToEdit).
      if (line.rotated && line.angle) {
        div.style.top = (line.baseline * displayScale - ascent - 1 + mvY) + 'px';
        div.style.transformOrigin = '0px ' + ascent + 'px';
        div.style.transform = `rotate(${line.angle * 180 / Math.PI}deg)`;
      }
      div.style.fontSize = fontSizePx + 'px';
      div.style.lineHeight = lineBoxPx + 'px';
      // Live font match: reuse the PDF's OWN embedded font. While rendering this page PDF.js
      // registers each embedded font as a web font under its loadedName (e.g. "g_d0_f1"), which
      // is what line.fontName holds — so we can style the editable box with it directly. We keep
      // a matching system family (Times/Arial) as the fallback, so glyphs the (subset) font lacks
      // — and Type 3 fonts PDF.js can't expose — still render instead of showing missing boxes.
      const fallbackFamily = line.serif ? '"Times New Roman", Times, serif' : 'Arial, Helvetica, sans-serif';
      // Mirror PDF.js's own text rendering: a non-embedded standard font uses the system-font
      // @font-face PDF.js injected (line.fontCss -> real Helvetica); an embedded font uses its
      // loadedName web font. Either way the edit box matches the page; fall back if neither resolves.
      // A toolbar font-family override wins over the page's own font; otherwise mirror PDF.js.
      // EXCEPTION — a MIXED-style line (per-run bold/italic): the page's single baked face (e.g. a
      // Calibri-Bold loadedName, when the line STARTS bold) can't render BOTH weights, so the regular
      // runs inherit it and CSS font-weight:normal can't un-bold them → the whole line looks bold. Use a
      // WEIGHT-RESPECTING family instead: the matching catalogue face (Calibri→Carlito) when the real font
      // is known, else a generic sans/serif stack, so each run's own weight/slant renders.
      const mixed = !!(line.styleRuns && line.styleRuns.length);
      const mixedKey = mixed ? this._displayFontKey(line.fontFamily, this._realFontName(line)) : '';
      // An EMBEDDED subset font (line.fontName = a PDF.js loadedName like "g_d0_f4") sometimes ships a
      // BROKEN Unicode->glyph cmap, so drawing the correct text through it garbles the glyphs (lowercase
      // s->S, l->I, ff->"fu", stray accents) even though the underlying text is right — Chrome's viewer
      // dodges this by drawing by glyph-id. When we can identify the font's REAL family (Times New Roman,
      // Arial, Geneva...), render the box through the bundled metric-compatible substitute (pf-tinos /
      // pf-arimo...) instead: correct glyphs, near-identical metrics, and it matches what the SAVE path
      // already emits (more WYSIWYG, not less). Truly-custom embedded fonts (no known family) keep their
      // own face. Non-embedded standard fonts already carry a real @font-face in line.fontCss (unchanged).
      const realKey = mixed ? '' : this._displayFontKey(line.fontFamily, this._realFontName(line));
      div.style.fontFamily = line.fontFamily
        ? this._familyCss(line.fontFamily)
        : mixed
          ? (mixedKey ? this._familyCss(mixedKey) : fallbackFamily)
          : (line.fontCss
            ? `${line.fontCss}, ${fallbackFamily}`
            : (realKey
              ? this._familyCss(realKey)
              : (line.fontName ? `"${line.fontName}", ${fallbackFamily}` : fallbackFamily)));
      // MULTI-LANGUAGE DISPLAY (Phase 1): a line in a NON-LATIN script (Devanagari, Arabic, CJK, Hebrew, Thai,
      // Tamil…) needs a font that covers it — the Latin editor faces render tofu boxes. Prepend the matching
      // bundled Noto face so the script shows and can be typed; the browser lazy-fetches the woff2 only for
      // scripts actually on the page (font-display:swap). Latin lines return '' and are left untouched.
      const boxScript = detectScript(div.textContent || line.text || '');
      const scriptStack = fontStackForScript(boxScript);
      if (scriptStack) div.style.fontFamily = `${scriptStack}, ${div.style.fontFamily}`;
      // Phase 2 bidi: a RIGHT-TO-LEFT line (Arabic/Hebrew) needs dir="rtl" so the caret, character ordering
      // and alignment behave while typing; the browser's bidi algorithm then lays out any embedded Latin/
      // digits correctly. LTR lines (Latin, Indic, CJK) are left untouched.
      if (isRtlScript(boxScript)) { div.dir = 'rtl'; div.style.textAlign = 'right'; }
      div.style.fontWeight = line.bold ? 'bold' : 'normal';
      div.style.fontStyle = line.italic ? 'italic' : 'normal';
      // Show the editable text in the line's REAL colour so the box blends into the page (e.g.
      // white text on a dark headline). A toolbar colour override wins; if text-colour detection
      // failed, fall back to a readable contrast vs the background. (The saved file uses the exact
      // colour regardless.)
      const tc = line.textColor;
      // An OCR-edited/moved box is visible over a solid cover (.ocr-edited), whose CSS forces
      // `color:#111 !important` — set the REAL colour with !important so a coloured OCR line (a brown
      // subtitle) keeps its colour instead of going black. Non-OCR lines set it plainly as before.
      const setCol = (v) => { if (line.ocr && pending) div.style.setProperty('color', v, 'important'); else div.style.color = v; };
      if (line.color) {
        setCol(`rgb(${line.color[0]},${line.color[1]},${line.color[2]})`);
      } else if (tc) {
        setCol(`rgb(${tc[0]},${tc[1]},${tc[2]})`);
      } else {
        const bg = line.bgColor;
        const lum = bg ? (0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]) : 255;
        setCol(lum < 140 ? '#fff' : '#000');
      }
      if (line.underline) div.style.textDecoration = 'underline';
      if (line.opacity != null) div.style.opacity = line.opacity;
      if (line.align) div.style.textAlign = line.align;
      div.style.padding = '0';
      div.style.margin = '0';
      div.style.border = '1px solid transparent';
      // Keep the SOLID cover an edited OCR line set above (line.ocr && pending → white/bgColor): it hides the
      // ORIGINAL glyphs baked into the scan/legacy render so the replacement doesn't read as both at once.
      // Resetting to transparent here undid it on any box built WITHOUT a focus/blur — i.e. the lazy
      // Replace-All repaint (refresh), where the replaced text then doubled over the original (a table on the
      // legacy Hindi book broke this way). Every other line stays transparent so the crisp canvas shows through.
      if (!(line.ocr && pending)) div.style.background = 'transparent';
      // Z-ORDER: OCR word/line boxes can OVERLAP when OCR gives a word a bad, over-wide bbox (a cover heading
      // "यूथ कॉम्प्टीशन टाइम्स कृत" where "कॉम्प्टीशन" was boxed across the whole line) — the wide box then sits
      // ON TOP of the narrow words beside it and swallows their clicks, so those words look "not editable".
      // Put SMALLER boxes on top (higher z, inversely by area) so every word stays clickable; the wide box is
      // still clickable in the gaps it alone covers. Capped below the focus z (200) so a focused box always
      // wins. Non-OCR lines don't overlap, so they keep the flat z=100.
      const boxArea = Math.max(1, widthCss * lineBoxPx);
      div.style.zIndex = line.ocr ? String(100 + Math.max(1, Math.min(95, Math.round(45000 / boxArea)))) : '100';
      // Cursor comes from CSS: `move` while unfocused (hover-drag repositions the line, a plain
      // click edits), `text` once focused — an inline value here would override both states.
      div.style.outline = 'none';
      div.style.boxSizing = 'border-box';
      div.style.whiteSpace = 'pre';        // single line; typing extends to the right
      div.style.overflow = 'visible';

      div.addEventListener('focus', () => {
        div.style.border = '1px solid #4A90E2';
        div.style.boxShadow = '0 0 0 2px rgba(74,144,226,0.25)';
        // Match the line's own background (e.g. dark) instead of forcing white, so editing a
        // white-on-dark headline stays seamless. Falls back to transparent (the canvas cover
        // already shows the real page background underneath).
        div.style.background = line.bgColor
          ? `rgb(${line.bgColor[0]},${line.bgColor[1]},${line.bgColor[2]})`
          : 'transparent';
        div.style.zIndex = '200';
        this.activeEditBox = div;
        div.__displayScale = displayScale;     // lets the toolbar recompute CSS px when size changes
        // Smart mode: focusing a line resolves this click as "edit existing text" — light
        // up the Edit button (stays in auto, so the next click is still smart).
        this._reflectActiveTool('edit');
        // Show the shared floating toolbar anchored to this line.
        this._showTextToolbar({ kind: 'line', el: div, line });
      });

      div.addEventListener('blur', () => {
        div.style.border = '1px solid transparent';
        div.style.boxShadow = 'none';
        div.style.background = 'transparent';
        div.style.zIndex = '100';
        const newText = this.cleanEditableText(div.textContent);
        if (newText !== div.dataset.originalText) {
          this.trackEdit(this.lineToEdit(line, newText, this._readLineRuns(div)));
          div.dataset.originalText = newText;
        }
        // An OCR line carrying a committed edit stays VISIBLE on a solid cover after blur — the
        // generic background reset above would make the replacement transparent again over the scan
        // (which still shows the ORIGINAL printed glyphs → old and new would read at once). Mirrors
        // the save-side cover; findLineEdit also re-arms it when an edited box blurs unchanged.
        if (line.ocr && this.findLineEdit(line)) {
          div.classList.add('ocr-edited');
          const obg = line.bgColor;
          div.style.background = obg ? `rgb(${obg[0]},${obg[1]},${obg[2]})` : '#fff';
        }
        // Drop any lingering text selection so it can't leak into the next mode (Add-text or another
        // line). Partial styling restores the selection WHILE editing; once the box blurs we clear it.
        const sel = window.getSelection();
        if (sel && sel.rangeCount && div.contains(sel.getRangeAt(0).commonAncestorContainer)) sel.removeAllRanges();
      });

      // Keep each box a single line: Enter commits the edit instead of adding a line. Escape exits the
      // edit (blurs) too — so "press Escape, then add text elsewhere" works and the box isn't left focused.
      div.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); div.blur(); }
        else if (e.key === 'Escape') { e.preventDefault(); div.blur(); }
      });

      canvasWrapper.appendChild(div);
      // Drag / arrow-key repositioning (grip + move mode) — see features/moveLines.js.
      this._initLineMove(div, line, pv, displayScale);
    });
  },
  /**
   * EXACT per-char ink colours for a page ([{x, y, rgb 0..1, size}], PDF units, y-down), from the
   * document opened once in the mupdf worker. Cached per document + page; resolves null whenever
   * mupdf can't run here (unsupported browser, worker/WASM failure) so callers fall back to canvas
   * sampling — the pre-existing behaviour.
   */
  _pageInkChars(pageNum) {
    const bytes = this.originalFileData;
    if (!bytes || !MupdfService.isSupported()) return Promise.resolve(null);
    if (this._inkFor !== bytes) {                    // new/edited document → replace the open ink doc
      const stale = this._inkOpenP;
      if (stale) stale.then((r) => r && MupdfService.inkClose(r.docId)).catch(() => {});
      this._inkFor = bytes;
      this._inkOpenP = MupdfService.inkOpen(bytes).catch(() => null);
      this._inkPageCache = new Map();
    }
    if (!this._inkPageCache.has(pageNum)) {
      // pv.pageNum is 0-based, same as mupdf's loadPage index.
      this._inkPageCache.set(pageNum, this._inkOpenP
        .then((r) => (r && pageNum >= 0 && pageNum < r.pages) ? MupdfService.inkPage(r.docId, pageNum) : null)
        .catch(() => null));
      // LRU cap: per-page char/image payloads for a 1000+ page doc would otherwise accumulate
      // unbounded as the user scrolls. Maps iterate in insertion order → first key is oldest.
      while (this._inkPageCache.size > 60) {
        this._inkPageCache.delete(this._inkPageCache.keys().next().value);
      }
    }
    return this._inkPageCache.get(pageNum);
  },
  /**
   * LAZY-editable docs: hydrate ONE page's text geometry + links on demand (the eager path
   * extracts every page up front at load). Called by the windowed painter before building the
   * page's boxes; concurrent calls for the same page share one promise. Extracted pages stay —
   * items are small (text + numbers), it's the CANVASES that blow the memory budget.
   */
  _ensurePageExtracted(pv) {
    if (!this.lazyEditMode) return Promise.resolve();
    if (!this._extractedPages) this._extractedPages = new Set();
    if (this._extractedPages.has(pv.pageNum)) return Promise.resolve();
    if (!this._extractingPages) this._extractingPages = new Map();
    if (!this._extractingPages.has(pv.pageNum)) {
      // Idempotent: drop any stale entries for this page first (e.g. a rotation bake already
      // re-extracted it via reextractPage) so a second pass can never double the page's items.
      this.extractedTextItems = (this.extractedTextItems || []).filter((t) => t.pageIndex !== pv.pageNum);
      this.extractedLinks = (this.extractedLinks || []).filter((l) => l.pageIndex !== pv.pageNum);
      const p = this._extractPageText(pv.pageNum, pv.page, pv.page.getViewport({ scale: this.scale }))
        .then(() => { this._extractedPages.add(pv.pageNum); })
        .catch((e) => console.warn('lazy text extraction failed for page', pv.pageNum + 1, e))
        .finally(() => this._extractingPages.delete(pv.pageNum));
      this._extractingPages.set(pv.pageNum, p);
    }
    return this._extractingPages.get(pv.pageNum);
  },
  /**
   * The exact ink colour (0-255 RGB) of ONE line item: the majority per-char colour whose origin
   * falls inside the item's horizontal span near the line's baseline (canvas px ÷ scale = PDF units,
   * both y-down/top-left). Null when no char maps to the item.
   */
  _itemInkColor(inkChars, line, it) {
    const s = this.scale || 1;
    const x0 = it.left / s - 1, x1 = it.right / s + 1;
    const yb = line.baseline / s;
    const tol = Math.max(2.5, ((line.bottom - line.top) / s) * 0.45);
    const votes = new Map();
    for (const ch of inkChars) {
      if (ch.x < x0 || ch.x > x1 || Math.abs(ch.y - yb) > tol) continue;
      const c = ch.rgb.map((v) => Math.max(0, Math.min(255, Math.round(v * 255))));
      const k = c.join(',');
      const cur = votes.get(k);
      votes.set(k, cur ? [cur[0] + 1, c] : [1, c]);
    }
    let best = null, n = 0;
    for (const [, [cnt, c]] of votes) if (cnt > n) { n = cnt; best = c; }
    return best;
  },
  /**
   * Convert a line (canvas-pixel geometry) into the edit descriptor the backend expects:
   * PDF points with a TOP-LEFT origin (x, right, top, bottom, baseline).
   */
  /** The pre-existing PDF hyperlink overlapping `line` (canvas px), or null. */
  _lineLink(line) {
    for (const lk of (this.extractedLinks || [])) {
      if (lk.pageIndex !== line.pageIndex) continue;
      if (lk.left < line.right && lk.right > line.left && lk.top < line.bottom && lk.bottom > line.top) {
        return { uri: lk.uri };
      }
    }
    return null;
  },
  /**
   * Expand the edit list with PRESERVE edits for segments entangled with an edited line. Two runs
   * that share a baseline and overlap horizontally (a form fill-in written ON a blank — the exact
   * layout the overlay grouping keeps as separate boxes) are inseparable at redaction time: mupdf
   * removes every RUN whose glyphs intersect the edited line's rect, so editing the sentence would
   * silently DELETE the fill-in from the saved page (and vice versa). For each replace edit, any
   * same-row segment overlapping its band is re-added as an identical-text edit (redact + redraw at
   * its own position), transitively. Returns a NEW array — this.edits / undo history are untouched.
   */
  _withEntangledPreserves(edits) {
    try {
      const isReplace = (e) => e && e.redact !== false && e.kind !== 'erase' && e.baseline != null && e.newText != null;
      const out = edits.slice();
      const matches = (a, b) => a.pageIndex === b.pageIndex &&
        Math.abs(a.x - b.x) < 1.5 && Math.abs(a.baseline - b.baseline) < 1.5;
      const queue = out.filter(isReplace);
      while (queue.length) {
        const e = queue.pop();
        const pv = (this.pageViews || []).find(v => v && v.pageNum === e.pageIndex);
        const segs = (pv && pv._segments) || [];
        const s = this.scale || 1;
        for (const seg of segs) {
          if (!seg.text || !seg.text.trim()) continue;
          const st = seg.top / s, sb = seg.bottom / s, sx = seg.left / s, sr = seg.right / s;
          // Same ROW only: substantial vertical overlap. Mere band-touching neighbours above/below
          // are already protected by the redaction clamp and must NOT be redrawn (font drift).
          const vOv = Math.min(sb, e.bottom) - Math.max(st, e.top);
          if (vOv < 0.55 * Math.min(sb - st, e.bottom - e.top)) continue;
          if (sx >= e.right - 0.5 || sr <= e.x + 0.5) continue;   // and horizontal overlap
          const runs = (seg.styleRuns && seg.styleRuns.length > 1)
            ? seg.styleRuns.map(r => ({ text: r.text, bold: !!r.bold, italic: !!r.italic,
                underline: !!r.underline, color: r.color || null, family: r.family || null }))
            : null;
          const pe = this.lineToEdit(seg, seg.text, runs);
          if (out.some(x => isReplace(x) && matches(x, pe))) continue;   // already edited/preserved
          pe._autoPreserve = true;
          out.push(pe);
          queue.push(pe);                                   // transitive closure over chained overlaps
        }
      }
      if (out.length !== edits.length) {
        console.info(`[QPE] save: re-adding ${out.length - edits.length} run(s) entangled with edited lines`);
      }
      return out;
    } catch (err) {
      console.warn('entangled-preserve skipped:', err);
      return edits;
    }
  },
  /** A SCANNED page whose visible text is baked into a near-full-page background IMAGE, with a (usually
   *  invisible) text layer on top — e.g. a "searchable scan". Editing such a line redacts the text-layer
   *  run but NOT the image ink (mupdf redaction is REDACT_IMAGE_NONE), so the scan's ORIGINAL glyphs bleed
   *  through the replacement and overlap it. True when an image covers most of the page → the save must
   *  COVER the original line area first (same as an OCR edit). */
  _isScanBackdropPage(pv) {
    if (!pv || !pv.canvas || !Array.isArray(pv._pageImages) || !pv._pageImages.length) return false;
    const s = this.scale || 1;
    const area = pv.canvas.width * pv.canvas.height;
    if (area <= 0) return false;
    return pv._pageImages.some((im) => ((im.x1 - im.x0) * s) * ((im.y1 - im.y0) * s) > 0.5 * area);
  },
  lineToEdit(line, newText, runs) {
    const s = this.scale;
    // SCANNED-HYBRID cover: if this line sits over a full-page scan image, its printed glyphs live in the
    // image and survive redaction — mark the edit so the save covers the original area (see mupdfEdit
    // `e.coverScan`), else edit + scan text overlap. Skipped for OCR lines (already covered via `ocr`).
    const _cpv = (this.pageViews || []).find((v) => v.pageNum === line.pageIndex);
    const coverScan = !line.ocr && this._isScanBackdropPage(_cpv);
    // Keep the SAVE's substitute font consistent with the EDITOR's display. When the line's real font
    // resolves to a known family, take serif-ness from THAT (Arial/Geneva -> sans, Times -> serif)
    // instead of the glyph-shape guess in line.serif — which misreads a broken-cmap subset: a sans
    // Geneva line was flagged serif, so an edit saved in Times (serif) while its unedited neighbours
    // stayed sans, making the edited line look wrong / smaller. No toolbar override and no resolvable
    // family -> keep the detected flag (unchanged behaviour).
    let editSerif = !!line.serif;
    if (!line.fontFamily) {
      const fk = this._displayFontKey(null, this._realFontName(line));
      if (fk) { const css = this._familyCss(fk); editSerif = css.includes('serif') && !css.includes('sans-serif'); }
    }
    const edit = {
      pageIndex: line.pageIndex,
      x: line.left / s,
      right: line.right / s,
      top: line.top / s,
      bottom: line.bottom / s,
      baseline: line.baseline / s,
      fontSize: line.fontSizePx / s,
      bold: !!line.bold,
      italic: !!line.italic,
      // ROTATED existing text: the run's angle (degrees, CSS-clockwise) so the save re-emits the same
      // text-matrix rotation the original had. Both save engines already draw rotated text from this.
      ...(line.rotated && line.angle ? { rotation: line.angle * 180 / Math.PI } : {}),
      // The user EXPLICITLY toggled bold/italic in the toolbar → honour it verbatim on save (so a
      // bold/italic line can be turned OFF); without this the engine's missed-bold recovery re-adds it.
      ...(line.boldSet ? { boldSet: true } : {}),
      ...(line.italicSet ? { italicSet: true } : {}),
      serif: editSerif,
      // OCR line: its "original text" is INK IN THE SCAN IMAGE (nothing to redact) — the save must
      // COVER the printed area with the background before drawing the replacement (or nothing, for a
      // deletion), else the old and new text overlap on the image.
      ...(line.ocr ? { ocr: true } : {}),
      // Scanned-hybrid page: cover the baked scan glyphs before drawing the replacement (see coverScan above).
      ...(coverScan ? { coverScan: true } : {}),
      bgColor: line.bgColor || null,   // [r,g,b] cell background (so a cover box matches, not white)
      newText: newText,
      // Floating-toolbar styling applied to this line (all optional; absent == unchanged).
      ...(line.underline ? { underline: true } : {}),
      // Removing an underline: tell the backend to cover the previously-baked rule even though no
      // fresh underline is drawn (else the old line-art survives redaction -> underline won't clear).
      ...(line._coverUnderline ? { coverUnderline: true } : {}),
      // Colour: an explicit toolbar override wins; otherwise an OCR line must fall back to its SAMPLED
      // ink colour (line.textColor). A normal edited line recovers its colour from the PDF's own text run
      // at save time, but an OCR overlay has NO real text under it (the glyphs live in the scan image), so
      // without this the edit draws BLACK over the cover — the brown/coloured line loses its colour.
      // Gated on line.ocr so non-OCR docs are completely unchanged.
      ...((line.color || (line.ocr && line.textColor)) ? { color: line.color || line.textColor } : {}),
      ...(line.opacity != null && line.opacity < 1 ? { opacity: line.opacity } : {}),
      ...(line.align ? { align: line.align } : {}),
      ...(line.fontFamily ? { fontFamily: line.fontFamily } : {}),
      ...(line.sizeOverridden ? { sizeOverride: true } : {}),
      // Hyperlink over the WHOLE line (tracks the area only; does not restyle the text).
      ...(line.link ? { link: line.link } : {}),
      ...(line.linkRemoved ? { linkRemoved: true } : {}),
    };
    // SUPERSCRIPT retype: the line HAD a raised ordinal ("Jan 19ᵗʰ") but the edited content came back
    // flat (select-all + retype destroys the spans). If the new text still contains an ordinal, re-split
    // it so the suffix keeps the original superscript geometry — otherwise editing a date silently
    // flattens its "th" to full-size text. Partial edits keep their spans and never reach this.
    if (!line.linkRange && line.styleRuns && line.styleRuns.some(r => r.sup) &&
        (!runs || !runs.some(r => r.sup))) {
      const m = /^([\s\S]*?\d)(st|nd|rd|th)(?![A-Za-z])([\s\S]*)$/i.exec(newText || '');
      if (m) {
        const meta = line.styleRuns.find(r => r.sup) || {};
        runs = [{ text: m[1] },
          { text: m[2], sup: true, supRatio: meta.supRatio || 0.65, supRaise: meta.supRaise || 0.33 },
          ...(m[3] ? [{ text: m[3] }] : [])];
      }
    }
    // MIXED style: a per-run model [{text,bold,italic,underline}] (a bold label + a regular tail, a
    // partial underline) so each run keeps its style on save. Sent only when there's real text and
    // >1 run; the linkRange path below (a partial hyperlink) builds its own runs and takes priority.
    if (runs && runs.length > 1 && !line.linkRange) {
      edit.runs = [runs.map(r => ({ text: r.text, bold: !!r.bold, italic: !!r.italic,
        ...(r.underline ? { underline: true } : {}),
        ...(r.color ? { color: r.color } : {}),                 // partial colour change (per-run)
        ...(r.family ? { fontFamily: r.family } : {}),          // partial font change (per-run, catalogue key)
        // SUPERSCRIPT run → concrete save units: its own font size (pts) + baseline raise (pts, up).
        ...(r.sup ? { sup: true,
          size: +(((line.fontSizePx / s) || 12) * (r.supRatio || 0.65)).toFixed(2),
          raise: +(((line.fontSizePx / s) || 12) * (r.supRaise || 0.33)).toFixed(2) } : {}),
        ...(r.link ? { link: r.link } : {}) }))];               // partial hyperlink (per-run)
    }
    // PARTIAL hyperlink: split the line into runs so only the selected range is linked + blue/underlined.
    if (line.linkRange) {
      const t = newText || '';
      const a = Math.max(0, Math.min(line.linkRange.start, t.length));
      const b = Math.max(a, Math.min(line.linkRange.end, t.length));
      if (b > a) {
        const seg = [];
        if (a > 0) seg.push({ text: t.slice(0, a) });
        seg.push({ text: t.slice(a, b), color: LINK_BLUE, underline: true, link: line.linkRange.uri });
        if (b < t.length) seg.push({ text: t.slice(b) });
        edit.runs = [seg.filter(r => r.text)];
        edit.linkRange = line.linkRange;     // kept so the partial style re-renders on rebuild
      }
    }
    return edit;
  },
  /**
   * Group text items that share a baseline into a single line. All geometry is in
   * canvas pixels (top-origin), as produced by extractTextFromPDFjs().
   */
  groupTextItemsByLine(textItems) {
    if (textItems.length === 0) return [];

    // Order left-to-right within a row using the SAME tolerance the merge loop uses below
    // (max(3, height*0.4)); a smaller sort threshold (the old hard-coded 3px) ordered items 3–4px
    // apart in baseline by baseline instead of by x, so a right-column value could sort AHEAD of a
    // left-column one — the row then built right-to-left and the column split (below) missed it.
    // Use the LARGER of the two heights (not the smaller): a SUPERSCRIPT ordinal ("Jan 19ᵗʰ, 2023")
    // is a small, RAISED run — "th" (h≈9.75) sits ~5.7px above the "Jan 19" baseline (h15). With the
    // smaller height the tol was 9.75·0.4≈3.9 < 5.7, so "th" counted as a different row and sorted
    // AHEAD of "Jan 19" → the box read "thJan 19". Sizing the tol by the larger run (15·0.4=6 ≥ 5.7)
    // keeps the superscript on its base row, ordered by x. Identical for uniform rows (min == max).
    const sorted = [...textItems].sort((a, b) => {
      const tol = Math.max(3, Math.max(a.height, b.height) * 0.4);
      if (Math.abs(a.baseline - b.baseline) <= tol) return a.left - b.left;  // same row: left to right
      return a.baseline - b.baseline;                                        // else top to bottom
    });

    const lines = [];
    let currentLine = null;
    const startSegment = (item) => {
      currentLine = {
        text: item.text,
        left: item.left, right: item.right, baseline: item.baseline,
        top: item.top, bottom: item.bottom, height: item.height,
        fontSizePx: item.fontSizePx, fontName: item.fontName,
        fontFamilyName: item.fontFamilyName,
        // ROTATED text carries its own angle (radians, canvas space) so the editable box can mirror the
        // rotation and the save re-emits the same transform matrix. Each rotated run is its OWN line
        // (rotatedBreak below), never merged with horizontal body text — that keeps body lines clean.
        angle: item.angle || 0, rotated: !!item.rotated,
        ocr: !!item.ocr,                                  // OCR overlay line (transparent, no cover strip)
        pageIndex: item.pageIndex, items: [item],
      };
      lines.push(currentLine);
    };

    sorted.forEach(item => {
      const isSpace = !item.text.trim();
      // Size the same-row tolerance by the TALLER of the item and the row it might join, so a small
      // raised SUPERSCRIPT ordinal (the "th" in "Jan 19th") stays on its base row instead of breaking
      // into its own segment. Identical to the old item.height·0.4 when the row and item match height.
      const tol = Math.max(3, (currentLine ? Math.max(item.height, currentLine.height) : item.height) * 0.4);
      const sameRow = currentLine && Math.abs(item.baseline - currentLine.baseline) <= tol;
      const gap = sameRow ? item.left - currentLine.right : 0;
      // A gap far wider than the text is a COLUMN separator (e.g. a right-aligned date or
      // "GPA: …"). Keep each column as its own segment/box so editing one doesn't reflow the
      // others and right-aligned items stay in place. Measure the gap in EITHER direction: when two
      // columns share ~a baseline the sort can still place the right one first, so the left one
      // arrives with item.left < currentLine.right (a NEGATIVE forward gap) — the one-directional
      // test missed that and concatenated the columns (address "NH - 03060" + Work-State "NH" ->
      // "NHNH - 03060"). max(forward, backward) catches the reversed order too.
      const hGap = sameRow ? Math.max(item.left - currentLine.right, currentLine.left - item.right) : 0;
      // Measure the column gap against the SMALLER of the two text scales (identical for uniform rows).
      // Against the incoming item's own height alone, a much TALLER intruder set a huge threshold and
      // swallowed the row: an OCR'd diagonal banner glyph ("4th" read as a 44px "KZ") merged into a
      // 13px text line 40px away — then EDITING that line covered the banner too (the "4th" vanished).
      const colH = currentLine ? Math.min(item.height, currentLine.height || item.height) : item.height;
      const columnBreak = sameRow && !isSpace && hGap > colH * 1.8;
      // A leading bullet glyph (its own fragment) stays a SEPARATE segment, so editing the text
      // never moves, resizes, or re-renders the bullet and the text keeps its original indent.
      const bulletBreak = sameRow && !isSpace && currentLine &&
        /^[•◦▪●‣⁃∙·‧]\s*$/.test(currentLine.text);
      // A run that starts well INSIDE the span the row has already covered is an OVERLAY — a form
      // fill-in written ON TOP of a blank (a company name over "____(“Company”)", a date over
      // "Date: ____"). Concatenating it displaced the value to the END of the line (even off the
      // page edge); keep it a separate segment at its own x so the editor shows it exactly where
      // the PDF renders it, and each piece edits independently. Normal flow never overlaps the
      // accumulated span by more than kerning (≪ 0.6·height), so this only fires on true overlays.
      const overlayBreak = sameRow && !isSpace &&
        (currentLine.right - item.left) > Math.min(item.height, currentLine.height) * 0.6 &&
        item.left > currentLine.left + 1;

      // A ROTATED run never merges with anything: each rotated item is its own single-run line (kept
      // separate from horizontal text and from other rotated runs, whose baselines march diagonally).
      const rotatedBreak = !!item.rotated || !!(currentLine && currentLine.rotated);
      if (!sameRow || columnBreak || bulletBreak || overlayBreak || rotatedBreak) {
        if (isSpace) return;            // never start a segment on a stray space
        startSegment(item);
        return;
      }

      // Same segment: keep the PDF's own spaces (whitespace fragments are preserved during
      // extraction) and only synthesise a space across a small positional gap.
      if (isSpace) {
        // A whitespace fragment carries its OWN advance width. A wide gap is often a single space
        // glyph with a large advance (e.g. the address "9 Royal Crest Dr   Apt 8" — the gap between
        // "Dr" and "Apt" is one space item ~3× a normal space wide). Reproduce it as proportional
        // spaces so the editor box shows the SAME gap the PDF renders; a normal space stays one.
        const spW = item.height * 0.28;
        const w = (item.right - item.left) || 0;
        const n = w > spW * 1.6 ? Math.max(1, Math.min(24, Math.round(w / spW))) : 1;
        if (n > 1) currentLine.text = currentLine.text.replace(/ +$/, '') + ' '.repeat(n);
        else if (!/\s$/.test(currentLine.text)) currentLine.text += ' ';
        return;
      }
      const endSp = /\s$/.test(currentLine.text);
      const startSp = /^\s/.test(item.text);
      // Synthesise spaces PROPORTIONAL to the positional gap between fragments, so the editor's box
      // shows the SAME spacing the PDF renders. A single space collapsed a wide tab-gap (e.g. an
      // address "9 Royal Crest Dr   Apt 8"), so the editor looked packed while the saved output kept
      // the gap — a WYSIWYG mismatch. Space advance ≈ 0.28·font-height; cap the run so a huge
      // right-aligned gap (a separate column that slipped the column-break) can't explode the text.
      let sep = '';
      if (!endSp && !startSp) {
        if (gap > item.height * 0.18) {
          const spaceW = item.height * 0.28;
          sep = ' '.repeat(Math.max(1, Math.min(24, Math.round(gap / spaceW))));
        } else if (item.ocr) {
          // OCR items are whole WORDS — always separate two adjacent words with a single space even when
          // their recognised boxes touch or slightly overlap (Devanagari word boxes are often tight, so the
          // positional-gap test above misses them and the box reads "wordword"). PDF.js glyph fragments keep
          // their own kerning, so only the OCR overlay needs this guaranteed word break.
          sep = ' ';
        }
      }
      currentLine.text += sep + item.text;
      currentLine.left = Math.min(currentLine.left, item.left);
      currentLine.right = Math.max(currentLine.right, item.right);
      currentLine.top = Math.min(currentLine.top, item.top);
      currentLine.bottom = Math.max(currentLine.bottom, item.bottom);
      currentLine.height = Math.max(currentLine.height, item.height);
      currentLine.items.push(item);
    });

    // Tidy each reconstructed segment and drop any that ended up being only whitespace.
    // Normalise tabs/newlines to a single space and trim the ends, but KEEP internal multi-space
    // runs so a synthesised wide gap survives — a plain /\s+/ -> ' ' collapse erased it and made the
    // editor box look packed while the saved PDF kept the gap (a WYSIWYG mismatch). Cap runaway runs.
    lines.forEach(line => {
      line.text = line.text.replace(/[^\S ]+/g, ' ').replace(/ {25,}/g, ' '.repeat(24)).trim();
    });
    const realLines = lines.filter(line => line.text.length > 0);
    realLines.forEach(line => this.finalizeLineStyle(line));
    return realLines;
  },
  /**
   * Decide a line's font size and weight from its items. The size is the one used by the
   * MOST characters (so a stray small glyph like a "•" bullet can't shrink the whole line),
   * and bold/italic apply when the majority of characters are bold/italic.
   */
  finalizeLineStyle(line) {
    const buckets = new Map();   // rounded height -> { chars, height }
    let boldChars = 0, italicChars = 0, serifChars = 0, totalChars = 0;
    for (const it of line.items) {
      if (!(it.text || '').trim()) continue;   // ignore space-only fragments for font sizing
      const n = Math.max(1, (it.text || '').trim().length);
      totalChars += n;
      if (it.bold) boldChars += n;
      if (it.italic) italicChars += n;
      if (it.serif) serifChars += n;
      const key = Math.round(it.height * 2) / 2;
      const b = buckets.get(key) || { chars: 0, height: it.height };
      b.chars += n;
      b.height = Math.max(b.height, it.height);
      buckets.set(key, b);
    }
    let best = null;
    for (const b of buckets.values()) if (!best || b.chars > best.chars) best = b;
    if (best) line.fontSizePx = best.height;
    line.bold = totalChars > 0 && boldChars * 2 > totalChars;
    line.italic = totalChars > 0 && italicChars * 2 > totalChars;
    line.serif = totalChars > 0 && serifChars * 2 >= totalChars;
  },
  /**
   * Correct each line's bold/italic from PDF.js's loaded font objects (authoritative) before we
   * style the editable overlay. Mirrors the backend: only adopt a style when the WHOLE line is
   * uniformly that style, so a mixed line (bold label + regular body) isn't forced bold; and only
   * ADDS a style (never clears a correctly-detected one). Keeps the in-edit preview matching what
   * the save produces. No-op for lines whose fonts PDF.js hasn't resolved.
   */
  refineLineStylesFromPdfjs(pv, lines) {
    lines.forEach((line) => {
      const items = (line.items || []).filter(it => (it.text || '').trim());
      if (!items.length) return;
      let known = 0, boldAll = true, italicAll = true;
      for (const it of items) {
        const st = fontStyleFromPdfjs(pv, it.fontName);
        if (st) {
          known++;
          // Adopt the authoritative per-item weight/slant (never clears a name-detected style), so
          // the per-run model below and the editor preview both match what the save produces.
          it.bold = it.bold || st.bold;
          it.italic = it.italic || st.italic;
        }
        if (!it.bold) boldAll = false;
        if (!it.italic) italicAll = false;
      }
      if (known === items.length) {        // every item's font was resolvable -> trust it
        if (boldAll) line.bold = true;
        if (italicAll) line.italic = true;
      }
      // Reuse PDF.js's own font family for the line so the overlay matches the page exactly.
      const head = fontStyleFromPdfjs(pv, line.fontName);
      if (head && head.css) line.fontCss = head.css;
    });
  },
  /**
   * Clear all editable text boxes
   */
  clearEditableTextBoxes() {
    const container = document.getElementById('canvasContainer');
    if (container) container.querySelectorAll('.editable-text-box, .qpe-move-grip, .qpe-snap-guide').forEach(el => el.remove());
    this.editableTextBoxes = [];
    this.activeEditBox = null;
  },
};
