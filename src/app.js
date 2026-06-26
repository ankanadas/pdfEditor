import { EditorController } from './core/EditorController.js';
import { PDFBackendService } from './services/pdfBackendService.js';
import { initMerge } from './merge.js';
import { PDFDocument, StandardFonts, rgb, degrees, BlendMode } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import { AnnotationManager } from './annotationManager.js';
import { loadImage, imageRatio } from './util/image.js';
import { hexToRgb, rgbCss, rgbToHex } from './util/color.js';
import { readRegion, sampleLineColors, trimCanvas, roundRectPath } from './util/canvas.js';
import { confirmDialog } from './util/dialog.js';
import { fontStyleFromPdfjs, familyKeyFromFont } from './util/fonts.js';
import { NavigationMethods } from './render/navigation.js';
import { HistoryMethods } from './core/history.js';
import { StampMethods } from './features/stamps.js';
import { EraseMethods } from './features/erase.js';
import { PagesPanelMethods } from './features/pagesPanel.js';
import { SignatureMethods } from './features/signature.js';
import { InsertEditorMethods } from './features/insertEditor.js';
import { SaveServiceMethods } from './core/saveService.js';
import { PageRendererMethods } from './render/pageRenderer.js';
import { TextEditingMethods } from './core/textEditing.js';
import { FileIOMethods } from './core/fileIO.js';
import { TextToolbarMethods } from './features/textToolbar.js';
import { ModeManagerMethods } from './core/modeManager.js';
import { AnnotateToolbarMethods } from './features/annotateToolbar.js';

// Self-host the PDF.js worker (bundled by webpack) instead of loading it from a CDN.
// No external network request is made, so the app works fully offline and never reaches
// out to a third party while handling your document.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.js',
  import.meta.url
).toString();

// Largest PDF a user may open/edit. Change this single number to adjust the limit.
// Note: very large PDFs are slower to render/save since everything runs in the browser.
// Mirrors the backend MAX_PDF_MB so an oversized file is rejected here with a friendly
// message instead of bouncing off the server with a 413.

class PDFEditorApp {
  constructor() {
    this.controller = new EditorController();
    this.pageViews = [];   // one {pageNum, page, viewport, canvas, ctx, wrapper} per page
    this.currentPage = 0;  // page currently in view (for the indicator / page nav)
    this.mode = null; // 'auto' (smart: edit-on-text / add-on-blank), 'edit', 'text', 'erase', 'stamp'
    this.pageWidth = 612; // Standard US Letter width in points
    this.pageHeight = 792; // Standard US Letter height in points
    this.scale = 1.5; // Increased for better visibility
    this.pdfJsDoc = null; // PDF.js document for rendering
    this.originalFileData = null; // Store original file data
    this.originalFile = null; // Store original File object for backend
    this.extractedTextItems = []; // Store extracted text items with positions (from PyMuPDF backend)
    this.editableTextBoxes = []; // Array of editable text box overlays
    this.activeEditBox = null; // Currently active edit box
    this.edits = []; // All pending edits (line replaces, inserts, erases)
    this.insertOverlays = []; // Draggable/resizable overlays for added text & signatures
    this.history = [[]]; // Undo/redo snapshots of this.edits
    this.historyIndex = 0;
    this.isRendering = false; // Prevent multiple simultaneous renders
    this.isCreatingTextBoxes = false; // Prevent duplicate text box creation
    this.eventListenersInitialized = false; // Prevent duplicate event listeners
    this.selectedThumb = null;  // Pages panel: currently selected thumbnail index (for "insert after")
    this._pageOpBusy = false;   // Guard so page reorder/delete/insert don't overlap
    this.selectedInsert = null; // The added-text box currently selected
    this._ttTarget = null;      // Active target of the shared floating text toolbar (editor/overlay/line)
    this._lastInsertSize = 14;  // Remembered font size for the next "Add text" box
    
    this.annotationManager = new AnnotationManager(this);

    this.initializeEventListeners();
    this.setupControllerEvents();
    
    console.log('PDF Editor App initialized (runs entirely in your browser)');
  }

