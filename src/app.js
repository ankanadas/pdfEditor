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
const MAX_FILE_MB = 30;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;

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

  /** Enable all the tools/controls that require a loaded PDF. */
  enableUiAfterLoad() {
    ['saveBtn', 'textInput', 'prevPageBtn', 'nextPageBtn', 'pagesPanelBtn',
     'editModeBtn', 'textModeBtn', 'signatureModeBtn', 'eraseModeBtn', 'stampModeBtn',
     'annotateModeBtn', 'clearSignatureBtn']
      .forEach(id => { const el = document.getElementById(id); if (el) el.disabled = false; });
    // Warm the edit backend now (free hosts sleep when idle) so it's awake by the time the
    // user saves — avoids the first save silently falling back to client-side. Fire-and-forget.
    PDFBackendService.checkHealth().catch(() => {});
  }

  /** Clear the loaded PDF and return to the empty upload state. Used by the Merge panel
   *  when the user removes the current document (the one open here). */
  closeDocument() {
    this.pdfJsDoc = null;
    this.originalFile = null;
    this.originalFileData = null;
    this.edits = [];
    this.currentPage = 0;
    if (typeof this.resetHistory === 'function') this.resetHistory();
    document.body.classList.remove('has-pdf');
    document.body.removeAttribute('data-mode');
    const container = document.getElementById('canvasContainer');
    if (container) container.innerHTML = '';
    const fileNameEl = document.getElementById('fileName');
    if (fileNameEl) fileNameEl.textContent = '';
    const fileInput = document.getElementById('fileInput');
    if (fileInput) fileInput.value = '';
    const pageInfo = document.getElementById('pageInfo');
    if (pageInfo) pageInfo.textContent = 'No PDF loaded';
    const modeIndicator = document.getElementById('modeIndicator');
    if (modeIndicator) modeIndicator.textContent = 'No PDF loaded';
    this.annotationManager.unmountAll();
    ['saveBtn', 'textInput', 'prevPageBtn', 'nextPageBtn', 'pagesPanelBtn',
     'editModeBtn', 'textModeBtn', 'signatureModeBtn', 'eraseModeBtn', 'stampModeBtn',
     'annotateModeBtn', 'clearSignatureBtn']
      .forEach((id) => { const el = document.getElementById(id); if (el) el.disabled = true; });
    document.querySelectorAll('.tool.active').forEach((el) => el.classList.remove('active'));
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

  async handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Opening a new PDF replaces the current one — warn if there are unsaved edits.
    if (this.edits.length > 0) {
      const proceed = await confirmDialog(
        'Opening a new PDF will discard your unsaved edits. To revert changes instead, use Undo.'
      );
      if (!proceed) { event.target.value = ''; return; }
    }

    // Enforce the size limit before doing any work.
    if (file.size > MAX_FILE_BYTES) {
      const mb = (file.size / (1024 * 1024)).toFixed(1);
      this.showStatus(`That PDF is ${mb} MB — please choose a file under ${MAX_FILE_MB} MB.`, 'error');
      document.body.classList.remove('has-pdf');  // keep the upload screen showing
      event.target.value = '';                     // allow re-selecting after picking a smaller file
      return;
    }
    // Size OK — reveal the editor.
    document.body.classList.add('has-pdf');

    try {
      console.log('File selected:', file.name);
      this.showStatus('Loading PDF...', 'info');

      const fileNameEl = document.getElementById('fileName');
      if (fileNameEl) fileNameEl.textContent = file.name;

      // Store original file; start with a clean edit/undo history for the new document
      this.originalFile = file;
      this.edits = [];
      this.resetHistory();

      // Read file as ArrayBuffer and clone it to prevent detachment
      const arrayBuffer = await file.arrayBuffer();

      // Load into PDF.js for rendering. If the PDF is encrypted, PDF.js invokes onPassword;
      // we prompt the user and capture the working password so the backend can produce a
      // decrypted (unlocked) working copy. Empty-password / permission-only files never trigger
      // onPassword (PDF.js opens them automatically) and behave exactly as before.
      let enteredPassword = '';
      let userCancelledPw = false;
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }); // Clone for PDF.js
      loadingTask.onPassword = (updatePassword, reason) => {
        const incorrect = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
        this.promptPassword(incorrect).then((pw) => {
          if (pw == null) { userCancelledPw = true; try { loadingTask.destroy(); } catch (_) {} }
          else { enteredPassword = pw; updatePassword(pw); }
        });
      };
      try {
        this.pdfJsDoc = await loadingTask.promise;
      } catch (err) {
        // Cancelled password prompt (task destroyed) -> quietly back out of loading.
        if (userCancelledPw || this._isPasswordError(err)) {
          document.body.classList.remove('has-pdf');
          const fn = document.getElementById('fileName'); if (fn) fn.textContent = '';
          this.showStatus('Opening cancelled — the PDF is password-protected.', 'info');
          return;
        }
        throw err;
      }
      console.log('PDF.js loaded PDF');

      // Detect owner editing restrictions on the ORIGINAL document now, before the decrypt step
      // below reloads PDF.js from a permission-free copy (which would otherwise hide the restriction).
      // This covers both permission-only PDFs (open without a password) and password-protected PDFs
      // that ALSO restrict modification — both get the authorisation confirmation before editing.
      const editRestricted = await this._detectEditRestriction();

      // If the user supplied a real password, fetch an unlocked copy from the backend so the
      // edit/save pipeline works on plain bytes (the saved copy is unlocked, by design). If the
      // backend can't be reached, we keep the viewable PDF.js doc and the save chain flattens.
      let workingData = arrayBuffer.slice(0);
      if (enteredPassword) {
        this.showStatus('Unlocking PDF…', 'info');
        try {
          const res = await PDFBackendService.decryptPDF(arrayBuffer.slice(0), enteredPassword);
          if (res.bytes) {
            const dec = res.bytes;
            workingData = dec.buffer.slice(dec.byteOffset, dec.byteOffset + dec.byteLength);
            this.pdfJsDoc = await pdfjsLib.getDocument({ data: dec.slice(0) }).promise;
          } else {
            console.warn('Backend could not unlock the PDF; it will save as a flattened copy.');
          }
        } catch (e) {
          console.warn('Backend decrypt unavailable; protected PDF will save as a flattened copy:', e);
        }
      }
      this.originalFileData = workingData; // Clone the (possibly decrypted) ArrayBuffer

      // Owner/editing-restriction gate: ask the user to confirm they're authorised before their FIRST
      // edit (see _confirmEditAllowed / the stage mousedown gate). Reset the confirmation per document.
      this._editRestricted = editRestricted;
      this._restrictionConfirmed = false;
      
      // Try to load into controller (pdf-lib) for editing - but don't fail if it doesn't work
      try {
        await this.controller.loadPDF(file);
        console.log('Controller loaded PDF');
      } catch (controllerError) {
        console.warn('pdf-lib failed to load PDF, but we can still view and edit:', controllerError);
        // Mark as loaded anyway so we can use text editing
        this.controller.isLoaded = true;
        // Don't show error - backend editing will work fine
        console.log('Using backend-only mode for this PDF');
        
        // Manually enable controls since controller won't emit 'loaded' event
        this.enableUiAfterLoad();
        this.showStatus(`PDF loaded successfully! ${this.pdfJsDoc.numPages} page(s)`, 'success');
      }
      
      // Extract text geometry with PDF.js — the same engine that renders the canvas —
      // so the editable overlays align exactly. The backend is used only when saving.
      await this.extractTextFromPDFjs();

      this.currentPage = 0;
      // Smart default: don't force a tool choice. Set it BEFORE buildPages so the pages render
      // the editable line boxes straight away (the page is immediately interactive — clicking
      // existing text edits it, clicking a blank area adds new text; see setMode/handleCanvasClick).
      // Setting it up front also means a fast tool click during load can't be clobbered by a late
      // mode switch.
      this.setMode('auto');
      await this.buildPages();
      document.getElementById('stage')?.scrollTo({ top: 0 });

    } catch (error) {
      console.error('Error loading PDF:', error);
      
      // Provide more specific error messages
      let errorMessage = 'Failed to load PDF';
      if (error.message.includes('Invalid') || error.message.includes('corrupted')) {
        errorMessage = 'This PDF file appears to be corrupted or in an unsupported format';
      } else if (error.message.includes('password') || error.message.includes('encrypted')) {
        errorMessage = 'This PDF is protected and could not be opened.';
      } else {
        errorMessage = `Failed to load PDF: ${error.message}`;
      }
      
      this.showStatus(errorMessage, 'error');
    }
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
      const viewport = page.getViewport({ scale: this.scale });

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
  }

  /**
   * Re-paint every page's bitmap and rebuild its overlays in place (keeps the DOM and
   * scroll position). Use for edits / mode changes. Alias: renderCurrentPage().
   */
  async refresh() {
    if (!this.pageViews.length) return;
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
        // Edit and smart (auto) modes both expose existing text as per-line editable boxes;
        // every other mode paints committed line edits straight onto the canvas instead.
        const textEditing = this.mode === 'edit' || this.mode === 'auto';
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
  }

  // Back-compat: existing call sites use renderCurrentPage() to mean "refresh overlays".
  renderCurrentPage() { return this.refresh(); }

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

  clearPageOverlays(pv) {
    pv.wrapper.querySelectorAll('.editable-text-box, .insert-overlay').forEach(el => el.remove());
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
   * Overlay an editable box on EACH line of text. Every box sits exactly on its original
   * line (same left, baseline and size) and edits that line in place. Only the lines the
   * user actually changes are tracked, so saving leaves all other text untouched.
   */
  createEditableTextBoxes(pv) {
    const pageTextItems = this.extractedTextItems.filter(item => item.pageIndex === pv.pageNum);
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
    });

    // Hide the original text by copying a CLEAN background strip from just outside each line over
    // the line's box (canvas->canvas drawImage: real page pixels — gradients/dark fills included,
    // GPU-safe, needs no getImageData). This blends the edit box into the page, so editing never
    // shows a white block even when pixel readback for colour sampling isn't available.
    pv.ctx.save();
    pv.ctx.setTransform(1, 0, 0, 1, 0, 0);   // device pixels, regardless of render state
    const cw = pv.canvas.width, ch = pv.canvas.height;
    lines.forEach((line) => {
      const lx = Math.max(0, Math.floor(line.left) - 2);
      const ly = Math.max(0, Math.floor(line.top) - 2);
      const lw = Math.min(cw - lx, Math.ceil(line.right - line.left) + 6);
      const lh = Math.min(ch - ly, Math.ceil(line.bottom - line.top) + 4);
      const band = Math.max(2, Math.round((line.bottom - line.top) * 0.18));
      let sy = ly - band - 2;                                            // clean strip ABOVE the line...
      if (sy < 0) sy = Math.min(ch - band, Math.ceil(line.bottom) + 2);  // ...else just BELOW it
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
            + `<span class="tt-has-link" style="color:${rgbCss(PDFEditorApp.LINK_BLUE)};text-decoration:underline">${esc(shownText.slice(a, b))}</span>`
            + esc(shownText.slice(b));
        }
      } else if (line.styleRuns && line.styleRuns.length) {
        // Mixed-style line: render per-run styled spans so its bold/italic/underline shows while
        // editing and serialises back on commit. (Editing keeps each span's data-* style markers.)
        div.innerHTML = line.styleRuns.map(r => this._lineRunSpanHTML(r)).join('');
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
      div.style.fontFamily = line.fontFamily
        ? this._familyCss(line.fontFamily)
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
      });

      // Keep each box a single line: Enter commits the edit instead of adding a line.
      div.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); div.blur(); }
      });

      canvasWrapper.appendChild(div);
    });
  }

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
  }

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
      serif: !!line.serif,
      bgColor: line.bgColor || null,   // [r,g,b] cell background (so a cover box matches, not white)
      newText: newText,
      // Floating-toolbar styling applied to this line (all optional; absent == unchanged).
      ...(line.underline ? { underline: true } : {}),
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
      edit.runs = [runs.map(r => ({ text: r.text, bold: !!r.bold, italic: !!r.italic, ...(r.underline ? { underline: true } : {}) }))];
    }
    // PARTIAL hyperlink: split the line into runs so only the selected range is linked + blue/underlined.
    if (line.linkRange) {
      const t = newText || '';
      const a = Math.max(0, Math.min(line.linkRange.start, t.length));
      const b = Math.max(a, Math.min(line.linkRange.end, t.length));
      if (b > a) {
        const seg = [];
        if (a > 0) seg.push({ text: t.slice(0, a) });
        seg.push({ text: t.slice(a, b), color: PDFEditorApp.LINK_BLUE, underline: true, link: line.linkRange.uri });
        if (b < t.length) seg.push({ text: t.slice(b) });
        edit.runs = [seg.filter(r => r.text)];
        edit.linkRange = line.linkRange;     // kept so the partial style re-renders on rebuild
      }
    }
    return edit;
  }

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
  }

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
  }


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
   * Clear all editable text boxes
   */
  clearEditableTextBoxes() {
    const container = document.getElementById('canvasContainer');
    if (container) container.querySelectorAll('.editable-text-box').forEach(el => el.remove());
    this.editableTextBoxes = [];
    this.activeEditBox = null;
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

  setMode(mode) {
    console.log('setMode called:', mode, 'current mode:', this.mode);

    const previousMode = this.mode;
    this.mode = mode;
    if (previousMode !== mode) { this.hideTextToolbar(); this.selectedInsert = null; }
    
    const textBtn = document.getElementById('textModeBtn');
    const editBtn = document.getElementById('editModeBtn');
    const sigBtn = document.getElementById('signatureModeBtn');
    const eraseBtn = document.getElementById('eraseModeBtn');
    const stampBtn = document.getElementById('stampModeBtn');
    const annotateBtn = document.getElementById('annotateModeBtn');

    // Highlight the active tool and expose the mode on <body> so the UI (CSS) can
    // show the relevant inputs / cursor for that tool.
    [textBtn, editBtn, sigBtn, eraseBtn, stampBtn, annotateBtn].forEach(btn => btn && btn.classList.remove('active'));
    document.body.dataset.mode = mode || '';

    // Enable / disable the Fabric layers based on whether Annotate is active
    this.annotationManager.setActive(mode === 'annotate');

    if (mode === 'text') {
      textBtn.classList.add('active');
      this.showStatus('Click anywhere on the page, then type. Press Enter for a new line.', 'info');
    } else if (mode === 'edit') {
      editBtn.classList.add('active');
    } else if (mode === 'auto') {
      // Smart mode: no tool is forced. Neither button starts highlighted — the matching
      // one lights up as the user acts (click text → Edit, click blank → Add). The page
      // renders the per-line edit boxes (see refresh) so existing text is directly clickable.
      this.showStatus('Click existing text to edit it, or click a blank area to add text.', 'info');
    } else if (mode === 'erase') {
      if (eraseBtn) eraseBtn.classList.add('active');
    } else if (mode === 'stamp') {
      if (stampBtn) stampBtn.classList.add('active');
    } else if (mode === 'annotate') {
      if (annotateBtn) annotateBtn.classList.add('active');
      // Activate the last-used sub-tool (default to the text highlighter — Draw was removed).
      const lastTool = this._lastAnnotateTool || 'highlight';
      this._activateAnnotateTool(lastTool);
      this.showStatus('Pick a highlight tool, then highlight or click on the page.', 'info');
    }

    // Rebuild overlays for the new mode (edit boxes vs. painted edits) on every page.
    if (previousMode !== mode) this.refresh();
    this.updateModeIndicator();
    // The shared Undo/Redo buttons reflect annotation history in Highlight mode, edit history elsewhere.
    this.updateHistoryButtons();
  }

  /**
   * In smart (auto) mode, mirror the resolved action onto the matching sidebar button
   * WITHOUT leaving auto mode — so the next click is still smart. `which` is 'edit'
   * (clicked existing text) or 'text' (clicked a blank area / added text).
   */
  _reflectActiveTool(which) {
    if (this.mode !== 'auto') return;   // manual modes keep their own button state
    const editBtn = document.getElementById('editModeBtn');
    const textBtn = document.getElementById('textModeBtn');
    [editBtn, textBtn].forEach(b => b && b.classList.remove('active'));
    if (which === 'edit') editBtn?.classList.add('active');
    else if (which === 'text') textBtn?.classList.add('active');
    const indicator = document.getElementById('modeIndicator');
    if (indicator) {
      indicator.textContent = which === 'edit' ? 'Editing Text' : 'Add Text';
      indicator.classList.add('active');
    }
  }

  updateModeIndicator() {
    const indicator = document.getElementById('modeIndicator');
    if (!this.controller.isLoaded) {
      indicator.textContent = 'No PDF loaded';
      indicator.classList.remove('active');
    } else if (this.mode === 'auto') {
      indicator.textContent = 'Edit or Add';
      indicator.classList.add('active');
    } else if (this.mode === 'text') {
      indicator.textContent = 'Add Text';
      indicator.classList.add('active');
    } else if (this.mode === 'edit') {
      indicator.textContent = 'Editing Text';
      indicator.classList.add('active');
    } else if (this.mode === 'erase') {
      indicator.textContent = 'Erase';
      indicator.classList.add('active');
    } else if (this.mode === 'stamp') {
      indicator.textContent = 'Stamp';
      indicator.classList.add('active');
    } else if (this.mode === 'annotate') {
      indicator.textContent = 'Highlight';
      indicator.classList.add('active');
    } else {
      indicator.textContent = 'Pick a tool';
      indicator.classList.remove('active');
    }
  }

  // ─── Annotation toolbar wiring ────────────────────────────────────────────────

  /** Wire up all the annotation sub-tool buttons and option inputs. */
  _initAnnotateToolbar() {
    const SUB_TOOLS = ['freeHighlight', 'highlight', 'line', 'rect', 'circle', 'table'];

    // Sub-tool buttons
    for (const tool of SUB_TOOLS) {
      document.getElementById(`ann-${tool}`)?.addEventListener('click', () => {
        if (this.mode !== 'annotate') this.setMode('annotate');
        this._activateAnnotateTool(tool);
      });
    }

    // Colour: the SAME swatch popover as the text floating toolbar. One colour drives both shape
    // strokes and highlight fills; it persists (lives on annotationManager) across tool switches.
    const am = this.annotationManager;
    this._setColorSwatch(am.strokeColor, 'ann-color-sw');
    this._buildColorPopover('ann-color-btn', 'ann-color-pop', (hex) => {
      am.strokeColor = hex; am.highlightColor = hex;
      this._setColorSwatch(hex, 'ann-color-sw');
      if (this.mode === 'annotate') am.setTool(this._lastAnnotateTool || 'highlight', { strokeColor: hex, highlightColor: hex });
    });

    // Stroke width — persists on the manager.
    document.getElementById('ann-width')?.addEventListener('input', (e) => {
      const w = parseInt(e.target.value, 10);
      am.strokeWidth = w;
      if (this.mode === 'annotate') am.setTool(this._lastAnnotateTool || 'rect', { strokeWidth: w });
    });

    // Highlight opacity — persists on the manager.
    document.getElementById('ann-opacity')?.addEventListener('input', (e) => {
      const op = parseInt(e.target.value, 10) / 100;
      am.highlightOpacity = op;
      if (this.mode === 'annotate') am.setTool(this._lastAnnotateTool || 'highlight', { highlightOpacity: op });
    });

    // Delete selected object (records an undo step via the manager's history).
    document.getElementById('ann-delete')?.addEventListener('click', () => am.deleteSelected());

    // Undo / redo use the SHARED top toolbar buttons (#undoBtn/#redoBtn) — see undo()/redo(), which
    // route to the annotation layer while in annotate mode. Keep those buttons' enabled state in sync.
    am.onHistoryChange = () => { if (this.mode === 'annotate') this.updateHistoryButtons(); };
  }

  /**
   * Mark one sub-tool button as active, activate it on all Fabric canvases,
   * and show/hide the opacity slider (only for highlight tools). Colour/width/opacity come from the
   * manager (persisted), NOT reset to defaults — so switching tools keeps the user's settings.
   */
  _activateAnnotateTool(tool) {
    this._lastAnnotateTool = tool;
    // Toggle active class
    document.querySelectorAll('.ann-tool-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`ann-${tool}`)?.classList.add('active');
    // Show opacity slider only for highlight tools
    const opWrap = document.getElementById('ann-opacity-wrap');
    if (opWrap) opWrap.style.display = (tool === 'highlight' || tool === 'freeHighlight') ? 'inline-flex' : 'none';
    // Size (stroke width) has no effect for the word-snap Text Highlight or the fixed-line Table —
    // show it dimmed + inert there so it's clear it doesn't apply (it still persists for other tools).
    const sizeWrap = document.getElementById('ann-size-wrap');
    const sizeOff = (tool === 'highlight' || tool === 'table');
    if (sizeWrap) {
      sizeWrap.classList.toggle('ann-off', sizeOff);
      const wInput = document.getElementById('ann-width'); if (wInput) wInput.disabled = sizeOff;
    }
    // Keep the sliders in sync with the persisted values.
    const am = this.annotationManager;
    const wEl = document.getElementById('ann-width'); if (wEl) wEl.value = am.strokeWidth;
    const oEl = document.getElementById('ann-opacity'); if (oEl) oEl.value = Math.round(am.highlightOpacity * 100);
    this._setColorSwatch(am.strokeColor, 'ann-color-sw');
    // Activate the tool with the persisted settings.
    am.setTool(tool, {
      strokeColor: am.strokeColor,
      strokeWidth: am.strokeWidth,
      highlightColor: am.highlightColor,
      highlightOpacity: am.highlightOpacity,
    });
  }

  handleCanvasClick(event, pv) {
    if (!this.controller.isLoaded) {
      this.showStatus('Open a PDF first.', 'error');
      return;
    }
    if (!this.mode) {
      this.showStatus('Pick a tool on the left first — Edit, Add, or Sign — then click the page.', 'error');
      return;
    }
    // Edit mode owns existing text via the per-line boxes; a click that reaches the bare
    // canvas here is blank space, and Edit must NOT add new text there.
    if (this.mode === 'edit') return;

    // Map the click to that page's intrinsic canvas pixels (handles CSS scaling), then
    // to PDF points (top-left origin) — the coordinate space used when saving.
    const rect = pv.canvas.getBoundingClientRect();
    const toIntrinsic = pv.canvas.width / rect.width;
    const xPt = ((event.clientX - rect.left) * toIntrinsic) / this.scale;
    const clickYPt = ((event.clientY - rect.top) * toIntrinsic) / this.scale;

    // 'text' = Add Text tool (click anywhere adds). 'auto' = smart mode: existing text is
    // covered by editable line boxes, so a click landing on the canvas is genuinely blank
    // space → add new text there (and reflect the Add button).
    if (this.mode === 'text' || this.mode === 'auto') {
      // The click that closes an open Add-text editor must NOT also open a fresh one — it only
      // commits. The next deliberate click then adds/edits based on where it lands. (onDocDown stamps
      // the time it committed on this same mousedown.)
      if (Date.now() - (this._lastInsertCommitAt || 0) < 350) { this._lastInsertCommitAt = 0; return; }
      // Seed the new box from the toolbar's size / B / I (its current "defaults").
      const fontSize = parseInt(document.getElementById('addSize')?.value, 10) || this._lastInsertSize || 14;
      // Drop an empty, editable text box where the user clicked and let them type in place.
      // Enter makes a new line; clicking away (or Esc) finishes it.
      const edit = {
        pageIndex: pv.pageNum, redact: false, style: 'text',
        x: xPt, baseline: clickYPt + fontSize * 0.8, fontSize, newText: '',
        fontFamily: document.getElementById('addFont')?.value || 'sans',
        bold: document.getElementById('addBold')?.classList.contains('on'),
        italic: document.getElementById('addItalic')?.classList.contains('on'),
      };
      // Smart mode: this click resolved to "add new text" — light up the Add button.
      this._reflectActiveTool('text');
      this.openInsertEditor(edit, pv, true);
    } else if (this.mode === 'stamp') {
      if (!this.activeStamp) { this.showStatus('Pick a stamp (Approved, Reject, …) first', 'error'); return; }
      this.placeStamp(xPt, clickYPt, pv);
    }
    // Signatures are added via the Sign dialog (drawn/typed/image), not by clicking.
  }

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

  // ----------------------------------------------------------------------------------------------
  //  Shared contextual floating text toolbar — ONE toolbar for edited existing text AND added text.
  //  applyTextStyle() routes a control to whichever text is active (open Add-text editor, a selected
  //  added-text overlay, or a focused existing-text line box). Bold/italic/size stay per-run inside
  //  the open editor; colour/underline/opacity/align/font-family are box-level on the edit object.
  // ----------------------------------------------------------------------------------------------
  _initTextToolbar() {
    const tb = document.getElementById('textToolbar');
    if (!tb) return;
    // Clicking a button must NOT blur/commit the active editor; inputs are allowed to take focus.
    tb.addEventListener('mousedown', (e) => { if (!e.target.closest('input, select')) e.preventDefault(); });
    const on = (id, ev, fn) => document.getElementById(id)?.addEventListener(ev, fn);
    on('tt-bold', 'click', () => this.applyTextStyle('bold', !this._ttStyle().bold));
    on('tt-italic', 'click', () => this.applyTextStyle('italic', !this._ttStyle().italic));
    on('tt-underline', 'click', () => this.applyTextStyle('underline', !this._ttStyle().underline));
    on('tt-size', 'input', (e) => { const v = parseInt(e.target.value, 10); if (v) this.applyTextStyle('size', v); });
    this._initFontPicker();
    this._initColorPalette();
    on('tt-align-left', 'click', () => this.applyTextStyle('align', 'left'));
    on('tt-align-center', 'click', () => this.applyTextStyle('align', 'center'));
    on('tt-align-right', 'click', () => this.applyTextStyle('align', 'right'));
    on('tt-opacity', 'input', (e) => this.applyTextStyle('opacity', Math.max(0.1, Math.min(1, (parseInt(e.target.value, 10) || 100) / 100))));
    on('tt-dup', 'click', () => this.duplicateActiveText());
    this._initLinkPopover();
    on('tt-del', 'click', () => this.deleteActiveText());
    document.getElementById('stage')?.addEventListener('scroll', () => this._positionTextToolbar());
    window.addEventListener('resize', () => this._positionTextToolbar());
    document.addEventListener('selectionchange', () => { if (this._ttTarget) this._positionTextToolbar(); });
    // Hide on a click outside both the toolbar and the active text (an open Add-text editor commits
    // itself via its own outside-mousedown handler; line/overlay just deselect).
    document.addEventListener('mousedown', (e) => {
      const t = this._ttTarget;
      if (!t || t.kind === 'editor') return;
      if (e.target.closest && e.target.closest('#textToolbar')) return;
      const el = t.kind === 'overlay' ? this._overlayElFor(t.edit) : t.el;
      if (el && (e.target === el || el.contains(e.target))) return;
      if (t.kind === 'overlay') this.selectInsert(null); else this.hideTextToolbar();
    }, true);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this._ttTarget && this._ttTarget.kind !== 'editor') this.hideTextToolbar(); });
  }

  _overlayElFor(edit) { return this.insertOverlays.find(o => o.__edit === edit) || null; }
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

  /** Build the Sejda-style swatch palette popover and wire it to applyTextStyle('color', …). */
  _initColorPalette() {
    this._buildColorPopover('tt-color-btn', 'tt-color-pop', (hex) => {
      this.applyTextStyle('color', hexToRgb(hex));
      this._setColorSwatch(hex, 'tt-color-sw');
    });
  }

  /**
   * Build the shared Sejda-style swatch palette popover on (btnId, popId): a grid of preset swatches
   * plus a native "Custom" picker. `onPick(hex)` fires on any selection. Reused by BOTH the text
   * floating toolbar and the annotation toolbar so they share one identical colour control.
   */
  _buildColorPopover(btnId, popId, onPick) {
    const btn = document.getElementById(btnId);
    const pop = document.getElementById(popId);
    if (!btn || !pop || pop._built) return;
    pop._built = true;
    // A compact, well-rounded palette (greys + 6 shade rows across the hues).
    const PALETTE = [
      '#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff',
      '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff',
      '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc',
      '#dd7e6b', '#ea9999', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#a4c2f4', '#9fc5e8', '#b4a7d6', '#d5a6bd',
      '#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0',
      '#a61c00', '#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3c78d8', '#3d85c6', '#674ea7', '#a64d79',
      '#85200c', '#990000', '#b45f06', '#bf9000', '#38761d', '#134f5c', '#1155cc', '#0b5394', '#351c75', '#741b47',
    ];
    PALETTE.forEach(hex => {
      const sw = document.createElement('button');
      sw.type = 'button'; sw.className = 'tt-sw'; sw.style.background = hex; sw.title = hex;
      sw.addEventListener('mousedown', (e) => e.preventDefault());   // keep the editor/canvas focused
      sw.addEventListener('click', () => { onPick(hex); pop.hidden = true; });
      pop.appendChild(sw);
    });
    // A "custom" native picker for anything outside the palette. The input keeps a per-popover id
    // (tt-color-custom for the text toolbar, ann-color-custom for annotations) so it stays scriptable.
    const customId = popId.replace('-pop', '-custom');
    const custom = document.createElement('label');
    custom.className = 'tt-sw tt-sw-custom'; custom.title = 'Custom colour';
    custom.innerHTML = `Custom <input type="color" id="${customId}" value="#000000" title="Custom colour" aria-label="Custom colour">`;
    custom.addEventListener('mousedown', (e) => { if (e.target.tagName !== 'INPUT') e.preventDefault(); });
    pop.appendChild(custom);
    custom.querySelector('input').addEventListener('input', (e) => onPick(e.target.value));

    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => { pop.hidden = !pop.hidden; });
    // Close on a click outside THIS colour control's own wrap.
    const wrap = btn.closest('.tt-color-wrap');
    document.addEventListener('mousedown', (e) => {
      if (!pop.hidden && (!wrap || !wrap.contains(e.target))) pop.hidden = true;
    }, true);
  }

  _setColorSwatch(hex, id = 'tt-color-sw') { const sw = document.getElementById(id); if (sw) sw.style.background = hex; }

  /** Wire the hyperlink popover: open on the Link button (prefilled with the current URL), Apply sets
   *  the link, Remove clears it, close on outside-click / Esc. Tracks the clickable area only — it
   *  does not restyle the text (an editor-only dotted underline marks linked text while editing). */
  _initLinkPopover() {
    const btn = document.getElementById('tt-link');
    const pop = document.getElementById('tt-link-pop');
    const input = document.getElementById('tt-link-input');
    const apply = document.getElementById('tt-link-apply');
    const remove = document.getElementById('tt-link-remove');
    if (!btn || !pop || !input || !apply || !remove) return;
    const close = () => { pop.hidden = true; };
    const open = () => {
      // Capture the existing-text selection NOW (before the URL input steals focus and collapses it),
      // so a link can target just the selected part of an existing line. Added-text uses its own range.
      this._pendingLinkSel = this._captureLineSelection();
      const cur = this._ttStyle().link || '';
      input.value = cur;
      remove.hidden = !cur;                         // only offer Remove when a link exists
      pop.hidden = false;
      setTimeout(() => { input.focus(); input.select(); }, 20);
    };
    const commit = (uri) => { this.applyTextStyle('link', uri); close(); };
    btn.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden ? open() : close(); });
    apply.addEventListener('click', () => commit(this._normalizeUrl(input.value)));
    remove.addEventListener('click', () => commit(''));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(this._normalizeUrl(input.value)); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    document.addEventListener('mousedown', (e) => { if (!pop.hidden && !e.target.closest('.tt-link-wrap')) close(); }, true);
  }

  /** Add a scheme to a bare URL/email so it forms a valid clickable link ('example.com' -> https://…,
   *  'a@b.com' -> mailto:…). Empty stays empty (= remove). */
  _normalizeUrl(v) {
    const s = (v || '').trim();
    if (!s) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;     // already has a scheme (http:, mailto:, tel:, …)
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'mailto:' + s;
    return 'https://' + s;
  }

  /** Show the toolbar for a target { kind:'editor'|'overlay'|'line', el, edit?, line? }. */
  _showTextToolbar(target) {
    this._ttTarget = target;
    const tb = document.getElementById('textToolbar');
    if (!tb) return;
    tb.hidden = false; tb.classList.add('show');
    const dup = document.getElementById('tt-dup');
    if (dup) dup.disabled = (target.kind === 'line');   // duplicate/move are added-text only
    const lp = document.getElementById('tt-link-pop'); if (lp) lp.hidden = true;   // fresh per selection
    this._reflectTextToolbar();
    this._positionTextToolbar();
  }

  hideTextToolbar() {
    this._ttTarget = null;
    const tb = document.getElementById('textToolbar');
    if (tb) { tb.classList.remove('show'); tb.hidden = true; }
    const lp = document.getElementById('tt-link-pop'); if (lp) lp.hidden = true;
  }

  /** Style of the active target, used to light up the toolbar buttons. */
  _ttStyle() {
    const t = this._ttTarget;
    if (!t) return {};
    if (t.kind === 'editor') {
      const s = this._activeInsertEditor ? this._activeInsertEditor.style() : {};
      const e = t.edit || {};
      return { bold: s.bold, italic: s.italic, size: s.size, underline: !!e.underline,
               color: e.color, opacity: e.opacity, align: e.align, link: e.link ? e.link.uri : '',
               family: this._displayFontKey(e.fontFamily, e.fontName) };
    }
    const o = t.kind === 'overlay' ? t.edit : t.line;
    if (!o) return {};
    const size = t.kind === 'overlay' ? Math.round(o.fontSize) : Math.round((o.fontSizePx || 0) / this.scale);
    // Added-text bold/italic live per-run, so a committed overlay reflects them from its runs
    // (every run bold/italic) rather than the box-level flags, which stay at the box default.
    let bold = !!o.bold, italic = !!o.italic, underline = !!o.underline;
    if (t.kind === 'overlay' && o.runs && o.runs.length) {
      const flat = o.runs.flat();
      if (flat.length) { bold = flat.every(r => r.bold); italic = flat.every(r => r.italic); }
    } else if (t.kind === 'line' && o.styleRuns && o.styleRuns.length) {
      // A mixed existing line reflects bold/italic/underline as "every run" — so the buttons light up
      // only when the WHOLE line is that style (a partly-bold line shows the Bold button off).
      bold = o.styleRuns.every(r => r.bold);
      italic = o.styleRuns.every(r => r.italic);
      underline = o.styleRuns.every(r => r.underline);
    }
    // Prefer the REAL font name (from PDF.js's rendered font object) so a saved+reopened font
    // re-selects in the picker; fall back to the generic guess before the page has resolved.
    const famKey = this._displayFontKey(o.fontFamily, this._realFontName(o) || o.fontFamilyName || o.fontName);
    return { bold, italic, underline, size,
             color: o.color, opacity: o.opacity, align: o.align,
             link: o.link ? o.link.uri : '',
             family: famKey,
             // Existing text whose original font isn't in the dropdown (LaTeX/Computer-Modern or any
             // other unmapped embedded face) is REDRAWN in its own/closest original face on save, so
             // the picker shows "Original" instead of an unset Arial-looking placeholder.
             fontOriginal: (t.kind === 'line' && !famKey) };
  }

  _reflectTextToolbar() {
    const s = this._ttStyle();
    const tog = (id, v) => document.getElementById(id)?.classList.toggle('on', !!v);
    tog('tt-bold', s.bold); tog('tt-italic', s.italic); tog('tt-underline', s.underline);
    tog('tt-link', s.link);
    tog('tt-align-left', (s.align || 'left') === 'left'); tog('tt-align-center', s.align === 'center'); tog('tt-align-right', s.align === 'right');
    // Don't clobber an input the user is actively typing into (else mid-type reflect mangles it).
    const set = (id, v) => { const el = document.getElementById(id); if (el != null && v != null && el !== document.activeElement) el.value = v; };
    if (s.size) set('tt-size', s.size);
    // Reflect the font: a known family shows its name; existing text on an unmapped original font
    // (LaTeX/Computer-Modern, etc.) shows "Original" (the editor preserves it — not an Arial default);
    // otherwise the "Select a Font Style" placeholder (added text).
    this._setFontPickerValue(s.family || '', s.fontOriginal ? 'Original' : undefined);
    this._setColorSwatch(s.color ? rgbToHex(s.color) : '#000000');
    set('tt-opacity', Math.round((s.opacity == null ? 1 : s.opacity) * 100));
  }

  /** Position the toolbar above the selected text, clamped inside the stage, flipping below if it
   *  would clip the top. Anchors to the (PDF-positioned) DOM element so it tracks zoom/scroll/resize. */
  _positionTextToolbar() {
    const t = this._ttTarget, tb = document.getElementById('textToolbar');
    if (!t || !tb || tb.hidden) return;
    const el = t.kind === 'overlay' ? this._overlayElFor(t.edit) : t.el;
    if (!el || !el.isConnected) { this.hideTextToolbar(); return; }
    const r = el.getBoundingClientRect();
    const tw = tb.offsetWidth || 360, th = tb.offsetHeight || 40;
    const stage = document.getElementById('stage');
    const sr = stage ? stage.getBoundingClientRect() : { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight };
    let left = Math.max(sr.left + 4, Math.min(r.left + r.width / 2 - tw / 2, sr.right - tw - 4));
    let top = r.top - th - 8;
    if (top < sr.top + 4) top = r.bottom + 8;                       // would clip the top -> drop below
    top = Math.max(sr.top + 4, Math.min(top, sr.bottom - th - 4));  // keep on-screen
    tb.style.left = left + 'px';
    tb.style.top = top + 'px';
  }

  // Standard hyperlink blue (classic browser link colour).
  static get LINK_BLUE() { return [0, 0, 238]; }

  /** Apply a hyperlink (or clear it with value=''). With an active text SELECTION in the open editor
   *  it links only that selection; otherwise the whole text object. Linked text defaults to blue +
   *  underline (the standard look) UNLESS the user already set a colour, which then supersedes. */
  _applyLink(t, value) {
    const uri = (value == null ? '' : String(value)).trim();
    const BLUE = PDFEditorApp.LINK_BLUE;
    if (t.kind === 'editor' && this._activeInsertEditor) {
      if (this._activeInsertEditor.hasSelection()) {             // partial: just the selected run(s)
        const had = this._activeInsertEditor.style();
        this._activeInsertEditor.applyStyle('link', uri || null);
        if (uri) {
          if (!had.color) this._activeInsertEditor.applyStyle('color', BLUE);
          this._activeInsertEditor.applyStyle('underline', true);
        }
        return;
      }
      this._setLink(t.edit, uri);                                // whole box (no selection)
      this._restyleEditorDiv(t.el, 'link', uri);
      if (uri) this._defaultLinkStyle(t.edit, t.el);
      return;
    }
    if (t.kind === 'overlay') {
      this._setLink(t.edit, uri);
      if (uri) this._defaultLinkStyle(t.edit, null);
      this.commitHistory();
      this.refresh().then(() => { this.selectInsert(t.edit); this._positionTextToolbar(); });
      return;
    }
    // existing-text line
    const l = t.line, div = t.el;
    const text = this.cleanEditableText(div.textContent);
    const psel = this._pendingLinkSel;
    if (uri && psel && psel.el === div && psel.end > psel.start && psel.end <= text.length) {
      // Partial: link ONLY the selected character range of the line (blue + underline that range).
      l.linkRange = { uri, start: psel.start, end: psel.end };
      l.link = null; l.linkRemoved = false;
      this.trackEdit(this.lineToEdit(l, text));
      this.refresh();                              // re-render so the partial style shows
      return;
    }
    // Whole line (no/whole selection, or removing).
    l.linkRange = null;
    this._setLink(l, uri);
    div.classList.toggle('tt-has-link', !!l.link);
    if (uri) {
      if (l.color == null) { l.color = BLUE; div.style.color = rgbCss(BLUE); }
      l.underline = true; div.style.textDecoration = 'underline';
    }
    this.trackEdit(this.lineToEdit(l, text));
  }

  /** The current selection's character range within the active existing-text line box, or null. */
  _captureLineSelection() {
    const t = this._ttTarget;
    if (!t || t.kind !== 'line' || !t.el) return null;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (r.collapsed || !t.el.contains(r.commonAncestorContainer)) return null;
    const pre = document.createRange();
    pre.selectNodeContents(t.el); pre.setEnd(r.startContainer, r.startOffset);
    const start = pre.toString().length;
    const end = start + r.toString().length;
    return end > start ? { el: t.el, start, end } : null;
  }

  /** Default a whole text object's link look to blue + underline, unless a colour is already set. */
  _defaultLinkStyle(edit, el) {
    if (edit.color == null) { edit.color = PDFEditorApp.LINK_BLUE; if (el) el.style.color = rgbCss(edit.color); }
    edit.underline = true; if (el) el.style.textDecoration = 'underline';
  }

  /** Apply one control to whatever text is active. */
  applyTextStyle(kind, value) {
    const t = this._ttTarget;
    if (!t) return;
    if (kind === 'link') { this._applyLink(t, value); this._reflectTextToolbar(); this._positionTextToolbar(); return; }
    if (t.kind === 'editor') {
      if (kind === 'bold' || kind === 'italic' || kind === 'size') {
        if (this._activeInsertEditor) this._activeInsertEditor.applyStyle(kind, value);
      } else {
        this._setBoxField(t.edit, kind, value);
        this._restyleEditorDiv(t.el, kind, value);
      }
    } else if (t.kind === 'overlay') {
      this._applyOverlayStyle(t.edit, kind, value);
      this.refresh().then(() => { this.selectInsert(t.edit); this._positionTextToolbar(); });
      return;                                                       // reflect after the re-render
    } else if (t.kind === 'line') {
      this._applyLineStyle(t, kind, value);
    }
    this._reflectTextToolbar();
    this._positionTextToolbar();
  }

  _setBoxField(edit, kind, value) {
    if (kind === 'underline') edit.underline = !!value;
    else if (kind === 'color') edit.color = value;
    else if (kind === 'opacity') edit.opacity = value;
    else if (kind === 'align') edit.align = value;
    else if (kind === 'family') edit.fontFamily = value;
    else if (kind === 'link') this._setLink(edit, value);
  }

  /** Set/clear a hyperlink on an edit/line. A URL stores `{uri}`; clearing it marks `linkRemoved` so
   *  the backend drops a previously-present (e.g. detected-on-load) link instead of re-adding it. */
  _setLink(obj, value) {
    const uri = (value == null ? '' : String(value)).trim();
    if (uri) { obj.link = { uri }; obj.linkRemoved = false; }
    else { if (obj.link) obj.linkRemoved = true; obj.link = null; }
  }

  _restyleEditorDiv(div, kind, value) {
    if (!div) return;
    if (kind === 'underline') div.style.textDecoration = value ? 'underline' : 'none';
    else if (kind === 'color') div.style.color = rgbCss(value);
    else if (kind === 'opacity') div.style.opacity = value;
    else if (kind === 'align') div.style.textAlign = value;
    else if (kind === 'family') div.style.fontFamily = this._familyCss(value);
    else if (kind === 'link') div.classList.toggle('tt-has-link', !!(value && String(value).trim()));
  }

  /** Whole-box styling for a selected (not-being-edited) added-text overlay. */
  _applyOverlayStyle(edit, kind, value) {
    if (kind === 'bold' || kind === 'italic') {
      edit[kind] = !!value;
      if (edit.runs) edit.runs.forEach(line => line.forEach(r => { r[kind] = !!value; }));
    } else if (kind === 'size') {
      edit.fontSize = value;
      if (edit.runs) edit.runs.forEach(line => line.forEach(r => { r.size = value; }));
    } else {
      this._setBoxField(edit, kind, value);
    }
    this.commitHistory();
  }

  /** Whole-line styling for a focused existing-text line box (updates CSS in place + tracks the edit
   *  immediately; trackEdit does not re-render, so the box keeps focus). */
  _applyLineStyle(t, kind, value) {
    const l = t.line, div = t.el;
    const rich = !!(l.styleRuns && l.styleRuns.length) &&
      div.querySelector('span[data-bold],span[data-italic],span[data-underline]');
    if (rich && (kind === 'bold' || kind === 'italic' || kind === 'underline')) {
      // Whole-line B/I/U on a MIXED line: apply it to EVERY run span (so the line becomes uniformly
      // that style) while keeping the per-run model for the others.
      div.querySelectorAll('span').forEach((sp) => {
        if (kind === 'underline') {
          if (value) { sp.setAttribute('data-underline', '1'); sp.style.textDecoration = 'underline'; }
          else { sp.removeAttribute('data-underline'); sp.style.textDecoration = 'none'; }
        } else {
          sp.setAttribute('data-' + kind, value ? '1' : '0');
          sp.style[kind === 'bold' ? 'fontWeight' : 'fontStyle'] = value ? (kind === 'bold' ? 'bold' : 'italic') : 'normal';
        }
      });
      l[kind] = !!value;
    } else if (kind === 'bold') { l.bold = !!value; div.style.fontWeight = value ? 'bold' : 'normal'; }
    else if (kind === 'italic') { l.italic = !!value; div.style.fontStyle = value ? 'italic' : 'normal'; }
    else if (kind === 'underline') { l.underline = !!value; div.style.textDecoration = value ? 'underline' : 'none'; }
    else if (kind === 'size') { l.fontSizePx = value * this.scale; l.sizeOverridden = true; div.style.fontSize = (value * this.scale * (div.__displayScale || 1)) + 'px'; }
    else if (kind === 'color') { l.color = value; div.style.color = rgbCss(value); }
    else if (kind === 'opacity') { l.opacity = value; div.style.opacity = value; }
    else if (kind === 'align') { l.align = value; div.style.textAlign = value; }
    else if (kind === 'family') { l.fontFamily = value; div.style.fontFamily = this._familyCss(value); }
    else if (kind === 'link') { this._setLink(l, value); div.classList.toggle('tt-has-link', !!l.link); }
    const runs = this._readLineRuns(div);
    if (runs) l.styleRuns = runs;
    this.trackEdit(this.lineToEdit(l, this.cleanEditableText(div.textContent), runs));
  }

  /** Duplicate the selected added-text object (existing text isn't a movable object). */
  duplicateActiveText() {
    const t = this._ttTarget;
    if (!t || t.kind === 'line' || !t.edit) return;
    const src = t.edit;
    const copy = JSON.parse(JSON.stringify(src));   // deep copy (runs included); plain data only
    copy.x = (src.x || 0) + 12;
    copy.baseline = (src.baseline || 0) + 12;
    this.edits.push(copy);
    this.commitHistory();
    this.refresh().then(() => { this.selectInsert(copy); this._positionTextToolbar(); });
  }

  /** Delete the active text: an added object is removed; an existing line is blanked (redacted). */
  deleteActiveText() {
    const t = this._ttTarget;
    if (!t) return;
    if (t.kind === 'line') {
      this.trackEdit(this.lineToEdit(t.line, ''));   // empty replacement -> redacted away on save
      if (t.el) { t.el.textContent = ''; t.el.dataset.originalText = ''; }
      this.hideTextToolbar();
    } else if (t.edit) {
      this.edits = this.edits.filter(e => e !== t.edit);
      this.commitHistory();
      this.selectedInsert = null;
      this.hideTextToolbar();
      this.refresh();
    }
  }

  // ----- Undo / redo (snapshots of this.edits) -----

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
  }

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
  }

  /** Find a pending line-edit that matches a given extracted line (by page + position). */
  findLineEdit(line) {
    const s = this.scale;
    const xPt = line.left / s, basePt = line.baseline / s;
    return this.edits.find(e =>
      e.redact !== false && e.kind !== 'erase' && e.pageIndex === line.pageIndex &&
      Math.abs(e.x - xPt) < 1.5 && Math.abs(e.baseline - basePt) < 1.5);
  }

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

    // Produce the edited bytes with a fallback chain, best fidelity first. Each step is
    // guarded so a failure cleanly tries the next; a real "Failed to save" is shown only
    // when every path fails and no file is produced.
    //  1) PyMuPDF backend  - truly removes replaced text (clean for copy/paste & ATS).
    //  2) pdf-lib (client) - covers the original and redraws (works offline / static host).
    //  3) Flatten to image - last resort for PDFs pdf-lib can't traverse (odd page trees,
    //     encryption, etc.). This is what handles "Pages tree contains circular reference".
    let editedPdfBytes = null;
    let flattened = false;
    let viaBackend = false;

    try {
      if (await PDFBackendService.checkHealth()) {
        // Serialize Fabric annotations (highlights, shapes, etc.) so the backend can
        // burn them in as native PDF annotations (real /Highlight with fill_opacity).
        const fabricAnnotations = this.annotationManager ? this.annotationManager.serialize() : [];
        editedPdfBytes = await PDFBackendService.editPDF(this.originalFileData, this.edits, fabricAnnotations);
        viaBackend = true;
      }
    } catch (e) { console.warn('Backend save failed, trying client-side:', e); }

    if (!editedPdfBytes) {
      try {
        editedPdfBytes = await this.applyEditsWithPdfLib(this.originalFileData, this.edits);
      } catch (e) { console.warn('Client-side (vector) save failed, flattening instead:', e); }
    }

    if (!editedPdfBytes) {
      try {
        editedPdfBytes = await this.flattenToPdfBytes(this.edits);
        flattened = true;
      } catch (e) { console.warn('Flatten save failed:', e); }
    }

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
      } else if (viaBackend) {
        // The backend truly removed the replaced text, so reload the clean result as the new
        // baseline so further edits build on it.
        this.originalFileData = editedPdfBytes;
        const loadingTask = pdfjsLib.getDocument({ data: editedPdfBytes.slice(0) });
        this.pdfJsDoc = await loadingTask.promise;
        await this.extractTextFromPDFjs();
        this.edits = [];
        this.resetHistory();
        await this.buildPages();
        this.showStatus('Saved! Your edited PDF has been downloaded.', 'success');
      } else {
        this.showStatus('Saved! Your edited PDF has been downloaded.', 'success');
      }
    } catch (e) {
      console.warn('Post-save refresh failed (the file was already saved):', e);
      this.showStatus('Saved! Your edited PDF has been downloaded.', 'success');
    }

    // Refresh to a clean slate once the toast + download have started.
    setTimeout(() => window.location.reload(), 1600);
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
      const baseX = edit.x, baseY = ph - edit.baseline;
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


Object.assign(PDFEditorApp.prototype, NavigationMethods, HistoryMethods, StampMethods, EraseMethods, PagesPanelMethods, SignatureMethods, InsertEditorMethods);

// Initialize the app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.pdfEditorApp = new PDFEditorApp();   // exposed so Merge can clear the open doc
  initMerge();   // wire up the client-side "Merge PDF" feature (self-contained)
});
