// Inline text editing — build/clear editable line boxes, group pdf.js text into lines, detect+refine per-line style, convert a line to an edit.
// Assembled onto PDFEditorApp.prototype (mixin); verbatim from app.js (this = the app).
import { rgb } from 'pdf-lib';
import { sampleLineColors } from '../util/canvas.js';
import { rgbCss } from '../util/color.js';
import { fontStyleFromPdfjs } from '../util/fonts.js';
import { LINK_BLUE } from '../util/fontCatalog.js';

export const TextEditingMethods = {
  /**
   * Overlay an editable box on EACH line of text. Every box sits exactly on its original
   * line (same left, baseline and size) and edits that line in place. Only the lines the
   * user actually changes are tracked, so saving leaves all other text untouched.
   */
  createEditableTextBoxes(pv) {
    // Skip ROTATED pages: the per-line edit boxes are laid out in the page's unrotated text space, so
    // on a rotated render they land garbled/overlapping. Existing-text editing is therefore disabled
    // on rotated pages — Add text, Highlight, Sign, Stamp and Erase still work (they map clicks live).
    if (((pv.page && pv.page.rotate) || 0) % 360 !== 0) return;
    // Skip ROTATED text runs (e.g. a rotated "Add text" baked into the PDF by a backend save, then
    // re-extracted on the post-save reload). A horizontal edit box can't represent rotated text, and
    // drawing one would paint a phantom second layer over the rotated rendering (the "two layers of
    // add text" bug). Rotated text stays as its baked rendering; other lines remain editable.
    const pageTextItems = this.extractedTextItems.filter(item => item.pageIndex === pv.pageNum && !item.rotated);
    if (pageTextItems.length === 0) return;

    const canvasWrapper = pv.wrapper;
    // The canvas may be displayed smaller than its intrinsic pixels (max-width:100%).
    const displayScale = (pv.canvas.clientWidth || pv.canvas.width) / pv.canvas.width;

    const lines = this.groupTextItemsByLine(pageTextItems);

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
      const fillSolid = () => {
        const c = line.bgColor;
        pv.ctx.fillStyle = c ? `rgb(${c[0]},${c[1]},${c[2]})` : '#ffffff';
        pv.ctx.fillRect(lx, ly, lw, lh);
      };
      try {
        if (sy < 0 || lw <= 0 || lh <= 0) throw new Error('no source strip');
        if (this._coverStripState(pv.ctx, lx, sy, lw, band, line.bgColor) === 'dirty') fillSolid();
        else pv.ctx.drawImage(pv.canvas, lx, sy, lw, band, lx, ly, lw, lh);   // stretch clean bg strip
      } catch (e) {
        fillSolid();
      }
    });
    pv.ctx.restore();

    lines.forEach((line) => {
      const div = document.createElement('div');
      div.contentEditable = 'true';
      div.className = 'editable-text-box';
      // If this line was already edited, show the edited text (so edits persist on re-render).
      const pending = this.findLineEdit(line);
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
        line.styleRuns = (pending.runs && pending.runs.length && !pending.linkRange) ? pending.runs[0] : null;
      }
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
      div.style.left = (leftCss - 1) + 'px';
      div.style.top = (topCss - 1) + 'px';
      div.style.minWidth = Math.max(widthCss, 20) + 'px';   // width:auto -> grows with text
      div.style.height = (lineBoxPx + 2) + 'px';
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
      div.style.fontFamily = line.fontFamily
        ? this._familyCss(line.fontFamily)
        : mixed
          ? (mixedKey ? this._familyCss(mixedKey) : fallbackFamily)
          : (line.fontCss
            ? `${line.fontCss}, ${fallbackFamily}`
            : (line.fontName ? `"${line.fontName}", ${fallbackFamily}` : fallbackFamily));
      div.style.fontWeight = line.bold ? 'bold' : 'normal';
      div.style.fontStyle = line.italic ? 'italic' : 'normal';
      // Show the editable text in the line's REAL colour so the box blends into the page (e.g.
      // white text on a dark headline). A toolbar colour override wins; if text-colour detection
      // failed, fall back to a readable contrast vs the background. (The saved file uses the exact
      // colour regardless.)
      const tc = line.textColor;
      if (line.color) {
        div.style.color = `rgb(${line.color[0]},${line.color[1]},${line.color[2]})`;
      } else if (tc) {
        div.style.color = `rgb(${tc[0]},${tc[1]},${tc[2]})`;
      } else {
        const bg = line.bgColor;
        const lum = bg ? (0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]) : 255;
        div.style.color = lum < 140 ? '#fff' : '#000';
      }
      if (line.underline) div.style.textDecoration = 'underline';
      if (line.opacity != null) div.style.opacity = line.opacity;
      if (line.align) div.style.textAlign = line.align;
      div.style.padding = '0';
      div.style.margin = '0';
      div.style.border = '1px solid transparent';
      div.style.background = 'transparent';
      div.style.zIndex = '100';
      div.style.cursor = 'text';
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

      div.addEventListener('blur', (e) => {
        // The click that BLURS (exits) an existing-text edit must NOT also chain-open a fresh Add-text box
        // on that same click — same guard the insert editor uses, keyed on the event timestamp so a slow
        // re-render can't slip it past the window. A later deliberate click still adds text.
        this._lastInsertCommitAt = e.timeStamp;
        div.style.border = '1px solid transparent';
        div.style.boxShadow = 'none';
        div.style.background = 'transparent';
        div.style.zIndex = '100';
        const newText = this.cleanEditableText(div.textContent);
        if (newText !== div.dataset.originalText) {
          this.trackEdit(this.lineToEdit(line, newText, this._readLineRuns(div)));
          div.dataset.originalText = newText;
        }
      });

      // Keep each box a single line: Enter commits the edit instead of adding a line.
      div.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); div.blur(); }
      });

      canvasWrapper.appendChild(div);
    });
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
  lineToEdit(line, newText, runs) {
    const s = this.scale;
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
      // The user EXPLICITLY toggled bold/italic in the toolbar → honour it verbatim on save (so a
      // bold/italic line can be turned OFF); without this the engine's missed-bold recovery re-adds it.
      ...(line.boldSet ? { boldSet: true } : {}),
      ...(line.italicSet ? { italicSet: true } : {}),
      serif: !!line.serif,
      bgColor: line.bgColor || null,   // [r,g,b] cell background (so a cover box matches, not white)
      newText: newText,
      // Floating-toolbar styling applied to this line (all optional; absent == unchanged).
      ...(line.underline ? { underline: true } : {}),
      // Removing an underline: tell the backend to cover the previously-baked rule even though no
      // fresh underline is drawn (else the old line-art survives redaction -> underline won't clear).
      ...(line._coverUnderline ? { coverUnderline: true } : {}),
      ...(line.color ? { color: line.color } : {}),
      ...(line.opacity != null && line.opacity < 1 ? { opacity: line.opacity } : {}),
      ...(line.align ? { align: line.align } : {}),
      ...(line.fontFamily ? { fontFamily: line.fontFamily } : {}),
      ...(line.sizeOverridden ? { sizeOverride: true } : {}),
      // Hyperlink over the WHOLE line (tracks the area only; does not restyle the text).
      ...(line.link ? { link: line.link } : {}),
      ...(line.linkRemoved ? { linkRemoved: true } : {}),
    };
    // MIXED style: a per-run model [{text,bold,italic,underline}] (a bold label + a regular tail, a
    // partial underline) so each run keeps its style on save. Sent only when there's real text and
    // >1 run; the linkRange path below (a partial hyperlink) builds its own runs and takes priority.
    if (runs && runs.length > 1 && !line.linkRange) {
      edit.runs = [runs.map(r => ({ text: r.text, bold: !!r.bold, italic: !!r.italic,
        ...(r.underline ? { underline: true } : {}),
        ...(r.color ? { color: r.color } : {}),                 // partial colour change (per-run)
        ...(r.family ? { fontFamily: r.family } : {}),          // partial font change (per-run, catalogue key)
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

    const sorted = [...textItems].sort((a, b) => {
      if (Math.abs(a.baseline - b.baseline) < 3) return a.left - b.left;  // same line: left to right
      return a.baseline - b.baseline;                                     // else top to bottom
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
        pageIndex: item.pageIndex, items: [item],
      };
      lines.push(currentLine);
    };

    sorted.forEach(item => {
      const isSpace = !item.text.trim();
      const tol = Math.max(3, item.height * 0.4);
      const sameRow = currentLine && Math.abs(item.baseline - currentLine.baseline) <= tol;
      const gap = sameRow ? item.left - currentLine.right : 0;
      // A gap far wider than the text is a COLUMN separator (e.g. a right-aligned date or
      // "GPA: …"). Keep each column as its own segment/box so editing one doesn't reflow the
      // others and right-aligned items stay in place.
      const columnBreak = sameRow && !isSpace && gap > item.height * 1.8;
      // A leading bullet glyph (its own fragment) stays a SEPARATE segment, so editing the text
      // never moves, resizes, or re-renders the bullet and the text keeps its original indent.
      const bulletBreak = sameRow && !isSpace && currentLine &&
        /^[•◦▪●‣⁃∙·‧]\s*$/.test(currentLine.text);

      if (!sameRow || columnBreak || bulletBreak) {
        if (isSpace) return;            // never start a segment on a stray space
        startSegment(item);
        return;
      }

      // Same segment: keep the PDF's own spaces (whitespace fragments are preserved during
      // extraction) and only synthesise a space across a small positional gap.
      if (isSpace) {
        if (!/\s$/.test(currentLine.text)) currentLine.text += ' ';
        return;
      }
      const endSp = /\s$/.test(currentLine.text);
      const startSp = /^\s/.test(item.text);
      const needSpace = !endSp && !startSp && gap > item.height * 0.18;
      currentLine.text += (needSpace ? ' ' : '') + item.text;
      currentLine.left = Math.min(currentLine.left, item.left);
      currentLine.right = Math.max(currentLine.right, item.right);
      currentLine.top = Math.min(currentLine.top, item.top);
      currentLine.bottom = Math.max(currentLine.bottom, item.bottom);
      currentLine.height = Math.max(currentLine.height, item.height);
      currentLine.items.push(item);
    });

    // Tidy each reconstructed segment and drop any that ended up being only whitespace.
    lines.forEach(line => { line.text = line.text.replace(/\s+/g, ' ').trim(); });
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
    if (container) container.querySelectorAll('.editable-text-box').forEach(el => el.remove());
    this.editableTextBoxes = [];
    this.activeEditBox = null;
  },
};