  initializeEventListeners() {
    if (this.eventListenersInitialized) {
      console.warn('Event listeners already initialized, skipping');
      return;
    }
    
    console.log('Initializing event listeners');
    this.eventListenersInitialized = true;
    
    // File input
    document.getElementById('fileInput').addEventListener('change', (e) => {
      this.handleFileSelect(e);
    });

    // Mode buttons
    document.getElementById('textModeBtn').addEventListener('click', () => {
      console.log('Edit Text button clicked');
      this.setMode('text');
    });

    document.getElementById('editModeBtn').addEventListener('click', () => {
      console.log('Edit Text button clicked');
      this.setMode('edit');
    });

    document.getElementById('signatureModeBtn').addEventListener('click', () => {
      this.openSignFlow();  // saved signatures? show the picker; otherwise open the Draw/Type/Image dialog
    });
    // Signature picker: "Add new signature" opens the dialog; outside-click / Esc / scroll dismiss it.
    document.getElementById('signPickerAdd')?.addEventListener('click', () => { this.closeSignPicker(); this.openSignPad(); });
    document.addEventListener('click', (e) => {
      if (!this._signPickerOpen) return;
      if (e.target.closest && (e.target.closest('#signPicker') || e.target.closest('#signatureModeBtn'))) return;
      this.closeSignPicker();
    });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this._signPickerOpen) this.closeSignPicker(); });
    window.addEventListener('resize', () => { if (this._signPickerOpen) this.positionSignPicker(); });

    document.getElementById('eraseModeBtn')?.addEventListener('click', () => {
      this.setMode('erase');
    });

    document.getElementById('stampModeBtn')?.addEventListener('click', () => {
      this.setMode('stamp');
    });

    document.getElementById('annotateModeBtn')?.addEventListener('click', () => {
      this.setMode('annotate');
    });
    // Editing-restriction gate: on a document with owner permissions that forbid modification, the
    // FIRST click that would start an edit on a page asks the user to confirm they're authorised.
    // We listen in the CAPTURE phase on both mousedown (blocks focusing an existing-text box and the
    // erase drag) and click (blocks add-text / stamp via handleCanvasClick) so the interaction is
    // stopped before any editor opens. _confirmEditAllowed only shows the prompt once; once confirmed
    // the gate is a no-op and editing proceeds normally for the rest of the session.
    const editGate = (e) => {
      if (this._restrictionConfirmed || !this._editRestricted) return;
      if (!(e.target instanceof Element) || !e.target.closest('.page-wrap')) return;
      e.preventDefault();
      e.stopPropagation();
      this._confirmEditAllowed();
    };
    const stageEl = document.getElementById('stage');
    stageEl?.addEventListener('mousedown', editGate, true);
    stageEl?.addEventListener('click', editGate, true);

    // Stamp picker chips: choose which stamp to drop on the next page click.
    this.activeStamp = null;
    document.querySelectorAll('.stamp-chip').forEach(chip => {
      chip.addEventListener('click', () =>
        this.selectStampChip(chip, { label: chip.dataset.label, color: chip.dataset.color }));
    });
    // Upload a custom stamp image -> adds a selectable thumbnail chip.
    document.getElementById('customStampInput')?.addEventListener('change', (e) => this.onCustomStampUpload(e));

    // Clear signature button
    document.getElementById('clearSignatureBtn').addEventListener('click', () => {
      this.clearSignature();
    });

    // Undo / redo
    document.getElementById('undoBtn')?.addEventListener('click', () => this.undo());
    document.getElementById('redoBtn')?.addEventListener('click', () => this.redo());
    window.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const t = e.target;
      const editable = t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
      if (editable) return;  // let the browser's native undo work while typing in a field/box
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); this.redo(); }
    });

    // Save button
    document.getElementById('saveBtn').addEventListener('click', () => {
      this.savePDF();
    });

    // Page navigation
    document.getElementById('prevPageBtn')?.addEventListener('click', () => {
      this.previousPage();
    });

    document.getElementById('nextPageBtn')?.addEventListener('click', () => {
      this.nextPage();
    });

    // Per-page canvas click & erase-drag listeners are attached in buildPages().
    // Global move/up so an erase drag keeps tracking outside the page canvas.
    window.addEventListener('mousemove', (e) => this.onEraseMove(e));
    window.addEventListener('mouseup', (e) => this.onEraseEnd(e));

    // Track which page is in view (for the page indicator) as the stage scrolls.
    document.getElementById('stage')?.addEventListener('scroll', () => this.updateCurrentPageFromScroll());

    // Add-text size / bold / italic. When an editor box is open these restyle its current
    // selection (or the next typed text); otherwise they set the defaults for the next box.
    const addBold = document.getElementById('addBold');
    const addItalic = document.getElementById('addItalic');
    const addSize = document.getElementById('addSize');
    // Keep the editor focused (and its selection live) when clicking B / I.
    [addBold, addItalic].forEach(btn => btn?.addEventListener('mousedown', (e) => {
      if (this._activeInsertEditor) e.preventDefault();
    }));
    addBold?.addEventListener('click', () => {
      if (this._activeInsertEditor) this._activeInsertEditor.applyStyle('bold', !this._activeInsertEditor.style().bold);
      else addBold.classList.toggle('on');
    });
    addItalic?.addEventListener('click', () => {
      if (this._activeInsertEditor) this._activeInsertEditor.applyStyle('italic', !this._activeInsertEditor.style().italic);
      else addItalic.classList.toggle('on');
    });
    addSize?.addEventListener('input', () => {
      const v = parseInt(addSize.value, 10);
      if (!v) return;
      if (this._activeInsertEditor) this._activeInsertEditor.applyStyle('size', v);
      else this._lastInsertSize = Math.max(4, Math.min(200, v));
    });

    // Shared contextual floating text toolbar (one toolbar for Edit + Add text).
    this._initTextToolbar();

    // Signature dialog (Draw / Type / Image)
    document.getElementById('signPadClear')?.addEventListener('click', () => this.signPadClear());
    document.getElementById('signPadCancel')?.addEventListener('click', () => this.closeSignPad());
    document.getElementById('signPadAdd')?.addEventListener('click', () => this.signPadAdd());
    this.initSignatureDialog();

    // Annotation toolbar wiring
    this._initAnnotateToolbar();

    // Pages manager (reorder / delete / insert blank pages)
    document.getElementById('pagesPanelBtn')?.addEventListener('click', () => this.togglePagesPanel());
    document.getElementById('pagesPanelClose')?.addEventListener('click', () => this.closePagesPanel());
    document.getElementById('pagesBackdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'pagesBackdrop') this.closePagesPanel();   // click outside the drawer
    });
    document.getElementById('insertBlankBtn')?.addEventListener('click', () => this.insertBlankPage());
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closePagesPanel(); });
  }

  setupControllerEvents() {
    this.controller.on('loaded', (data) => {
      console.log('PDF loaded event received:', data);
      this.showStatus(`PDF loaded successfully! ${data.pageCount} page(s)`, 'success');
      this.updatePageInfo();
      this.enableUiAfterLoad();
      this.updateModeIndicator();
      
      // Don't auto-select edit mode - let user choose
      console.log('PDF loaded, waiting for user to select mode');
    });

    this.controller.on('saved', () => {
      this.showStatus('PDF saved successfully!', 'success');
    });

    this.controller.on('error', (data) => {
      // Only show error if we don't have a fallback (PDF.js loaded)
      if (!this.pdfJsDoc) {
        console.error('Controller error:', data);
        this.showStatus(`Error: ${data.message}`, 'error');
      } else {
        // We have PDF.js as fallback, just log the error
        console.warn('Controller error (using fallback):', data);
      }
    });
  }

  /**
   * Extract text geometry from PDF.js using the SAME viewport transform that paints
   * the canvas. Every value is stored in canvas (device) pixels at this.scale, so the
   * editable overlays line up exactly with the rendered page on every document.
   *
   * For a text item, tx = viewport.transform ∘ item.transform maps text space to canvas
   * pixels: tx[4] is the left edge, tx[5] is the baseline (top-origin), and hypot(tx[2],
   * tx[3]) is the font height in pixels. item.width is in PDF points, so * scale = px.
   */
  async extractTextFromPDFjs() {
    console.log('Extracting text geometry from all pages using PDF.js...');
    this.extractedTextItems = [];
    this.extractedLinks = [];   // pre-existing PDF hyperlinks (canvas px, top-origin) -> shown as linked

    for (let pageNum = 0; pageNum < this.pdfJsDoc.numPages; pageNum++) {
      const page = await this.pdfJsDoc.getPage(pageNum + 1);
      const viewport = page.getViewport({ scale: this.scale });
      const textContent = await page.getTextContent();
      const styles = textContent.styles || {};

      // Capture existing URI link annotations so the toolbar can show/edit/remove them. rect is in PDF
      // points (bottom-left origin); convertToViewportRectangle maps it to canvas px (top-origin).
      try {
        for (const a of await page.getAnnotations()) {
          const uri = a.url || a.unsafeUrl || '';
          if (a.subtype !== 'Link' || !uri || !a.rect) continue;
          const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(a.rect);
          this.extractedLinks.push({ pageIndex: pageNum, uri,
            left: Math.min(x1, x2), right: Math.max(x1, x2), top: Math.min(y1, y2), bottom: Math.max(y1, y2) });
        }
      } catch (_) { /* annotations optional */ }

      textContent.items
        // Keep whitespace-only fragments too: many PDFs emit spaces as their own items,
        // and dropping them is what made tightly-set text lose its word breaks on edit.
        .filter(item => item.str && item.str.length > 0)
        .forEach(item => {
          const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
          const left = tx[4];
          const baseline = tx[5];
          const fontHeightPx = Math.hypot(tx[2], tx[3]) || (item.height * this.scale);
          const widthPx = item.width * this.scale;
          const ascent = fontHeightPx * 0.8;
          const descent = fontHeightPx * 0.2;

          // Best-effort weight/style/family detection from the font name + family.
          const fam = (((styles[item.fontName] || {}).fontFamily || '') + ' ' + (item.fontName || '')).toLowerCase();
          const bold = /bold|black|heavy|semibold|cmbx/.test(fam);
          const italic = /italic|oblique|cmti|cmsl/.test(fam);
          const isSans = /sans|helvetica|arial|verdana|calibri|segoe|roboto|tahoma|cmss/.test(fam);
          const serif = !isSans && /serif|times|roman|georgia|garamond|cmr|cmbx|cmti|cmsl|charter|minion/.test(fam);

          this.extractedTextItems.push({
            text: item.str,
            pageIndex: pageNum,
            left: left,
            right: left + widthPx,
            baseline: baseline,
            top: baseline - ascent,
            bottom: baseline + descent,
            width: widthPx,
            height: fontHeightPx,
            fontSizePx: fontHeightPx,
            fontName: item.fontName || 'Helvetica',
            fontFamilyName: fam,             // css family + loaded name, for the toolbar's font guess
            bold: bold,
            italic: italic,
            serif: serif
          });
        });
    }

    console.log('PDF.js extracted', this.extractedTextItems.length, 'text items (canvas px)');
  }

  /** True if an error from PDF.js indicates the document is password-protected/encrypted. */
  _isPasswordError(err) {
    if (!err) return false;
    const name = err.name || '', msg = err.message || '';
    return name === 'PasswordException' || /password/i.test(msg) || /encrypt/i.test(msg);
  }

  /**
   * Show the password prompt for an encrypted PDF and resolve with the entered password, or
   * null if the user cancels. `incorrect` shows the "wrong password, try again" hint. The
   * password is used in-memory only (handed to PDF.js / the backend) — never stored or logged.
   */
  promptPassword(incorrect = false) {
    return new Promise((resolve) => {
      const backdrop = document.getElementById('pwBackdrop');
      const form = document.getElementById('pwForm');
      const input = document.getElementById('pwInput');
      const errEl = document.getElementById('pwError');
      const cancelBtn = document.getElementById('pwCancel');
      if (!backdrop || !form || !input || !cancelBtn) { resolve(null); return; }

      if (errEl) { errEl.hidden = !incorrect; errEl.textContent = 'Incorrect password. Please try again.'; }
      input.value = '';
      backdrop.hidden = false;
      setTimeout(() => input.focus(), 30);

      const cleanup = () => {
        backdrop.hidden = true;
        form.removeEventListener('submit', onSubmit);
        cancelBtn.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey);
      };
      const onSubmit = (e) => {
        e.preventDefault();
        const v = input.value;
        if (!v) { if (errEl) { errEl.hidden = false; errEl.textContent = 'Please enter a password.'; } return; }
        cleanup(); resolve(v);
      };
      const onCancel = () => { cleanup(); resolve(null); };
      const onKey = (e) => { if (e.key === 'Escape') onCancel(); };

      form.addEventListener('submit', onSubmit);
      cancelBtn.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey);
    });
  }

  /**
   * True if the loaded document carries owner-level editing restrictions — i.e. it is encrypted with
   * a permissions dictionary that does NOT grant "modify contents" (a permission-only / empty-user-
   * password PDF that opens without prompting). A real-password PDF the user unlocked is decrypted to
   * an unrestricted copy, so it returns false (they already proved authorisation).
   */
  async _detectEditRestriction() {
    try {
      const perms = await this.pdfJsDoc.getPermissions();
      if (!perms) return false;   // no permissions dictionary -> unrestricted
      const MODIFY = (pdfjsLib.PermissionFlag && pdfjsLib.PermissionFlag.MODIFY_CONTENTS) || 0x08;
      return !perms.includes(MODIFY);
    } catch (_) {
      return false;
    }
  }

  /**
   * Gate the first edit on a restricted document. Resolves true if editing may proceed: immediately
   * when the document isn't restricted or the user already confirmed; otherwise it shows a one-time
   * authorisation confirmation and resolves with the user's choice (remembered for the session).
   */
  async _confirmEditAllowed() {
    if (!this._editRestricted || this._restrictionConfirmed) return true;
    if (this._restrictionPromptOpen) return false;          // a prompt is already on screen
    this._restrictionPromptOpen = true;
    const ok = await confirmDialog(
      'This document contains editing restrictions. By continuing, you confirm that you are authorized to modify this document.',
      { title: 'Editing restrictions', okText: 'Continue', cancelText: 'Cancel' }
    );
    this._restrictionPromptOpen = false;
    if (ok) this._restrictionConfirmed = true;
    return ok;
  }

  /** Rebuild the HTML overlay layer for ONE page only — no pdf.js canvas re-render, and no loop
   *  over the whole document. Used when an edit only touches a single page's overlay layer (e.g.
   *  placing or deleting a signature). refresh()'s loop over every page (clearing + recreating
   *  overlays, each forcing a layout reflow via canvas.clientWidth) was the multi-second lag on
   *  long documents; touching just the affected page makes it instant regardless of page count. */
  refreshPageOverlays(pv) {
    if (!pv) return;
    // Drop this page's overlay nodes from the shared registry, then rebuild just this page.
    this.insertOverlays = this.insertOverlays.filter(el => !pv.wrapper.contains(el));
    this.clearPageOverlays(pv);
    this.createInsertOverlays(pv);
    if (this.mode === 'edit' || this.mode === 'auto') this.createEditableTextBoxes(pv);
  }

  /**
   * Classify the source strip used to hide a text line: 'clean' (uniform background close to the
   * cell's own colour — safe to stretch), 'dirty' (a border / rule / adjacent glyph passes through,
   * so stretching it would paint a dark "shadow" band — fill solid instead) or 'unknown' (pixel
   * readback unavailable — keep the legacy drawImage behaviour). Coordinates are device pixels.
   */
  _coverStripState(ctx, x, y, w, h, bg) {
    if (!bg) return 'unknown';                       // no sampled bg (readback failed earlier) -> legacy
    let d;
    try { d = ctx.getImageData(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h))).data; }
    catch (e) { return 'unknown'; }
    const bgL = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
    let sum = 0, n = 0; const vals = [];
    for (let i = 0; i < d.length; i += 4) { const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; vals.push(l); sum += l; n++; }
    if (!n) return 'unknown';
    const mean = sum / n;
    let q = 0; for (const l of vals) q += (l - mean) * (l - mean);
    const std = Math.sqrt(q / n);
    // Not uniform (a line/glyph runs through it) OR materially darker than the cell's own background.
    if (std > 24 || mean < bgL - 22) return 'dirty';
    return 'clean';
  }


  /**
   * Detect a drawn underline under each item of a line by probing the rendered canvas (PDF.js draws
   * underlines as a thin line, not a font attribute, so they aren't in the text items). Reads ONE
   * strip just below the line's baseline, then per item looks for a long, THIN, contiguous run of ink
   * spanning most of the item's width — an underline — while rejecting glyph descenders (short runs)
   * and solid fills/shading (ink across many rows). Sets it.underline; returns true if any item is
   * underlined. Must run on the CLEAN canvas, before the line is covered. Best-effort: any failure
   * (e.g. a tainted canvas) just leaves underlines undetected.
   *
   * Crucially it rejects a horizontal RULE/DIVIDER that merely passes under the text: a real underline
   * ends with the text, but a page divider/section rule/table border continues past the text on the
   * left and/or right. The strip is read with a margin on each side, and any candidate rule row that
   * still has ink in that outside margin is treated as a divider, NOT an underline — so editing a
   * heading sitting just above a divider never mistakes the divider for an underline (which would make
   * the save cover-and-redraw it at the new text width and visibly break the line).
   */
  _detectLineUnderlines(pv, line, bg) {
    try {
      const items = (line.items || []).filter(it => (it.text || '').trim());
      if (!items.length) return false;
      const cw = pv.canvas.width, ch = pv.canvas.height;
      const H = Math.max(6, line.fontSizePx || (line.bottom - line.top));
      const y0 = Math.max(0, Math.floor(line.baseline + H * 0.04));
      const y1 = Math.min(ch, Math.ceil(line.baseline + H * 0.34));
      const margin = Math.max(16, Math.round(H));        // room to see a rule extending past the text
      const x0 = Math.max(0, Math.floor(line.left) - margin);
      const x1 = Math.min(cw, Math.ceil(line.right) + margin);
      const w = x1 - x0, h = y1 - y0;
      if (w < 4 || h < 2) return false;
      const data = readRegion(pv.canvas, x0, y0, w, h);
      const isInk = (i) => {
        if (data[i + 3] < 128) return false;
        if (!bg) return (data[i] + data[i + 1] + data[i + 2]) < 600;       // dark on assumed-light bg
        return (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2])) > 100;
      };
      const rowInk = (py, from, to) => { for (let px = from; px < to; px++) { if (isInk((py * w + px) * 4)) return true; } return false; };
      let any = false;
      for (const it of items) {
        const c0 = Math.max(0, Math.floor(it.left) - x0);
        const c1 = Math.min(w, Math.ceil(it.right) - x0);
        const iw = c1 - c0;
        if (iw < 6) { it.underline = false; continue; }
        // Columns just OUTSIDE the item, where a divider (but not an underline) would still have ink.
        const lFrom = Math.max(0, c0 - margin), lTo = Math.max(0, c0 - 3);
        const rFrom = Math.min(w, c1 + 3), rTo = Math.min(w, c1 + margin);
        let lineRows = 0, inkRows = 0;
        for (let py = 0; py < h; py++) {
          let run = 0, best = 0, inkCols = 0;
          for (let px = c0; px < c1; px++) {
            const i = (py * w + px) * 4;
            if (isInk(i)) { run++; inkCols++; if (run > best) best = run; } else run = 0;
          }
          if (inkCols > 0) inkRows++;
          if (best >= 0.55 * iw) {
            // A near-full-width rule that ALSO has ink in the outside margin is a divider/border, not
            // this text's underline — don't count it.
            const extendsOut = (lTo > lFrom && rowInk(py, lFrom, lTo)) || (rTo > rFrom && rowInk(py, rFrom, rTo));
            if (!extendsOut) lineRows++;
          }
        }
        // Underline = a thin rule (1..4 rows of near-full-width ink), NOT a solid fill (ink in most rows).
        it.underline = lineRows >= 1 && lineRows <= 4 && inkRows <= Math.max(4, h * 0.6);
        if (it.underline) any = true;
      }
      return any;
    } catch (e) {
      return false;
    }
  }

  /**
   * Group a line's items into contiguous style RUNS [{text,bold,italic,underline}] so a mixed line
   * (a bold label + a regular tail, a partly-underlined line) keeps each run's own style when the
   * line is edited and re-saved. Whitespace-only items extend the current run (a space carries no
   * style of its own). Stored on line.styleRuns only when the line genuinely mixes styles AND the
   * runs reconstruct line.text exactly — otherwise left unset so the simple whole-line path (which
   * already preserves a uniform style) runs unchanged. No behaviour change for single-style lines.
   */
  _buildLineStyleRuns(line) {
    const items = (line.items || []);
    if (items.length < 1) return;
    const runs = [];
    let prevRight = null, endsSpace = true;          // start "true" so no leading synth space
    const append = (text, st) => {
      const last = runs[runs.length - 1];
      if (!st && last) { last.text += text; }        // a blank item joins the current run
      else if (last && last.bold === st.b && last.italic === st.i && last.underline === st.u) last.text += text;
      else runs.push({ text, bold: st ? st.b : false, italic: st ? st.i : false, underline: st ? st.u : false });
      if (text) endsSpace = /\s$/.test(text);
    };
    for (const it of items) {
      const t = it.text || '';
      if (!t) continue;
      if (!t.trim()) { append(t, null); prevRight = it.right; continue; }
      // Mirror groupTextItemsByLine: synthesise a space across a positional gap so the runs join back
      // to the same text the simple path would produce (and the safety check below passes).
      if (runs.length && prevRight != null && !endsSpace && !/^\s/.test(t) &&
          (it.left - prevRight) > (it.height || 0) * 0.18) {
        runs[runs.length - 1].text += ' '; endsSpace = true;
      }
      append(t, { b: !!it.bold, i: !!it.italic, u: !!it.underline });
      prevRight = it.right;
    }
    // Need ≥2 distinct styles to be worth a per-run model.
    const distinct = new Set(runs.map(r => `${r.bold}|${r.italic}|${r.underline}`));
    if (runs.length < 2 || distinct.size < 2) return;
    // Safety: the runs must reproduce the line's (normalised) text exactly, else fall back to the
    // simple path rather than risk corrupting the line.
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    if (norm(runs.map(r => r.text).join('')) !== norm(line.text)) return;
    line.styleRuns = runs;
  }

  /** One styled <span> (data-* markers + inline CSS) for a mixed existing-line run. */
  _lineRunSpanHTML(r) {
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const css = [`font-weight:${r.bold ? 'bold' : 'normal'}`, `font-style:${r.italic ? 'italic' : 'normal'}`];
    if (r.underline) css.push('text-decoration:underline');
    const attrs = `data-bold="${r.bold ? 1 : 0}" data-italic="${r.italic ? 1 : 0}"${r.underline ? ' data-underline="1"' : ''}`;
    return `<span ${attrs} style="${css.join(';')}">${esc(r.text)}</span>`;
  }

  /**
   * Read a focused existing-line box back into a single line of style runs [{text,bold,italic,
   * underline}], walking text nodes and inheriting each span's data-* markers. Returns null when the
   * box has no styled spans (a plain, single-style line) so the caller keeps the simple whole-line
   * path. Per-run text is cleaned the same way as the plain path, so the runs join back to newText.
   */
  _readLineRuns(div) {
    if (!div || !div.querySelector('span[data-bold],span[data-italic],span[data-underline]')) return null;
    const runs = [];
    const push = (text, st) => {
      if (!text) return;
      const last = runs[runs.length - 1];
      if (last && last.bold === st.bold && last.italic === st.italic && last.underline === st.underline) last.text += text;
      else runs.push({ text, bold: st.bold, italic: st.italic, underline: st.underline });
    };
    const walk = (node, inh) => {
      node.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) { push(child.nodeValue, inh); return; }
        if (child.nodeType !== Node.ELEMENT_NODE || child.tagName === 'BR') return;
        const st = { ...inh };
        if (child.hasAttribute && child.hasAttribute('data-bold')) st.bold = child.getAttribute('data-bold') === '1';
        else if (child.style && (child.style.fontWeight === 'bold' || parseInt(child.style.fontWeight, 10) >= 600)) st.bold = true;
        if (child.hasAttribute && child.hasAttribute('data-italic')) st.italic = child.getAttribute('data-italic') === '1';
        else if (child.style && child.style.fontStyle === 'italic') st.italic = true;
        if (child.hasAttribute && child.hasAttribute('data-underline')) st.underline = child.getAttribute('data-underline') === '1';
        else if (child.style && /underline/.test(child.style.textDecoration || '')) st.underline = true;
        walk(child, st);
      });
    };
    walk(div, { bold: false, italic: false, underline: false });
    const cleaned = runs.map(r => ({ ...r, text: this.cleanEditableText(r.text) })).filter(r => r.text.length);
    return cleaned.length ? cleaned : null;
  }

  /**
   * Get CSS font family from PDF font name
   */
  getFontFamily(fontName) {
    if (!fontName) return 'Arial, sans-serif';
    
    const fontLower = fontName.toLowerCase();
    if (fontLower.includes('times') || fontLower.includes('serif')) {
      return '"Times New Roman", Times, serif';
    } else if (fontLower.includes('courier') || fontLower.includes('mono')) {
      return '"Courier New", Courier, monospace';
    } else {
      return 'Arial, Helvetica, sans-serif';
    }
  }

  /**
   * Track a per-line edit for saving. If the same line is edited again, the previous
   * edit is replaced. `edit` already carries the line geometry and newText.
   */
  trackEdit(edit) {
    const existingIndex = this.edits.findIndex(e =>
      e.pageIndex === edit.pageIndex &&
      Math.abs(e.x - edit.x) < 1 &&
      Math.abs(e.baseline - edit.baseline) < 1
    );

    if (existingIndex >= 0) {
      this.edits[existingIndex] = edit;
    } else {
      this.edits.push(edit);
    }

    this.commitHistory();
    console.log('Tracked edit:', edit);
    // (No "Updated:" toast for text add/edit — it fired on every keystroke-commit. Page reorder /
    //  merge keep their own success messages.)
  }

  // ─── Annotation toolbar wiring ────────────────────────────────────────────────

  // ----- Signature dialog: Draw / Type / Image -----
  // Fonts offered on the Type tab. Each typed signature is rasterised to an image in the
  // chosen font, so the saved result looks EXACTLY like the preview (no font substitution).
  static get SIGN_FONTS() {
    return [
      '"Snell Roundhand","Savoye LET",cursive',
      '"Brush Script MT","Bradley Hand",cursive',
      '"Apple Chancery","Segoe Script",cursive',
      '"Savoye LET","Snell Roundhand",cursive',
    ];
  }

  /** The full font catalogue shown in the picker: { key, name, tag, css }. `css` is the on-screen
   *  PREVIEW / editor font-family — the proprietary name first (so a user who has it installed sees
   *  it), then the bundled open `pf-*` face (always available, what the PDF actually embeds), then a
   *  generic. The first 10 are the originally-implemented fonts (unchanged); the rest are new. */
  static get FONT_CATALOG() {
    return [
      { key: 'arial', name: 'Arial', tag: 'Sans', css: 'Arial, "pf-arimo", sans-serif' },
      { key: 'helvetica', name: 'Helvetica', tag: 'Sans', css: 'Helvetica, "pf-arimo", Arial, sans-serif' },
      { key: 'times', name: 'Times New Roman', tag: 'Serif', css: '"Times New Roman", "pf-tinos", Times, serif' },
      { key: 'georgia', name: 'Georgia', tag: 'Serif', css: 'Georgia, "pf-gelasio", serif' },
      { key: 'verdana', name: 'Verdana', tag: 'Sans', css: 'Verdana, "pf-arimo", Geneva, sans-serif' },
      { key: 'courier', name: 'Courier New', tag: 'Mono', css: '"Courier New", "pf-cousine", Courier, monospace' },
      { key: 'roboto', name: 'Roboto', tag: 'Sans', css: 'Roboto, "pf-roboto", Arial, sans-serif' },
      { key: 'opensans', name: 'Open Sans', tag: 'Sans', css: '"Open Sans", "pf-open-sans", Arial, sans-serif' },
      { key: 'montserrat', name: 'Montserrat', tag: 'Sans', css: 'Montserrat, "pf-montserrat", Arial, sans-serif' },
      { key: 'comicsans', name: 'Comic Sans MS', tag: 'Script', css: '"Comic Sans MS", "pf-comic-neue", cursive' },
      { key: 'calibri', name: 'Calibri', tag: 'Sans', css: 'Calibri, "pf-carlito", sans-serif' },
      { key: 'tahoma', name: 'Tahoma', tag: 'Sans', css: 'Tahoma, "pf-arimo", sans-serif' },
      { key: 'trebuchet', name: 'Trebuchet MS', tag: 'Sans', css: '"Trebuchet MS", "pf-arimo", sans-serif' },
      { key: 'inter', name: 'Inter', tag: 'Sans', css: 'Inter, "pf-inter", sans-serif' },
      { key: 'lato', name: 'Lato', tag: 'Sans', css: 'Lato, "pf-lato", sans-serif' },
      { key: 'poppins', name: 'Poppins', tag: 'Sans', css: 'Poppins, "pf-poppins", sans-serif' },
      { key: 'nunito', name: 'Nunito', tag: 'Sans', css: 'Nunito, "pf-nunito", sans-serif' },
      { key: 'sourcesans', name: 'Source Sans Pro', tag: 'Sans', css: '"Source Sans Pro", "Source Sans 3", "pf-source-sans-3", sans-serif' },
      { key: 'ubuntu', name: 'Ubuntu', tag: 'Sans', css: 'Ubuntu, "pf-ubuntu", sans-serif' },
      { key: 'ptsans', name: 'PT Sans', tag: 'Sans', css: '"PT Sans", "pf-pt-sans", sans-serif' },
      { key: 'garamond', name: 'Garamond', tag: 'Serif', css: 'Garamond, "pf-eb-garamond", serif' },
      { key: 'cambria', name: 'Cambria', tag: 'Serif', css: 'Cambria, "pf-caladea", serif' },
      { key: 'baskerville', name: 'Baskerville', tag: 'Serif', css: 'Baskerville, "pf-libre-baskerville", serif' },
      { key: 'palatino', name: 'Palatino', tag: 'Serif', css: 'Palatino, "Palatino Linotype", "pf-noto-serif", serif' },
      { key: 'merriweather', name: 'Merriweather', tag: 'Serif', css: 'Merriweather, "pf-merriweather", serif' },
      { key: 'librebaskerville', name: 'Libre Baskerville', tag: 'Serif', css: '"Libre Baskerville", "pf-libre-baskerville", serif' },
      { key: 'playfair', name: 'Playfair Display', tag: 'Serif', css: '"Playfair Display", "pf-playfair-display", serif' },
      { key: 'notoserif', name: 'Noto Serif', tag: 'Serif', css: '"Noto Serif", "pf-noto-serif", serif' },
      { key: 'consolas', name: 'Consolas', tag: 'Mono', css: 'Consolas, "pf-cousine", monospace' },
      { key: 'firacode', name: 'Fira Code', tag: 'Mono', css: '"Fira Code", "pf-fira-code", monospace' },
      { key: 'jetbrainsmono', name: 'JetBrains Mono', tag: 'Mono', css: '"JetBrains Mono", "pf-jetbrains-mono", monospace' },
      { key: 'sourcecodepro', name: 'Source Code Pro', tag: 'Mono', css: '"Source Code Pro", "pf-source-code-pro", monospace' },
      { key: 'ibmplexmono', name: 'IBM Plex Mono', tag: 'Mono', css: '"IBM Plex Mono", "pf-ibm-plex-mono", monospace' },
      { key: 'brushscript', name: 'Brush Script', tag: 'Script', css: '"Brush Script MT", "pf-pacifico", cursive' },
      { key: 'pacifico', name: 'Pacifico', tag: 'Script', css: 'Pacifico, "pf-pacifico", cursive' },
      { key: 'comicneue', name: 'Comic Neue', tag: 'Script', css: '"Comic Neue", "pf-comic-neue", cursive' },
    ];
  }

  static get _FONT_BY_KEY() {
    if (!PDFEditorApp.__fbk) PDFEditorApp.__fbk = Object.fromEntries(PDFEditorApp.FONT_CATALOG.map(f => [f.key, f]));
    return PDFEditorApp.__fbk;
  }

  /** The on-screen font-family for a stored key (editor text + dropdown preview). */
  _familyCss(f) {
    const e = PDFEditorApp._FONT_BY_KEY[(f || '').toLowerCase()];
    if (e) return e.css;
    return ({ serif: '"Times New Roman", "pf-tinos", serif', mono: '"Courier New", "pf-cousine", monospace' })[f]
      || 'Arial, "pf-arimo", sans-serif';
  }

  // Every font-family key the picker offers.
  static get TOOLBAR_FONT_KEYS() { return PDFEditorApp.FONT_CATALOG.map(f => f.key); }

  /** Normalise a stored fontFamily to a catalogue key. Catalogue keys pass through; the legacy
   *  sans/serif/mono map to their nearest entry; anything else -> '' (unknown). */
  _normFamilyKey(fam) {
    const f = (fam || '').toLowerCase();
    if (PDFEditorApp._FONT_BY_KEY[f]) return f;
    return ({ sans: 'arial', serif: 'times', mono: 'courier' })[f] || '';
  }


  /** The catalogue key to SHOW for a target: an explicit family override, else a guess from the PDF
   *  font name, else '' (-> the "Select a Font Style" placeholder). */
  _displayFontKey(fam, fontName) {
    return this._normFamilyKey(fam) || familyKeyFromFont(fontName) || '';
  }

  /** Resolve a text item's REAL font name (e.g. 'Inter Regular', 'Carlito Bold') from PDF.js's font
   *  object. getTextContent only exposes a loaded id ('g_d0_f5') + a generic family, but once a page
   *  has rendered its commonObjs hold the real name — which lets the picker re-show a saved font on
   *  reopen. Returns '' until the font is resolved (then callers fall back to the generic guess). */
  _realFontName(o) {
    if (!o || !o.fontName) return '';
    for (const pv of this.pageViews || []) {
      try {
        const co = pv.page && pv.page.commonObjs;
        if (!co) continue;
        if (typeof co.has === 'function' && !co.has(o.fontName)) continue;
        const f = co.get(o.fontName);
        if (f && f.name) return f.name;
      } catch (_) { /* not resolved on this page yet */ }
    }
    return '';
  }

  // ----- Searchable font picker (built once; the toolbar shows/reuses it) ---------------------------
  _recentFonts() {
    try { return JSON.parse(localStorage.getItem('qpe_recent_fonts') || '[]').filter(k => PDFEditorApp._FONT_BY_KEY[k]); }
    catch (_) { return []; }
  }
  _pushRecentFont(key) {
    if (!PDFEditorApp._FONT_BY_KEY[key]) return;
    const list = [key, ...this._recentFonts().filter(k => k !== key)].slice(0, 5);
    try { localStorage.setItem('qpe_recent_fonts', JSON.stringify(list)); } catch (_) {}
  }

  _initFontPicker() {
    const btn = document.getElementById('tt-font-btn');
    const pop = document.getElementById('tt-font-pop');
    const search = document.getElementById('tt-font-search');
    const list = document.getElementById('tt-font-list');
    const empty = document.getElementById('tt-font-empty');
    if (!btn || !pop || !search || !list || this._fontPickerInit) return;
    this._fontPickerInit = true;

    const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    const open = () => {
      pop.hidden = false; btn.setAttribute('aria-expanded', 'true');
      search.value = ''; this._renderFontList(''); setTimeout(() => search.focus(), 20);
    };
    btn.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden ? open() : close(); });
    search.addEventListener('input', () => this._renderFontList(search.value));
    // Choosing a row applies the font and remembers it.
    list.addEventListener('click', (e) => {
      const opt = e.target.closest('.tt-font-opt'); if (!opt) return;
      const key = opt.dataset.key;
      this.applyTextStyle('family', key);
      this._pushRecentFont(key);
      this._setFontPickerValue(key);
      close();
    });
    // Keyboard: arrows move the active row, Enter selects, Esc closes.
    search.addEventListener('keydown', (e) => {
      const opts = Array.from(list.querySelectorAll('.tt-font-opt'));
      let i = opts.findIndex(o => o.classList.contains('active'));
      if (e.key === 'ArrowDown') { e.preventDefault(); i = Math.min(opts.length - 1, i + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); i = Math.max(0, i - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); if (opts[i < 0 ? 0 : i]) opts[i < 0 ? 0 : i].click(); return; }
      else if (e.key === 'Escape') { close(); btn.focus(); return; }
      else return;
      opts.forEach(o => o.classList.remove('active'));
      if (opts[i]) { opts[i].classList.add('active'); opts[i].scrollIntoView({ block: 'nearest' }); }
    });
    document.addEventListener('click', (e) => { if (!pop.hidden && !e.target.closest('#tt-fontpick')) close(); });
    this.__fontPickerEls = { btn, pop, search, list, empty };
  }

  _renderFontList(filter) {
    const { list, empty } = this.__fontPickerEls || {};
    if (!list) return;
    const q = (filter || '').trim().toLowerCase();
    const cur = document.getElementById('tt-font')?.value || '';
    list.innerHTML = '';
    const optHTML = (f) => {
      const sel = f.key === cur ? ' selected' : '';
      return `<button type="button" class="tt-font-opt${sel}" role="option" data-key="${f.key}" ` +
        `style="font-family:${f.css}"><span>${f.name}</span><span class="tt-font-tag">${f.tag}</span></button>`;
    };
    const match = (f) => !q || f.name.toLowerCase().includes(q) || f.tag.toLowerCase().includes(q);
    let html = '';
    if (!q) {
      const recent = this._recentFonts().map(k => PDFEditorApp._FONT_BY_KEY[k]).filter(Boolean);
      if (recent.length) html += `<div class="tt-font-group">Recently used</div>` + recent.map(optHTML).join('') + `<div class="tt-font-group">All fonts</div>`;
    }
    const shown = PDFEditorApp.FONT_CATALOG.filter(match);
    html += shown.map(optHTML).join('');
    list.innerHTML = html;
    if (empty) empty.hidden = shown.length > 0;
  }

  /** Reflect the current font key on the picker button (rendered in its own face), and update the
   *  hidden #tt-font value-holder the rest of the toolbar reads. '' -> the placeholder. */
  _setFontPickerValue(key, labelOverride) {
    const k = (key || '').toLowerCase();
    const hidden = document.getElementById('tt-font');
    const label = document.getElementById('tt-font-label');
    const e = PDFEditorApp._FONT_BY_KEY[k];
    if (hidden) hidden.value = e ? k : '';
    if (label) {
      label.textContent = e ? e.name : (labelOverride || 'Select a Font Style');
      label.style.fontFamily = e ? e.css : '';
    }
  }

  // Standard hyperlink blue (classic browser link colour).
  static get LINK_BLUE() { return [0, 0, 238]; }

  // ----- Undo / redo (snapshots of this.edits) -----

  // ----- Erase tool (drag a rectangle to white-out content) -----

  // ---------------------------------------------------------------------------
  // Pages manager: a drawer of page thumbnails the user can reorder (drag),
  // delete (hover trash), or extend with blank pages. Each operation rebuilds the
  // document with pdf-lib and reloads it, so the thumbnails, the scrollable page
  // view, and the eventual Save output all stay in lockstep automatically.
  // ---------------------------------------------------------------------------

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

    const order = [];
    for (let i = 0; i < n; i++) {
      order.push({ src: i });
      if (i === afterIndex) order.push({ blank: true, w, h });
    }
    const where = (val === 'end') ? 'at the end' : `after page ${afterIndex + 1}`;
    await this.commitPageOrder(order, `Blank page inserted ${where}.`, 'Adding a blank page…');
  }

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

      // Adopt the rebuilt document as the new baseline and reload everything from it.
      this.originalFileData = bytes;
      const loadingTask = pdfjsLib.getDocument({ data: bytes.slice(0) });
      this.pdfJsDoc = await loadingTask.promise;
      this.edits = [];
      this.resetHistory();
      this.selectedThumb = null;

      await this.extractTextFromPDFjs();
      await this.buildPages();
      this.updatePageInfo();
      this.renderPagesPanel();
      this.showStatus(successMsg, 'success');
    } catch (e) {
      console.error('Page operation failed:', e);
      this.showStatus(`Couldn't update pages: ${e.message}`, 'error');
    } finally {
      this._pageOpBusy = false;
      this._hideBusy();
    }
  }

  /** Show / hide the blocking page-operation loading overlay. */
  _showBusy(msg) {
    const o = document.getElementById('busyOverlay'), m = document.getElementById('busyMsg');
    if (m && msg) m.textContent = msg;
    if (o) o.hidden = false;
  }
  _hideBusy() { const o = document.getElementById('busyOverlay'); if (o) o.hidden = true; }

  /** Build new PDF bytes from the ordered descriptor list using pdf-lib. */
  async applyPageOrder(order) {
    const src = await PDFDocument.load(this.originalFileData, { ignoreEncryption: true });
    const out = await PDFDocument.create();

    // Copy all needed source pages in one pass (preserves their content & annotations).
    const srcIndices = order.filter(o => o.src != null).map(o => o.src);
    const copied = srcIndices.length ? await out.copyPages(src, srcIndices) : [];

    let ci = 0;
    for (const item of order) {
      if (item.src != null) out.addPage(copied[ci++]);
      else out.addPage([item.w || 612, item.h || 792]);   // blank page
    }
    return out.save();
  }

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
  }

  /**
   * Normalise text captured from a contentEditable box. Browsers slip in non-breaking
   * spaces, zero-width characters, soft hyphens, etc. while you type — these have no glyph
   * in a PDF's subset font and save as a missing-glyph box (□). Convert odd spaces to a
   * normal space and drop the invisible characters so saved text is exactly what you typed.
   */
  cleanEditableText(s) {
    return (s || '')
      .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ')  // odd spaces -> normal space
      .replace(/[\u200b\u200c\u200d\u2060\ufeff\u00ad]/g, '')          // zero-width / BOM / soft hyphen
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''); // control characters
  }

  /**
   * Keep only characters the built-in Helvetica (WinAnsi) can render — Latin-1 plus the
   * common typographic extras (• – — ' ' " " … € ™). Anything else becomes '?'.
   */
  sanitizeForStandardFont(s) {
    const extras = new Set(['•', '–', '—', '‘', '’', '“', '”', '…', '€', '™', '©', '®',
      'š', 'ž', 'Š', 'Ž', 'Œ', 'œ', 'Ÿ', 'ƒ', '†', '‡', '‰', '‹', '›']);
    let out = '';
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || extras.has(ch)) out += ch;
      else out += '?';
    }
    return out;
  }

  /**
   * "Discard": drop ALL unsaved changes (added text, signatures, erases, line edits),
   * reverting to the loaded PDF. Undoable. Items already saved into the file are kept.
   */
  async clearSignature() {
    const n = this.edits.length;
    if (n === 0) { this.showStatus('Nothing to discard', 'info'); return; }
    // Confirm first (same warning style as the Merge cancel dialog).
    const ok = await confirmDialog(
      `This removes your ${n} unsaved change${n === 1 ? '' : 's'}. You can still bring them back with Undo.`,
      { title: 'Discard your changes?', okText: 'Discard', cancelText: 'Cancel', danger: true }
    );
    if (!ok) return;
    // Discard ALL unsaved changes (added text, signatures, erases, edits). Undoable.
    this.edits = [];
    this.commitHistory();
    this.renderCurrentPage();
    this.showStatus(`Discarded ${n} unsaved change(s) — press Undo to bring them back`, 'info');
  }

  showStatus(message, type) {
    const status = document.getElementById('status');
    if (!status) return;
    const kind = type || 'info';

    // Build safely (message may contain user text): coloured icon + text.
    status.className = kind;
    status.textContent = '';
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = kind === 'error' ? '!' : kind === 'success' ? '✓' : 'i';
    const span = document.createElement('span');
    span.textContent = message;
    status.append(icon, span);

    // Animate in; shake for errors so they grab attention.
    status.style.display = 'flex';
    void status.offsetWidth;
    status.classList.add('show');
    if (kind === 'error') { void status.offsetWidth; status.classList.add('shake'); }

    clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(() => {
      status.classList.remove('show', 'shake');
      setTimeout(() => { if (!status.classList.contains('show')) status.style.display = 'none'; }, 200);
    }, kind === 'error' ? 6000 : 4000);
  }
}


Object.assign(PDFEditorApp.prototype, NavigationMethods, HistoryMethods, StampMethods, EraseMethods, PagesPanelMethods, SignatureMethods, InsertEditorMethods, SaveServiceMethods, PageRendererMethods, TextEditingMethods, FileIOMethods, TextToolbarMethods, ModeManagerMethods, AnnotateToolbarMethods);

// Initialize the app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.pdfEditorApp = new PDFEditorApp();   // exposed so Merge can clear the open doc
  initMerge();   // wire up the client-side "Merge PDF" feature (self-contained)
});
