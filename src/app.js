import { EditorController } from './core/EditorController.js';
import { PDFBackendService } from './services/pdfBackendService.js';
import { initMerge } from './merge.js';
import { PDFDocument, StandardFonts, rgb, degrees, BlendMode } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import { AnnotationManager } from './annotationManager.js';
import { SIGN_FONTS, FONT_CATALOG, FONT_BY_KEY, TOOLBAR_FONT_KEYS, LINK_BLUE } from './util/fontCatalog.js';
import { buildPlatform } from './platform/detect.js';
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
import { RestrictionMethods } from './core/restrictions.js';
import { LineStyleMethods } from './core/lineStyle.js';
import { FontPickerMethods } from './core/fontPicker.js';
import { TextSanitizeMethods } from './core/textSanitize.js';
import { PageOpsMethods } from './features/pageOps.js';

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
    // Platform adapter (desktop vs mobile) — resolved ONCE here and injected; shared code calls
    // this.platform.* hooks and never branches on device type. See src/platform/.
    this.platform = buildPlatform(this);
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
          // Rotation of this text run (combined viewport+text matrix). Horizontal text ≈ 0; a rotated
          // run (e.g. a baked, rotated "Add text" after a backend save) is non-zero. Used to skip
          // editable line-boxes for rotated text, which can't be represented by a horizontal box and
          // would otherwise paint a phantom second layer over the rotated rendering.
          const rotated = Math.abs(Math.atan2(tx[1], tx[0])) > 0.05;
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
            serif: serif,
            rotated: rotated
          });
        });
    }

    console.log('PDF.js extracted', this.extractedTextItems.length, 'text items (canvas px)');
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
    // Dynamic clicking model: existing text is editable in EVERY editing mode (Edit, Add, and smart/auto)
    // so a click on a line always edits it, regardless of which tool button is "locked". Only the
    // read-only large-file 'view' mode (and non-text tools) omit the per-line boxes.
    if (this.mode === 'edit' || this.mode === 'auto' || this.mode === 'text') this.createEditableTextBoxes(pv);
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







  // ----- Undo / redo (snapshots of this.edits) -----

  // ----- Erase tool (drag a rectangle to white-out content) -----

  // ---------------------------------------------------------------------------
  // Pages manager: a drawer of page thumbnails the user can reorder (drag),
  // delete (hover trash), or extend with blank pages. Each operation rebuilds the
  // document with pdf-lib and reloads it, so the thumbnails, the scrollable page
  // view, and the eventual Save output all stay in lockstep automatically.
  // ---------------------------------------------------------------------------

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


Object.assign(PDFEditorApp.prototype, NavigationMethods, HistoryMethods, StampMethods, EraseMethods, PagesPanelMethods, SignatureMethods, InsertEditorMethods, SaveServiceMethods, PageRendererMethods, TextEditingMethods, FileIOMethods, TextToolbarMethods, ModeManagerMethods, AnnotateToolbarMethods, RestrictionMethods, LineStyleMethods, PageOpsMethods, FontPickerMethods, TextSanitizeMethods);

// Initialize the app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.pdfEditorApp = new PDFEditorApp();   // exposed so Merge can clear the open doc
  initMerge();   // wire up the client-side "Merge PDF" feature (self-contained)
  // Register the offline service worker (caches the app shell + mupdf .wasm + edit-fonts) so editing works
  // offline across sessions. Best-effort — a failure here must never block the app.
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
});
