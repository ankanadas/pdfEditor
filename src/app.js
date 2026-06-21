import { EditorController } from './core/EditorController.js';
import { PDFBackendService } from './services/pdfBackendService.js';
import { initMerge } from './merge.js';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';

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

    // Pages manager (reorder / delete / insert blank pages)
    document.getElementById('pagesPanelBtn')?.addEventListener('click', () => this.togglePagesPanel());
    document.getElementById('pagesPanelClose')?.addEventListener('click', () => this.closePagesPanel());
    document.getElementById('pagesBackdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'pagesBackdrop') this.closePagesPanel();   // click outside the drawer
    });
    document.getElementById('insertBlankBtn')?.addEventListener('click', () => this.insertBlankPage());
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closePagesPanel(); });
  }

  previousPage() { this.scrollToPage(this.currentPage - 1); }
  nextPage() { this.scrollToPage(this.currentPage + 1); }

  scrollToPage(i) {
    const pv = this.pageViews[i];
    if (!pv) return;
    pv.wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
    this.currentPage = i;
    this.updatePageInfo();
  }

  /** Update the current-page indicator from the scroll position. */
  updateCurrentPageFromScroll() {
    const stage = document.getElementById('stage');
    if (!stage || !this.pageViews.length) return;
    const mid = stage.scrollTop + stage.clientHeight / 2;
    let best = 0;
    for (let i = 0; i < this.pageViews.length; i++) {
      if (this.pageViews[i].wrapper.offsetTop <= mid) best = i;
    }
    if (best !== this.currentPage) { this.currentPage = best; this.updatePageInfo(); }
  }

  updatePageInfo() {
    const pageInfo = document.getElementById('pageInfo');
    if (pageInfo && this.pdfJsDoc) {
      pageInfo.textContent = `Page ${this.currentPage + 1} of ${this.pdfJsDoc.numPages}`;
    }
  }

  /** Enable all the tools/controls that require a loaded PDF. */
  enableUiAfterLoad() {
    ['saveBtn', 'textInput', 'prevPageBtn', 'nextPageBtn', 'pagesPanelBtn',
     'editModeBtn', 'textModeBtn', 'signatureModeBtn', 'eraseModeBtn', 'stampModeBtn', 'clearSignatureBtn']
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
    ['saveBtn', 'textInput', 'prevPageBtn', 'nextPageBtn', 'pagesPanelBtn',
     'editModeBtn', 'textModeBtn', 'signatureModeBtn', 'eraseModeBtn', 'stampModeBtn', 'clearSignatureBtn']
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
      const proceed = await this.confirmDialog(
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
    const ok = await this.confirmDialog(
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
    }

    this.pageWidth = this.pageViews[0] ? this.pageViews[0].page.view[2] : 612;
    this.pageHeight = this.pageViews[0] ? this.pageViews[0].page.view[3] : 792;
    this.currentPage = 0;
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
      const c = this.sampleLineColors(pv, line);
      line.bgColor = c.bg;          // real background colour (used for the editable text contrast)
      line.textColor = c.text;      // real text colour (e.g. white) for the editable box
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
            + `<span class="tt-has-link" style="color:${this._rgbCss(PDFEditorApp.LINK_BLUE)};text-decoration:underline">${esc(shownText.slice(a, b))}</span>`
            + esc(shownText.slice(b));
        }
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
          this.trackEdit(this.lineToEdit(line, newText));
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
   * Read a text line from the rendered canvas and return BOTH its background colour and its text
   * colour: { bg:[r,g,b]|null, text:[r,g,b]|null }. The background is sampled from the PADDING
   * just OUTSIDE the line's box (that area is page background, never glyphs) so it stays correct
   * even for a big bold headline whose own box is wall-to-wall glyphs; the text colour is the
   * dominant colour INSIDE the box that differs from the background. This lets an edit cover the
   * line with its REAL background (e.g. dark) and show the editable text in its REAL colour (e.g.
   * white) — so editing white-on-dark text is seamless instead of a white box.
   */
  /**
   * Read a region of a (possibly GPU-accelerated) canvas reliably: copy it into a throwaway
   * CPU-backed canvas first, then getImageData there. Reading straight from the render canvas can
   * return empty/stale pixels on some browsers, which is what made colour sampling fail.
   */
  _readRegion(srcCanvas, x, y, w, h) {
    const tmp = document.createElement('canvas');
    tmp.width = Math.max(1, w); tmp.height = Math.max(1, h);
    const tctx = tmp.getContext('2d', { willReadFrequently: true });
    tctx.drawImage(srcCanvas, x, y, w, h, 0, 0, w, h);
    return tctx.getImageData(0, 0, w, h).data;
  }

  sampleLineColors(pv, line) {
    try {
      const cw = pv.canvas.width, ch = pv.canvas.height;
      const lh = Math.max(1, line.bottom - line.top);
      const padX = Math.max(6, Math.round(lh * 0.5));   // sample a margin to the sides...
      const padY = Math.max(4, Math.round(lh * 0.35));  // ...and just above / below the text
      const ex0 = Math.max(0, Math.floor(line.left) - padX);
      const ey0 = Math.max(0, Math.floor(line.top) - padY);
      const ex1 = Math.min(cw, Math.ceil(line.right) + padX);
      const ey1 = Math.min(ch, Math.ceil(line.bottom) + padY);
      const w = Math.max(1, ex1 - ex0), h = Math.max(1, ey1 - ey0);
      const data = this._readRegion(pv.canvas, ex0, ey0, w, h);   // robust readback (CPU canvas)
      // The original text box, in this region's local coordinates.
      const ix0 = Math.floor(line.left) - ex0, iy0 = Math.floor(line.top) - ey0;
      const ix1 = Math.ceil(line.right) - ex0, iy1 = Math.ceil(line.bottom) - ey0;
      const key = (i) => ((data[i] & 0xF0) << 16) | ((data[i + 1] & 0xF0) << 8) | (data[i + 2] & 0xF0);

      const padC = new Map(), padRep = new Map(), inC = new Map(), inRep = new Map();
      for (let py = 0; py < h; py++) {
        const inRow = py >= iy0 && py < iy1;
        for (let px = 0; px < w; px++) {
          const i = (py * w + px) * 4;
          if (data[i + 3] < 128) continue;
          const k = key(i);
          if (inRow && px >= ix0 && px < ix1) {        // inside the text box
            inC.set(k, (inC.get(k) || 0) + 1);
            if (!inRep.has(k)) inRep.set(k, [data[i], data[i + 1], data[i + 2]]);
          } else {                                     // padding = background
            padC.set(k, (padC.get(k) || 0) + 1);
            if (!padRep.has(k)) padRep.set(k, [data[i], data[i + 1], data[i + 2]]);
          }
        }
      }
      // Background = modal colour of the padding (fall back to the box's modal if no padding).
      let bg = null, bgN = -1;
      for (const [k, n] of padC) { if (n > bgN) { bgN = n; bg = padRep.get(k); } }
      if (!bg) { for (const [k, n] of inC) { if (n > bgN) { bgN = n; bg = inRep.get(k); } } }

      // Text = the most common colour inside the box that is clearly different from the background.
      const far = (c) => !bg || (Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]) > 70);
      let text = null, textN = 0;
      for (const [k, n] of inC) { const c = inRep.get(k); if (far(c) && n > textN) { textN = n; text = c; } }

      return { bg, text };
    } catch (e) {
      console.warn('[QPE] sampleLineColors getImageData failed (canvas tainted?) — falling back', e);
      return { bg: null, text: null };   // e.g. a tainted canvas — caller falls back
    }
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

  lineToEdit(line, newText) {
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
   * The weight/slant PDF.js computed for a loaded font — the SAME source PDF.js uses to style its
   * own text layer (commonObjs holds the parsed font with .bold/.black/.italic). Read at EDIT time,
   * after the page has rendered, so the object is resolved. This recovers a bold/italic the font-NAME
   * heuristic misses for NON-EMBEDDED standard fonts (a "Helvetica-Bold" heading PDF.js draws via a
   * system font, not a loadedName web font). Returns null when the font object isn't available.
   */
  fontStyleFromPdfjs(pv, fontName) {
    try {
      const objs = pv && pv.page && pv.page.commonObjs;
      if (!objs || !fontName || !objs.has(fontName)) return null;
      const f = objs.get(fontName);
      if (!f) return null;
      // For a NON-embedded standard font, PDF.js renders via a system-font @font-face it injects
      // during render (systemFontInfo.css -> src: local(Helvetica…)); reuse that exact family so the
      // edit box shows the real font, not the Arial fallback. Embedded fonts have no systemFontInfo.
      const css = (f.systemFontInfo && f.systemFontInfo.css) ? f.systemFontInfo.css : null;
      return { bold: !!(f.black || f.bold), italic: !!f.italic, css };
    } catch (e) {
      return null;
    }
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
        const st = this.fontStyleFromPdfjs(pv, it.fontName);
        if (!st) continue;
        known++;
        if (!st.bold) boldAll = false;
        if (!st.italic) italicAll = false;
      }
      if (known === items.length) {        // every item's font was resolvable -> trust it
        if (boldAll) line.bold = true;
        if (italicAll) line.italic = true;
      }
      // Reuse PDF.js's own font family for the line so the overlay matches the page exactly.
      const head = this.fontStyleFromPdfjs(pv, line.fontName);
      if (head && head.css) line.fontCss = head.css;
    });
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

    // Highlight the active tool and expose the mode on <body> so the UI (CSS) can
    // show the relevant inputs / cursor for that tool.
    [textBtn, editBtn, sigBtn, eraseBtn, stampBtn].forEach(btn => btn && btn.classList.remove('active'));
    document.body.dataset.mode = mode || '';

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
    }

    // Rebuild overlays for the new mode (edit boxes vs. painted edits) on every page.
    if (previousMode !== mode) this.refresh();
    this.updateModeIndicator();
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
    } else {
      indicator.textContent = 'Pick a tool';
      indicator.classList.remove('active');
    }
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

  /**
   * Open an in-place multi-line text editor (a positioned contentEditable div) for an "Add text"
   * box. `isNew` = a fresh box from clicking the page (committed only if non-empty); otherwise it
   * re-edits an existing overlay (double-click). Enter inserts a new line; Esc cancels; clicking
   * away commits. A single box can mix font size, bold and italic per run: the top toolbar's size
   * box / B / I restyle the current selection, or — with a collapsed caret — set the style for text
   * typed next. Existing text is never changed. Runs are stored on edit.runs (lines ->
   * [{text,size,bold,italic}]); edit.newText/fontSize are kept in sync.
   */
  openInsertEditor(edit, pv, isNew) {
    // Already editing this box (e.g. a click + the dblclick both fired)? Keep the open editor.
    if (!isNew && this._activeInsertEditor && this.selectedInsert === edit && pv.wrapper.querySelector('.insert-editor')) return;
    const ds = (pv.canvas.clientWidth || pv.canvas.width) / pv.canvas.width;
    const unit = this.scale * ds;
    const baseFontPx = edit.fontSize * unit;
    const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // A run span carries size/bold/italic AND (optionally) underline / colour / link, so a partial
    // selection can be styled or hyperlinked. `applyRunStyle` writes both the data-* attr (for
    // serialisation) and the matching CSS (for the live editor) for any of these kinds.
    const applyRunStyle = (span, kind, value) => {
      if (kind === 'size') { span.setAttribute('data-sz', value); span.style.fontSize = (value * unit) + 'px'; }
      else if (kind === 'bold') { span.setAttribute('data-bold', value ? '1' : '0'); span.style.fontWeight = value ? 'bold' : 'normal'; }
      else if (kind === 'italic') { span.setAttribute('data-italic', value ? '1' : '0'); span.style.fontStyle = value ? 'italic' : 'normal'; }
      else if (kind === 'underline') { if (value) { span.setAttribute('data-underline', '1'); span.style.textDecoration = 'underline'; } else { span.removeAttribute('data-underline'); span.style.textDecoration = 'none'; } }
      else if (kind === 'color') { const hex = this._rgbToHex(value); span.setAttribute('data-color', hex); span.style.color = this._rgbCss(value); }
      else if (kind === 'link') { if (value) { span.setAttribute('data-link', value); span.classList.add('tt-has-link'); } else { span.removeAttribute('data-link'); span.classList.remove('tt-has-link'); } }
    };
    const styledSpan = (st) => {
      const span = document.createElement('span');
      ['size', 'bold', 'italic'].forEach(k => applyRunStyle(span, k, st[k]));
      if (st.underline) applyRunStyle(span, 'underline', true);
      if (st.color) applyRunStyle(span, 'color', st.color);
      if (st.link) applyRunStyle(span, 'link', st.link);
      return span;
    };
    const spanHTML = (t, st) => { const sp = styledSpan(st); sp.textContent = t; return sp.outerHTML; };

    // This box is now the active one.
    this.selectedInsert = edit;
    this._insertSavedRange = null;

    // Hide the existing static overlay (if any) while its editor is open.
    const overlay = isNew ? null : this.insertOverlays.find(o => o.__edit === edit);
    if (overlay) overlay.style.display = 'none';

    const div = document.createElement('div');
    div.className = 'insert-editor';
    div.contentEditable = 'true';
    div.spellcheck = false;
    div.setAttribute('data-placeholder', 'Type here… (Enter for a new line)');
    div.style.left = (edit.x * unit) + 'px';
    div.style.top = (edit.baseline * unit - baseFontPx * 0.9) + 'px';
    div.style.fontSize = baseFontPx + 'px';                 // base style for un-spanned (typed) text
    div.style.fontWeight = edit.bold ? 'bold' : 'normal';
    div.style.fontStyle = edit.italic ? 'italic' : 'normal';
    div.style.fontFamily = this._familyCss(edit.fontFamily);   // preview in the chosen face (any catalogue font)
    const boxDefaults = { size: Math.round(edit.fontSize) || 12, bold: !!edit.bold, italic: !!edit.italic };
    // Seed content: from saved runs if present, else one span per line at the box defaults.
    if (edit.runs && edit.runs.length) {
      div.innerHTML = edit.runs
        .map(line => line.map(r => spanHTML(r.text, { size: r.size, bold: !!r.bold, italic: !!r.italic })).join(''))
        .join('<br>');
    } else if (edit.newText) {
      div.innerHTML = String(edit.newText).split('\n')
        .map(line => spanHTML(line, boxDefaults)).join('<br>');
    }

    const maxW = pv.canvas.clientWidth - edit.x * unit - 4;
    const grow = () => {
      div.style.width = 'auto';
      div.style.height = 'auto';
      div.style.width = Math.min(div.scrollWidth + 6, Math.max(44, maxW)) + 'px';
      div.style.height = (div.scrollHeight + 4) + 'px';
    };

    // The style {size,bold,italic} at a range/caret: nearest ancestor that sets each attribute,
    // independently, falling back to the box defaults.
    const caretStyle = (range) => {
      let node = null, offset = 0;
      if (range) { node = range.endContainer; offset = range.endOffset; }
      else { const sel = window.getSelection(); if (sel && sel.rangeCount) { node = sel.focusNode; offset = sel.focusOffset; } }
      // If the position is at an element boundary (e.g. a whole-content selection ends on the
      // editor div), descend into the run just before the caret so we read its real style — not
      // the box default. Skip <br>.
      if (node && node.nodeType === Node.ELEMENT_NODE) {
        let child = node.childNodes[Math.max(0, offset - 1)] || node.childNodes[offset];
        while (child && child.nodeType === Node.ELEMENT_NODE && child.nodeName !== 'BR' && child.lastChild) {
          child = child.lastChild;
        }
        if (child) node = child;
      }
      if (node && node.nodeType === Node.TEXT_NODE) node = node.parentNode;
      const st = { ...boxDefaults };
      let fS = false, fB = false, fI = false, fU = false, fC = false, fL = false;
      while (node && node !== div && node.getAttribute) {
        if (!fS && node.hasAttribute('data-sz')) { st.size = Math.round(parseFloat(node.getAttribute('data-sz'))); fS = true; }
        if (!fB && node.hasAttribute('data-bold')) { st.bold = node.getAttribute('data-bold') === '1'; fB = true; }
        if (!fI && node.hasAttribute('data-italic')) { st.italic = node.getAttribute('data-italic') === '1'; fI = true; }
        if (!fU && node.hasAttribute('data-underline')) { st.underline = node.getAttribute('data-underline') === '1'; fU = true; }
        if (!fC && node.hasAttribute('data-color')) { st.color = this._hexToRgb(node.getAttribute('data-color')); fC = true; }
        if (!fL && node.hasAttribute('data-link')) { st.link = node.getAttribute('data-link'); fL = true; }
        node = node.parentNode;
      }
      return st;
    };

    // The range to act on: the live selection if it's inside this editor, else the last one we
    // saved before focus moved to the toolbar (so the toolbar controls still target the text).
    const workingRange = () => {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const r = sel.getRangeAt(0);
        if (div.contains(r.commonAncestorContainer)) return r;
      }
      const sv = this._insertSavedRange;
      return (sv && div.contains(sv.commonAncestorContainer)) ? sv : null;
    };
    const saveRange = () => {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const r = sel.getRangeAt(0);
        if (div.contains(r.commonAncestorContainer)) this._insertSavedRange = r.cloneRange();
      }
    };
    // Reflect bold/italic at the caret in the toolbar. The SIZE box is intentionally NOT synced
    // from the caret — it's a "pen size" that stays where the user set it (so it doesn't jump back
    // to a run's size when you click into the text). It's seeded once when the editor opens.
    const syncToolbar = () => {
      const st = caretStyle(workingRange());
      document.getElementById('addBold')?.classList.toggle('on', st.bold);
      document.getElementById('addItalic')?.classList.toggle('on', st.italic);
    };

    // A pending "pen" style: when size/B/I is changed with nothing selected, we don't touch any
    // existing text — instead the next characters typed get this style (see the beforeinput
    // handler). It survives the toolbar's number input stealing focus, which a caret-holder span
    // could not. Stays set until the user restyles a selection or the box is committed.
    let pendingStyle = null;

    // Apply one style property to the selection (restyle just that text, keeping the other two
    // properties), or — with a collapsed caret — arm it as the pen for text typed next. `kind` is
    // 'size' | 'bold' | 'italic'.
    const applyStyle = (kind, value) => {
      if (kind === 'size') { value = Math.max(4, Math.min(200, Math.round(value))); this._lastInsertSize = value; }
      const range = workingRange();
      const sel = window.getSelection();
      const liveInEditor = sel && sel.rangeCount && div.contains(sel.getRangeAt(0).commonAncestorContainer);
      if (!range || range.collapsed) {
        // No selection: arm the pen for the next typed characters (existing text is untouched).
        const base = pendingStyle || (range ? caretStyle(range) : { ...boxDefaults });
        pendingStyle = { ...base }; pendingStyle[kind] = value;
        if (!range) {                  // truly empty box: also make it the box default
          edit.fontSize = pendingStyle.size; edit.bold = pendingStyle.bold; edit.italic = pendingStyle.italic;
          div.style.fontSize = (pendingStyle.size * unit) + 'px';
          div.style.fontWeight = pendingStyle.bold ? 'bold' : 'normal';
          div.style.fontStyle = pendingStyle.italic ? 'italic' : 'normal';
          boxDefaults.size = pendingStyle.size; boxDefaults.bold = pendingStyle.bold; boxDefaults.italic = pendingStyle.italic;
        }
        syncToolbar(); return;
      }
      // A real selection: restyle just that text and drop the pen. Wrap it in a span carrying the new
      // style (size/bold/italic/underline/color/link) and propagate to any nested same-kind spans.
      pendingStyle = null;
      const attr = { size: 'data-sz', bold: 'data-bold', italic: 'data-italic', underline: 'data-underline', color: 'data-color', link: 'data-link' }[kind];
      const frag = range.extractContents();
      const span = document.createElement('span');
      applyRunStyle(span, kind, value);
      span.appendChild(frag);
      if (attr) span.querySelectorAll('[' + attr + ']').forEach(sp => applyRunStyle(sp, kind, value));
      range.insertNode(span);
      const r2 = document.createRange();
      r2.selectNodeContents(span);
      if (liveInEditor) { sel.removeAllRanges(); sel.addRange(r2); }
      this._insertSavedRange = r2.cloneRange();
      grow(); syncToolbar();
    };

    // Enter -> a <br> (keeps the model to text nodes + spans + <br>, so serialization is simple).
    // At the end of content we also drop a style-preserving caret holder so the new line continues
    // at the current style and is focusable.
    const insertLineBreak = () => {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (!div.contains(range.commonAncestorContainer)) return;
      const st = pendingStyle ? { ...pendingStyle } : caretStyle(range);
      range.deleteContents();
      const br = document.createElement('br');
      range.insertNode(br);
      range.setStartAfter(br); range.collapse(true);
      if (!br.nextSibling) {
        const span = styledSpan(st);
        span.appendChild(document.createTextNode('\u200b'));
        br.parentNode.appendChild(span);
        range.setStart(span.firstChild, 1); range.collapse(true);
      }
      sel.removeAllRanges(); sel.addRange(range);
    };

    // Expose the editor to the top toolbar (size box / B / I act on it while it's open) and reveal
    // the Add-text toolbar group regardless of the current tool.
    this._activeInsertEditor = { applyStyle, style: () => caretStyle(workingRange()),
      hasSelection: () => { const r = workingRange(); return !!(r && !r.collapsed); } };
    document.body.classList.add('editing-insert');

    pv.wrapper.appendChild(div);
    grow();
    div.focus();
    if (!isNew) {
      // Re-opening: drop the caret at the very end of the text (inside the last run) so appended
      // text continues that run's style and the toolbar reflects it — not the box's largest size.
      let last = div.lastChild;
      while (last && last.nodeType !== Node.TEXT_NODE && last.lastChild) last = last.lastChild;
      const r = document.createRange();
      if (last && last.nodeType === Node.TEXT_NODE) r.setStart(last, last.nodeValue.length);
      else { r.selectNodeContents(div); r.collapse(false); }
      r.collapse(true);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    }
    saveRange();
    // Seed the (sticky) size box once: keep whatever size the user last set rather than reverting
    // to this box's largest run.
    const sizeEl0 = document.getElementById('addSize');
    if (sizeEl0) sizeEl0.value = this._lastInsertSize || boxDefaults.size;
    syncToolbar();

    // Reflect any box-level styling already on this edit (re-opening) onto the live editor, then
    // show the shared floating toolbar anchored to it.
    ['underline', 'color', 'opacity', 'align', 'family'].forEach(k => {
      const v = k === 'family' ? edit.fontFamily : edit[k];
      if (v != null && !(k === 'opacity' && v >= 1)) this._restyleEditorDiv(div, k, v);
    });
    this._showTextToolbar({ kind: 'editor', el: div, edit });

    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      document.removeEventListener('mousedown', onDocDown, true);
      document.body.classList.remove('editing-insert');
      if (this._ttTarget && this._ttTarget.kind === 'editor') this.hideTextToolbar();
      this._activeInsertEditor = null;
      this._insertSavedRange = null;
      const result = commit ? this.serializeEditor(div, boxDefaults) : null;
      div.remove();
      let changed = false;
      if (commit) {
        if (result.text.trim()) {
          edit.newText = result.text;
          edit.runs = result.runs;
          edit.fontSize = result.maxSize;          // representative size (geometry + default)
          if (isNew) this.edits.push(edit);
          changed = true;
        } else if (!isNew) {
          this.edits = this.edits.filter(x => x !== edit);   // emptied existing -> delete
          this.selectedInsert = null;
          changed = true;
        } else {
          this.selectedInsert = null;                        // isNew && empty -> discard
        }
      } else if (isNew) {
        this.selectedInsert = null;                          // cancelled a brand-new box
      }
      if (changed) this.commitHistory();
      this.renderCurrentPage();
    };

    // Commit when the user mouses down anywhere that isn't this editor or the Add-text toolbar
    // (so adjusting size/B/I keeps the box open). Esc cancels.
    const onDocDown = (e) => {
      if (done || div.contains(e.target)) return;
      // Don't commit when the click is on a styling control (top Add bar or the floating toolbar).
      if (e.target.closest && e.target.closest('.ctx-text, #textToolbar')) return;
      this._lastInsertCommitAt = Date.now();   // suppress the chain-open on this same canvas click
      finish(true);
    };
    document.addEventListener('mousedown', onDocDown, true);

    // When a pen style is armed (size/B/I set with no selection), insert typed characters in a
    // span of that style so the new text — not the existing text — picks up the change. This is
    // what makes "set size, then type" work even though the toolbar input stole focus.
    div.addEventListener('beforeinput', (e) => {
      if (!pendingStyle || e.inputType !== 'insertText' || e.data == null) return;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const r = sel.getRangeAt(0);
      if (!div.contains(r.commonAncestorContainer)) return;
      e.preventDefault();
      r.deleteContents();
      const span = styledSpan(pendingStyle);
      span.textContent = e.data;
      r.insertNode(span);
      const r2 = document.createRange();
      r2.setStartAfter(span); r2.collapse(true);
      sel.removeAllRanges(); sel.addRange(r2);
      this._insertSavedRange = r2.cloneRange();
      grow();
    });
    div.addEventListener('input', () => { saveRange(); grow(); });
    div.addEventListener('keyup', () => { saveRange(); syncToolbar(); });
    div.addEventListener('mouseup', () => { saveRange(); syncToolbar(); });
    div.addEventListener('keydown', (e) => {
      e.stopPropagation();                 // don't trigger global shortcuts (undo/redo) while typing
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      else if (e.key === 'Enter') { e.preventDefault(); insertLineBreak(); grow(); }
    });
  }

  /**
   * Read a contentEditable "Add text" editor back into a runs model. Walks text nodes, styling
   * spans (data-sz / data-bold / data-italic, each inherited independently) and <br> line breaks,
   * cleaning stray zero-width / control chars. `defaults` = {size,bold,italic} for un-styled text.
   * Returns { runs: [[{text,size,bold,italic}], ...], text: "lines\njoined", maxSize }.
   */
  serializeEditor(root, defaults) {
    const base = { size: Math.round(defaults.size) || 12, bold: !!defaults.bold, italic: !!defaults.italic };
    const lines = [[]];
    const sameColor = (a, b) => (a == null && b == null) || (Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);
    const pushText = (t, st) => {
      if (!t) return;
      const line = lines[lines.length - 1];
      const last = line[line.length - 1];
      if (last && last.size === st.size && last.bold === st.bold && last.italic === st.italic
          && !!last.underline === !!st.underline && sameColor(last.color, st.color) && (last.link || '') === (st.link || '')) {
        last.text += t;
      } else {
        const r = { text: t, size: st.size, bold: st.bold, italic: st.italic };
        if (st.underline) r.underline = true;
        if (st.color) r.color = st.color;
        if (st.link) r.link = st.link;
        line.push(r);
      }
    };
    const styleFrom = (child, inherited) => {
      const st = { ...inherited };
      if (child.getAttribute) {
        const sz = child.getAttribute('data-sz'); if (sz) st.size = Math.round(parseFloat(sz));
        const b = child.getAttribute('data-bold'); if (b !== null) st.bold = b === '1';
        const i = child.getAttribute('data-italic'); if (i !== null) st.italic = i === '1';
        if (child.hasAttribute('data-underline')) st.underline = child.getAttribute('data-underline') === '1';
        const c = child.getAttribute('data-color'); if (c) st.color = this._hexToRgb(c);
        const lk = child.getAttribute('data-link'); if (lk !== null) st.link = lk;
      }
      return st;
    };
    const walk = (node, inherited) => {
      node.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          pushText(this.cleanEditableText(child.nodeValue), inherited);
        } else if (child.nodeName === 'BR') {
          lines.push([]);
        } else {
          const st = styleFrom(child, inherited);
          // A block-level wrapper (browsers sometimes inject <div>/<p>) starts a new visual line.
          const isBlock = child.nodeName === 'DIV' || child.nodeName === 'P';
          if (isBlock && (lines.length > 1 || lines[lines.length - 1].length)) lines.push([]);
          walk(child, st);
        }
      });
    };
    walk(root, base);
    let runs = lines.map(line => line.filter(r => r.text.length));
    while (runs.length && runs[0].length === 0) runs.shift();
    while (runs.length && runs[runs.length - 1].length === 0) runs.pop();
    const text = runs.map(line => line.map(r => r.text).join('')).join('\n');
    let maxSize = base.size;
    runs.forEach(line => line.forEach(r => { if (r.size > maxSize) maxSize = r.size; }));
    return { runs, text, maxSize };
  }

  /** Mark a stamp chip (preset or custom) as the selected stamp. */
  selectStampChip(chip, stamp) {
    this.activeStamp = stamp;
    document.querySelectorAll('.stamp-chip').forEach(c => c.classList.toggle('active', c === chip));
    const name = stamp.label || 'Custom';
    this.showStatus(`${name} stamp selected — click on the page to place it`, 'success');
  }

  /** Read an uploaded image, add it as a selectable thumbnail chip, and select it. */
  onCustomStampUpload(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';   // allow re-uploading the same file later
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result;
      const ratio = await this.imageRatio(dataUrl);
      const chips = document.getElementById('stampChips');
      if (!chips) return;

      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'stamp-chip custom';
      const img = document.createElement('img');
      img.src = dataUrl; img.alt = 'Custom stamp'; img.draggable = false;
      chip.appendChild(img);
      const del = document.createElement('span');
      del.className = 'stamp-chip-x'; del.textContent = '×'; del.title = 'Remove this stamp';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.activeStamp && this.activeStamp.dataUrl === dataUrl) this.activeStamp = null;
        chip.remove();
      });
      chip.appendChild(del);

      const stamp = { label: 'Custom', dataUrl, ratio };
      chip.addEventListener('click', () => this.selectStampChip(chip, stamp));
      chips.appendChild(chip);
      this.selectStampChip(chip, stamp);
    };
    reader.readAsDataURL(file);
  }

  /** Drop the currently-selected stamp (preset or uploaded) centred on the clicked point. */
  placeStamp(xPt, topPt, pv) {
    const s = this.activeStamp;
    let dataUrl, ratio;
    if (s.dataUrl) {                       // uploaded custom stamp — use the image as-is
      dataUrl = s.dataUrl;
      ratio = s.ratio || 0.4;
    } else {                               // preset stamp — rasterise it
      const out = this.renderStamp(s.label, s.color);
      dataUrl = out.dataUrl;
      ratio = out.h / out.w;
    }
    const pageWpt = pv.canvas.width / this.scale;
    const wPt = Math.min(150, pageWpt - 40);
    const hPt = wPt * ratio;

    this.edits.push({
      pageIndex: pv.pageNum,
      redact: false,
      kind: 'image',
      dataUrl,
      x: Math.max(0, Math.min(xPt - wPt / 2, pageWpt - wPt)),
      top: Math.max(0, topPt - hPt / 2),
      width: wPt,
      height: hPt,
    });
    this.commitHistory();
    this.refresh();
    this.showStatus(`${s.label || 'Custom'} stamp added — drag to reposition, resize with the corner`, 'success');
  }

  /**
   * Rasterise a preset stamp (double-ruled rounded box + bold uppercase label, slightly
   * tilted like a rubber stamp) to a trimmed transparent PNG, reusing the image-overlay
   * save pipeline used by signatures.
   */
  renderStamp(label, color) {
    const text = (label || '').toUpperCase();
    const fontPx = 56, padX = 26, padY = 14, outerLW = 5, innerLW = 2.5, radius = 12;
    const angle = -7 * Math.PI / 180;

    const meas = document.createElement('canvas').getContext('2d');
    meas.font = `800 ${fontPx}px Arial, "Helvetica Neue", sans-serif`;
    const boxW = Math.ceil(meas.measureText(text).width) + padX * 2;
    const boxH = fontPx + padY * 2;

    // Square canvas large enough to hold the tilted box plus stroke/margin.
    const size = Math.ceil(Math.hypot(boxW, boxH)) + 40;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const cx = c.getContext('2d');
    cx.translate(size / 2, size / 2);
    cx.rotate(angle);
    cx.strokeStyle = color;
    cx.fillStyle = color;
    this._roundRectPath(cx, -boxW / 2, -boxH / 2, boxW, boxH, radius);
    cx.lineWidth = outerLW; cx.stroke();
    this._roundRectPath(cx, -boxW / 2 + 6, -boxH / 2 + 6, boxW - 12, boxH - 12, Math.max(4, radius - 5));
    cx.lineWidth = innerLW; cx.stroke();
    cx.font = `800 ${fontPx}px Arial, "Helvetica Neue", sans-serif`;
    cx.textAlign = 'center'; cx.textBaseline = 'middle';
    cx.fillText(text, 0, 2);

    return this.trimCanvas(c) || { dataUrl: c.toDataURL('image/png'), w: size, h: size };
  }

  /** Trace a rounded-rectangle path (fallback for canvases without ctx.roundRect). */
  _roundRectPath(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') { ctx.roundRect(x, y, w, h, r); return; }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /**
   * Queue an inserted item (added text or a typed signature) at a click point. The click
   * is treated as the top-left of the text, so the baseline sits ~one ascent below it.
   * It is drawn as a preview now and inserted for real by the backend on Save.
   */
  placeInsert(xPt, topPt, text, fontSize, style, opts = {}, pageNum = this.currentPage) {
    this.edits.push({
      pageIndex: pageNum,
      redact: false,            // nothing to remove — this is an insert, not a replace
      style: style,             // 'text' or 'signature'
      x: xPt,
      baseline: topPt + fontSize * 0.8,
      fontSize: fontSize,
      newText: text,
      fontFamily: opts.fontFamily || 'sans',  // 'sans' | 'serif' | 'mono'
      bold: !!opts.bold,
      italic: !!opts.italic
    });
    this.commitHistory();
    this.renderCurrentPage();
  }

  clearInsertOverlays() {
    const container = document.getElementById('canvasContainer');
    if (container) container.querySelectorAll('.insert-overlay').forEach(el => el.remove());
    this.insertOverlays = [];
  }

  /** Move / proportional-resize / rotate / delete for a drawn-signature image overlay.
   *  Uses POINTER events (not mouse) so dragging works with a finger on touch screens, and marks
   *  the box .sig-active on touch so its handles show (they otherwise only appear on :hover). */
  wireImageOverlay(box, del, handle, rotate, edit, unit) {
    const commit = () => {
      edit.x = parseFloat(box.style.left) / unit;
      edit.top = parseFloat(box.style.top) / unit;
      edit.width = parseFloat(box.style.width) / unit;
      edit.height = parseFloat(box.style.height) / unit;
      this.commitHistory();
    };
    // Show this box's handles (and hide others') — needed on touch, which has no :hover.
    const activate = () => {
      this.insertOverlays.forEach(el => el.classList && el.classList.remove('sig-active'));
      box.classList.add('sig-active');
      this.selectedInsert = edit;
    };
    // A reusable pointer-drag: capture the pointer on `target`, run onMove(dx,dy,ev) until release.
    const drag = (target, e, onMove, onUp) => {
      e.preventDefault(); e.stopPropagation(); activate();
      try { target.setPointerCapture(e.pointerId); } catch (_) {}
      const sx = e.clientX, sy = e.clientY;
      const move = (ev) => onMove(ev.clientX - sx, ev.clientY - sy, ev);
      const up = (ev) => {
        target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', up);
        try { target.releasePointerCapture(e.pointerId); } catch (_) {}
        if (onUp) onUp(ev);
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up);
      target.addEventListener('pointercancel', up);
    };
    // Rotate: drag the top handle around the box centre. Shift snaps to 15°.
    rotate.addEventListener('pointerdown', (e) => {
      const r = box.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;  // centre is invariant under rotation
      drag(rotate, e,
        (dx, dy, ev) => {
          let deg = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI + 90;
          if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
          deg = Math.round(deg);
          edit.rotation = deg;
          box.style.transform = `rotate(${deg}deg)`;
        },
        () => { this.commitHistory(); this.showStatus(`Rotated to ${edit.rotation || 0}°`, 'success'); });
    });
    // Move the whole box.
    box.addEventListener('pointerdown', (e) => {
      if (e.target === del || e.target === handle || e.target === rotate) return;
      const ox = parseFloat(box.style.left), oy = parseFloat(box.style.top);
      drag(box, e,
        (dx, dy) => { box.style.left = (ox + dx) + 'px'; box.style.top = (oy + dy) + 'px'; },
        commit);
    });
    // Proportional resize from the corner handle.
    handle.addEventListener('pointerdown', (e) => {
      const w0 = parseFloat(box.style.width), h0 = parseFloat(box.style.height);
      const ar = h0 / w0;
      drag(handle, e,
        (dx) => { const w = Math.max(24, w0 + dx); box.style.width = w + 'px'; box.style.height = (w * ar) + 'px'; },
        commit);
    });
    // Delete — keep on tap/click (no preventDefault so the tap still produces a click); stop it
    // from starting a box drag.
    del.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
    del.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      this.edits = this.edits.filter(x => x !== edit);
      if (this.selectedInsert === edit) this.selectedInsert = null;
      if (this._ttTarget && this._ttTarget.edit === edit) this.hideTextToolbar();
      this.commitHistory();
      const pv = this.pageViews.find(p => p.pageNum === edit.pageIndex) || this.pageViews[this.currentPage];
      this.refreshPageOverlays(pv);   // overlay-only, single page (fast)
    });
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

  initSignatureDialog() {
    this.signTab = 'draw';
    this.signColor = '#111318';
    this.signPenWidth = 2.8;
    this.signTypeFont = PDFEditorApp.SIGN_FONTS[0];
    this.signImageData = null;

    // Tabs
    document.querySelectorAll('.sign-tab').forEach(tab => {
      tab.addEventListener('click', () => this.setSignTab(tab.dataset.tab));
    });
    // Colours
    document.querySelectorAll('.sign-color').forEach(btn => {
      btn.addEventListener('click', () => {
        this.signColor = btn.dataset.color;
        document.querySelectorAll('.sign-color').forEach(b => b.classList.toggle('active', b === btn));
        this.renderSignFontList();   // recolour the type previews
      });
    });
    // Pen width (Draw tab)
    document.querySelectorAll('.sign-width').forEach(btn => {
      btn.addEventListener('click', () => {
        this.signPenWidth = parseFloat(btn.dataset.width);
        document.querySelectorAll('.sign-width').forEach(b => b.classList.toggle('active', b === btn));
      });
    });
    // Type input -> refresh font previews
    document.getElementById('signTypeInput')?.addEventListener('input', () => this.renderSignFontList());
    // Image upload
    document.getElementById('signImageInput')?.addEventListener('change', (e) => this.onSignImage(e));

    this.initDrawPad();
    this.renderSignFontList();
  }

  initDrawPad() {
    const c = document.getElementById('signPadCanvas');
    if (!c) return;
    const ctx = c.getContext('2d');
    this._padHasInk = false;
    let drawing = false;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
      return { x: cx * (c.width / r.width), y: cy * (c.height / r.height) };
    };
    const start = (e) => { e.preventDefault(); drawing = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); };
    const move = (e) => {
      if (!drawing) return;
      e.preventDefault();
      const p = pos(e);
      ctx.strokeStyle = this.signColor || '#111318';
      ctx.lineWidth = this.signPenWidth || 2.8; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.lineTo(p.x, p.y); ctx.stroke();
      this._padHasInk = true;
    };
    const end = () => { drawing = false; };
    c.addEventListener('mousedown', start);
    c.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    c.addEventListener('touchstart', start, { passive: false });
    c.addEventListener('touchmove', move, { passive: false });
    c.addEventListener('touchend', end);
  }

  setSignTab(tab) {
    this.signTab = tab;
    document.querySelectorAll('.sign-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.sign-panel').forEach(p => { p.hidden = (p.dataset.panel !== tab); });
  }

  /** Render the Type tab's font choices, previewing the entered name in each font/colour. */
  renderSignFontList() {
    const list = document.getElementById('signFontList');
    if (!list) return;
    const name = (document.getElementById('signTypeInput')?.value || '').trim();
    list.innerHTML = '';
    PDFEditorApp.SIGN_FONTS.forEach((font) => {
      const opt = document.createElement('div');
      opt.className = 'sign-font' + (font === this.signTypeFont ? ' active' : '');
      opt.style.fontFamily = font;
      opt.style.color = this.signColor;
      if (name) opt.textContent = name;
      else { const ph = document.createElement('span'); ph.className = 'ph'; ph.textContent = 'Your name'; opt.appendChild(ph); }
      opt.addEventListener('click', () => {
        this.signTypeFont = font;
        list.querySelectorAll('.sign-font').forEach(el => el.classList.toggle('active', el === opt));
      });
      list.appendChild(opt);
    });
  }

  onSignImage(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      this.signImageData = reader.result;
      const img = document.getElementById('signImagePreview');
      const prompt = document.getElementById('signImagePrompt');
      if (img) { img.src = reader.result; img.hidden = false; }
      if (prompt) prompt.hidden = true;
    };
    reader.readAsDataURL(file);
  }

  openSignPad() {
    if (!this.controller.isLoaded) { this.showStatus('Open a PDF first', 'error'); return; }
    this.signPadClear();
    this.setSignTab('draw');
    document.getElementById('signPad')?.classList.add('open');
  }

  closeSignPad() {
    document.getElementById('signPad')?.classList.remove('open');
  }

  /** Branded yes/no dialog. Resolves true (proceed) or false (cancel). */
  confirmDialog(message, opts = {}) {
    return new Promise((resolve) => {
      const back = document.getElementById('confirmDialog');
      const msg = document.getElementById('confirmMessage');
      const ok = document.getElementById('confirmOk');
      const cancel = document.getElementById('confirmCancel');
      const title = document.getElementById('confirmTitle');
      if (!back || !ok || !cancel) { resolve(window.confirm(message)); return; }
      if (title) title.textContent = opts.title || 'Discard your edits?';
      ok.textContent = opts.okText || 'Open new PDF';
      cancel.textContent = opts.cancelText || 'Cancel';
      ok.classList.toggle('confirm-danger', !!opts.danger);   // red confirm for destructive actions
      msg.textContent = message;
      back.classList.add('open');
      const finish = (val) => {
        back.classList.remove('open');
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        resolve(val);
      };
      const onOk = () => finish(true);
      const onCancel = () => finish(false);
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
    });
  }

  signPadClear() {
    const c = document.getElementById('signPadCanvas');
    if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height);
    this._padHasInk = false;
    const ti = document.getElementById('signTypeInput'); if (ti) ti.value = '';
    this.signImageData = null;
    const img = document.getElementById('signImagePreview'); if (img) { img.hidden = true; img.src = ''; }
    const prompt = document.getElementById('signImagePrompt'); if (prompt) prompt.hidden = false;
    this.renderSignFontList();
  }

  async signPadAdd() {
    // Signatures are placed from this dialog rather than a page click, so gate them here too.
    if (!(await this._confirmEditAllowed())) return;
    this.showStatus('Preparing signature…', 'info');   // immediate feedback while we rasterise
    let dataUrl = null, ratio = 0.3;

    if (this.signTab === 'draw') {
      const c = document.getElementById('signPadCanvas');
      const trimmed = c && this._padHasInk ? this.trimCanvas(c) : null;
      if (!trimmed) { this.showStatus('Draw your signature first', 'error'); return; }
      dataUrl = trimmed.dataUrl; ratio = trimmed.h / trimmed.w;
    } else if (this.signTab === 'type') {
      const name = (document.getElementById('signTypeInput')?.value || '').trim();
      if (!name) { this.showStatus('Type your name first', 'error'); return; }
      const out = this.renderTypedSignature(name, this.signTypeFont, this.signColor);
      dataUrl = out.dataUrl; ratio = out.h / out.w;
    } else if (this.signTab === 'image') {
      if (!this.signImageData) { this.showStatus('Choose an image first', 'error'); return; }
      dataUrl = this.signImageData;
      ratio = await this.imageRatio(dataUrl);
    }
    if (!dataUrl) return;

    // Remember it for next time (localStorage, on-device only) and enter ghost-placement mode —
    // a semi-transparent preview follows the cursor; the next click/tap on the page drops it there.
    this.saveSignatureToStore(dataUrl, ratio);
    this.closeSignPad();
    this.startSignaturePlacement(dataUrl, ratio);
  }

  /** Rasterise typed text in a given font/colour to a trimmed transparent PNG. */
  renderTypedSignature(text, fontStack, color) {
    const fontPx = 80, pad = 24;
    const meas = document.createElement('canvas').getContext('2d');
    meas.font = `${fontPx}px ${fontStack}`;
    const w = Math.max(1, Math.ceil(meas.measureText(text).width)) + pad * 2;
    const h = Math.ceil(fontPx * 1.6) + pad;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d');
    cx.font = `${fontPx}px ${fontStack}`;
    cx.fillStyle = color || '#111318';
    cx.textBaseline = 'middle';
    cx.fillText(text, pad, h / 2);
    const trimmed = this.trimCanvas(c) || { dataUrl: c.toDataURL('image/png'), w, h };
    return trimmed;
  }

  /** Natural height/width ratio of an image data-URL. */
  imageRatio(src) {
    return this.loadImage(src).then(im => (im.naturalHeight / im.naturalWidth) || 0.4).catch(() => 0.4);
  }

  /** Crop a canvas to its non-transparent content; returns a trimmed PNG data URL + size. */
  trimCanvas(canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const data = ctx.getImageData(0, 0, w, h).data;
    let minX = w, minY = h, maxX = 0, maxY = 0, found = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > 12) {
          found = true;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (!found) return null;
    const pad = 8;
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
    const tw = maxX - minX + 1, th = maxY - minY + 1;
    const out = document.createElement('canvas');
    out.width = tw; out.height = th;
    out.getContext('2d').drawImage(canvas, minX, minY, tw, th, 0, 0, tw, th);
    return { dataUrl: out.toDataURL('image/png'), w: tw, h: th };
  }

  /** Load a data-URL into an HTMLImageElement (used by the flatten fallback). */
  loadImage(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = src;
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Saved signatures: kept in the browser's own localStorage (nothing ever leaves the device, in
  // keeping with the "files are never stored" promise — this is the user's own signature, on their
  // own machine). Each entry is { dataUrl, ratio, ts }. Capped, most-recent-first.
  // ---------------------------------------------------------------------------------------------
  static get SIG_STORE_KEY() { return 'qpe_signatures'; }
  static get SIG_STORE_MAX() { return 8; }

  loadSavedSignatures() {
    try {
      const a = JSON.parse(localStorage.getItem(PDFEditorApp.SIG_STORE_KEY) || '[]');
      return Array.isArray(a) ? a.filter(s => s && typeof s.dataUrl === 'string') : [];
    } catch (e) { return []; }
  }

  saveSignatureToStore(dataUrl, ratio) {
    if (!dataUrl) return;
    let list = this.loadSavedSignatures().filter(s => s.dataUrl !== dataUrl);
    list.unshift({ dataUrl, ratio: ratio || 0.3, ts: Date.now() });
    list = list.slice(0, PDFEditorApp.SIG_STORE_MAX);
    // If storage is full (large image signatures), drop the oldest and retry until it fits.
    while (list.length) {
      try { localStorage.setItem(PDFEditorApp.SIG_STORE_KEY, JSON.stringify(list)); break; }
      catch (e) { list.pop(); }
    }
  }

  deleteSavedSignature(dataUrl) {
    const list = this.loadSavedSignatures().filter(s => s.dataUrl !== dataUrl);
    try { localStorage.setItem(PDFEditorApp.SIG_STORE_KEY, JSON.stringify(list)); } catch (e) {}
  }

  // ---------------------------------------------------------------------------------------------
  // "Ghost" signature placement (Sejda-style): once a signature is picked/created, a semi-transparent
  // preview follows the cursor/finger over the page; the first click/tap drops it there at full
  // opacity. Only the placement INTERACTION is new — the placed edit, its rendering, resize/move,
  // PDF coordinates, undo and save pipeline are all unchanged.
  // ---------------------------------------------------------------------------------------------

  /** Commit the signature edit at explicit PDF-point coords on a page, then rebuild just that page. */
  _addSignatureEdit(dataUrl, pv, x, top, width, height) {
    const edit = { pageIndex: pv.pageNum, redact: false, kind: 'image', dataUrl, x, top, width, height };
    this.edits.push(edit);
    this.commitHistory();
    this.selectedInsert = edit;
    this.refreshPageOverlays(pv);                          // single-page overlay rebuild (fast)
    const el = this._overlayElFor(edit);
    if (el) el.classList.add('sig-active');
    return edit;
  }

  /** Enter ghost-placement mode: a ~55% opacity preview of the signature follows the cursor over
   *  the PDF; the next click/tap inside a page places it there at full opacity. Esc cancels. */
  startSignaturePlacement(dataUrl, ratio) {
    if (!dataUrl) return;
    this._cancelSignaturePlacement();
    const pv0 = this.pageViews[this.currentPage] || this.pageViews[0];
    const pageWpt = pv0 ? pv0.canvas.width / this.scale : 612;
    const wPt = Math.min(180, pageWpt - 40);
    const hPt = wPt * (ratio || 0.3);
    const ds = pv0 ? (pv0.canvas.clientWidth || pv0.canvas.width) / pv0.canvas.width : 1;
    const unit = this.scale * ds;

    const ghost = document.createElement('img');
    ghost.className = 'sig-ghost';
    ghost.src = dataUrl; ghost.draggable = false; ghost.alt = '';
    ghost.style.width = (wPt * unit) + 'px';
    ghost.style.height = (hPt * unit) + 'px';
    ghost.style.display = 'none';
    document.body.appendChild(ghost);

    const stage = document.getElementById('stage');
    const state = { el: ghost, dataUrl, ratio: ratio || 0.3, wPt, hPt, gw: wPt * unit, gh: hPt * unit, x: 0, y: 0, over: false, raf: null };
    this._sigPlacement = state;
    document.body.classList.add('placing-signature');
    this.showStatus('Move over the page and click to place your signature · Esc to cancel', 'info');

    // The ghost stays hidden until the cursor/finger is actually over the page — so it only ever
    // appears attached to the cursor (no brief flash at the page centre before the first move).

    // rAF loop keeps the ghost glued to the cursor with no layout thrash / flicker.
    const tick = () => {
      if (this._sigPlacement !== state) return;
      state.el.style.display = state.over ? 'block' : 'none';
      if (state.over) state.el.style.transform = `translate(${Math.round(state.x - state.gw / 2)}px, ${Math.round(state.y - state.gh / 2)}px)`;
      state.raf = requestAnimationFrame(tick);
    };
    state.raf = requestAnimationFrame(tick);

    const pt = (e) => (e.touches && e.touches[0]) ? e.touches[0] : e;
    state.onMove = (e) => {                                // pointermove (hover) + pointerdown (touch)
      const p = pt(e); state.x = p.clientX; state.y = p.clientY;
      const el = document.elementFromPoint(p.clientX, p.clientY);
      state.over = !!(el && el.closest && el.closest('.page-wrap'));   // ignore movement off the PDF
    };
    state.onClick = (e) => {
      const p = pt(e);
      const el = document.elementFromPoint(p.clientX, p.clientY);
      const wrap = el && el.closest && el.closest('.page-wrap');
      if (!wrap) return;                                   // clicked outside the PDF -> ignore
      const pv = this.pageViews.find(v => v.wrapper === wrap || v.wrapper.contains(wrap));
      if (!pv) return;
      e.preventDefault(); e.stopPropagation();             // pre-empt the canvas add-text click
      const rect = pv.canvas.getBoundingClientRect();
      const toIntrinsic = pv.canvas.width / rect.width;    // same screen->PDF mapping as add-text
      const pageWp = pv.canvas.width / this.scale, pageHp = pv.canvas.height / this.scale;
      let x = ((p.clientX - rect.left) * toIntrinsic) / this.scale - state.wPt / 2;
      let top = ((p.clientY - rect.top) * toIntrinsic) / this.scale - state.hPt / 2;
      x = Math.max(0, Math.min(pageWp - state.wPt, x));
      top = Math.max(0, Math.min(pageHp - state.hPt, top));
      this._addSignatureEdit(state.dataUrl, pv, x, top, state.wPt, state.hPt);
      this._cancelSignaturePlacement();
    };
    state.onKey = (e) => { if (e.key === 'Escape') this._cancelSignaturePlacement(); };

    window.addEventListener('pointermove', state.onMove, true);
    window.addEventListener('pointerdown', state.onMove, true);   // touch: jump the ghost under the finger
    if (stage) stage.addEventListener('click', state.onClick, true);
    window.addEventListener('keydown', state.onKey, true);
  }

  _cancelSignaturePlacement() {
    const s = this._sigPlacement;
    if (!s) return;
    this._sigPlacement = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    if (s.el && s.el.parentNode) s.el.parentNode.removeChild(s.el);
    window.removeEventListener('pointermove', s.onMove, true);
    window.removeEventListener('pointerdown', s.onMove, true);
    document.getElementById('stage')?.removeEventListener('click', s.onClick, true);
    window.removeEventListener('keydown', s.onKey, true);
    document.body.classList.remove('placing-signature');
  }

  /** Place a previously-saved signature (chosen from the picker): start ghost-placement mode. */
  async placeSavedSignature(sig) {
    if (!sig || !sig.dataUrl) return;
    this.closeSignPicker();
    if (!(await this._confirmEditAllowed())) return;
    this.saveSignatureToStore(sig.dataUrl, sig.ratio);     // bump it to most-recent
    this.showStatus('Preparing signature…', 'info');
    this.startSignaturePlacement(sig.dataUrl, sig.ratio);
  }

  // ----- Signature picker: tap Sign -> a small list of saved signatures + "Add new signature" -----
  openSignFlow() {
    if (!this.controller.isLoaded) { this.showStatus('Open a PDF first', 'error'); return; }
    const saved = this.loadSavedSignatures();
    if (saved.length) this.openSignPicker(saved);
    else this.openSignPad();                              // nothing saved yet -> straight to the pad
  }

  openSignPicker(saved) {
    const pop = document.getElementById('signPicker');
    const list = document.getElementById('signPickerList');
    if (!pop || !list) { this.openSignPad(); return; }
    list.innerHTML = '';
    (saved || this.loadSavedSignatures()).forEach(sig => {
      const item = document.createElement('div');
      item.className = 'sign-pick-item';
      const pick = document.createElement('button');
      pick.type = 'button'; pick.className = 'sign-pick-thumb'; pick.title = 'Place this signature';
      const img = document.createElement('img'); img.src = sig.dataUrl; img.alt = 'Saved signature'; img.draggable = false;
      pick.appendChild(img);
      pick.addEventListener('click', () => this.placeSavedSignature(sig));
      const rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'sign-pick-del'; rm.title = 'Remove this saved signature'; rm.textContent = '×';
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteSavedSignature(sig.dataUrl);
        const left = this.loadSavedSignatures();
        if (left.length) this.openSignPicker(left); else { this.closeSignPicker(); this.openSignPad(); }
      });
      item.appendChild(pick); item.appendChild(rm);
      list.appendChild(item);
    });
    pop.hidden = false;
    this.positionSignPicker();
    this._signPickerOpen = true;
  }

  closeSignPicker() {
    const pop = document.getElementById('signPicker');
    if (pop) pop.hidden = true;
    this._signPickerOpen = false;
  }

  positionSignPicker() {
    const btn = document.getElementById('signatureModeBtn');
    const pop = document.getElementById('signPicker');
    if (!btn || !pop) return;
    const r = btn.getBoundingClientRect();
    const pw = pop.offsetWidth || 220, ph = pop.offsetHeight || 200;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left, top;
    if (r.bottom > vh - 170) {                    // button low on screen (mobile bottom dock) -> above it
      top = Math.max(8, r.top - ph - 8);
      left = Math.min(Math.max(8, r.left + r.width / 2 - pw / 2), vw - pw - 8);
    } else {                                       // desktop left rail -> to the right of the button
      left = Math.min(r.right + 8, vw - pw - 8);
      top = Math.min(Math.max(8, r.top), vh - ph - 8);
    }
    pop.style.left = Math.max(8, left) + 'px';
    pop.style.top = Math.max(8, top) + 'px';
  }

  /**
   * Render each pending insert (added text / signature) as a draggable, resizable overlay
   * so the user can move it into place and size it. Dragging updates the edit's position;
   * the resize handle changes its font size; the × button deletes it. All changes are
   * undoable and are written into the PDF (at the same spot) on Save.
   */
  createInsertOverlays(pv) {
    const wrap = pv.wrapper;
    if (!wrap) return;
    const ds = (pv.canvas.clientWidth || pv.canvas.width) / pv.canvas.width;
    const unit = this.scale * ds;  // PDF points -> displayed CSS px
    const inserts = this.edits.filter(e =>
      e.redact === false && e.pageIndex === pv.pageNum && (e.newText || e.kind === 'image'));

    inserts.forEach(edit => {
      // Drawn-signature image overlay
      if (edit.kind === 'image' && edit.dataUrl) {
        const box = document.createElement('div');
        box.className = 'insert-overlay insert-image';
        box.__edit = edit;                 // lets _overlayElFor find it (scroll-into-view / activation)
        if (edit === this.selectedInsert) box.classList.add('sig-active');
        box.style.left = (edit.x * unit) + 'px';
        box.style.top = (edit.top * unit) + 'px';
        box.style.width = (edit.width * unit) + 'px';
        box.style.height = (edit.height * unit) + 'px';
        box.style.transform = `rotate(${edit.rotation || 0}deg)`;
        const img = document.createElement('img');
        img.src = edit.dataUrl;
        img.draggable = false;
        box.appendChild(img);
        const delI = document.createElement('div');
        delI.className = 'insert-del';
        delI.textContent = '×';
        const handleI = document.createElement('div');
        handleI.className = 'insert-handle';
        const rotateI = document.createElement('div');
        rotateI.className = 'insert-rotate';
        rotateI.title = 'Drag to rotate (hold Shift to snap to 15°)';
        box.appendChild(delI);
        box.appendChild(handleI);
        box.appendChild(rotateI);
        this.wireImageOverlay(box, delI, handleI, rotateI, edit, unit);
        wrap.appendChild(box);
        this.insertOverlays.push(box);
        return;
      }

      const fontPx = edit.fontSize * unit;
      const ascent = fontPx * 0.8;

      const div = document.createElement('div');
      div.className = 'insert-overlay';
      div.__edit = edit;                 // lets openInsertEditor find/hide this overlay on re-edit
      if (edit === this.selectedInsert) div.classList.add('selected');
      // Editor-only "linked" affordance (not exported) for a whole-box link or any per-run link.
      if (edit.link || (edit.runs && edit.runs.some(ln => ln.some(r => r.link)))) div.classList.add('tt-has-link');
      // Added text may carry per-run size / bold / italic / underline / colour / link — render each run.
      if (edit.style !== 'signature' && edit.runs && edit.runs.length) {
        const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        div.innerHTML = edit.runs.map(line =>
          line.map(r => {
            const css = `font-size:${r.size * unit}px;font-weight:${r.bold ? 'bold' : 'normal'};font-style:${r.italic ? 'italic' : 'normal'}`
              + (r.underline || r.link ? ';text-decoration:underline' : '') + (r.color ? `;color:${this._rgbCss(r.color)}` : '');
            return `<span style="${css}">${esc(r.text)}</span>`;
          }).join('')
        ).join('<br>');
      } else {
        div.textContent = edit.newText;
      }
      div.style.left = (edit.x * unit) + 'px';
      div.style.fontSize = fontPx + 'px';
      if (edit.style === 'signature') {
        div.style.top = (edit.baseline * unit - ascent) + 'px';
        div.style.lineHeight = fontPx + 'px';
        div.style.fontStyle = 'italic';
        div.style.fontWeight = 'normal';
        div.style.fontFamily = '"Snell Roundhand","Apple Chancery","Brush Script MT",cursive';
      } else {
        // Added text: render multi-line (line breaks preserved) and double-click to re-edit.
        div.style.top = (edit.baseline * unit - fontPx * 0.9) + 'px';
        // Unitless line-height lets each line follow its own tallest run (mixed sizes).
        div.style.lineHeight = (edit.runs && edit.runs.length) ? '1.2' : (fontPx * 1.2) + 'px';
        div.style.whiteSpace = 'pre-wrap';
        div.style.fontWeight = edit.bold ? 'bold' : 'normal';
        div.style.fontStyle = edit.italic ? 'italic' : 'normal';
        div.style.fontFamily = this._familyCss(edit.fontFamily);
        // Whole-box styles set via the floating toolbar (color / underline / opacity / alignment)
        // must survive the commit + static re-render, exactly as the live editor showed them.
        if (edit.color != null) div.style.color = this._rgbCss(edit.color);
        if (edit.underline) div.style.textDecoration = 'underline';
        if (edit.opacity != null) div.style.opacity = edit.opacity;
        if (edit.align) div.style.textAlign = edit.align;
        div.title = 'Click to edit (select part to style/link it) · drag to move · rotate with the top handle';
        div.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); this.openInsertEditor(edit, pv, false); });
        // Rotation pivots on the text origin (left edge at the baseline) so the saved PDF matches.
        if (edit.rotation) {
          div.style.transformOrigin = '0px ' + (fontPx * 0.9) + 'px';
          div.style.transform = `rotate(${edit.rotation}deg)`;
        }
      }

      const del = document.createElement('div');
      del.className = 'insert-del';
      del.textContent = '×';
      const handle = document.createElement('div');
      handle.className = 'insert-handle';
      div.appendChild(del);
      div.appendChild(handle);
      // Added text can be rotated to any angle (signatures use the image overlay's own handle).
      let rotate = null;
      if (edit.style !== 'signature') {
        rotate = document.createElement('div');
        rotate.className = 'insert-rotate';
        rotate.title = 'Drag to rotate (hold Shift to snap to 15°)';
        div.appendChild(rotate);
      }

      this.wireInsertOverlay(div, del, handle, rotate, edit, unit, pv);
      wrap.appendChild(div);
      this.insertOverlays.push(div);
    });
  }

  /** Select an added-text box (shows the selected outline; double-click it to edit/resize). */
  selectInsert(edit) {
    this.selectedInsert = edit;
    this.insertOverlays.forEach(o => o.classList.toggle('selected', !!edit && o.__edit === edit));
    if (edit) this._showTextToolbar({ kind: 'overlay', el: this._overlayElFor(edit), edit });
    else if (this._ttTarget && this._ttTarget.kind === 'overlay') this.hideTextToolbar();
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
  _hexToRgb(h) { h = (h || '').replace('#', ''); return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0]; }
  _rgbCss(c) { return Array.isArray(c) ? `rgb(${c[0]},${c[1]},${c[2]})` : (c || '#000'); }
  _rgbToHex(c) { return Array.isArray(c) ? '#' + c.map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('') : '#000000'; }
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

  /** Best-guess catalogue key from a PDF font NAME, incl. the open SUBSTITUTE actually embedded
   *  (e.g. 'Carlito' -> calibri, 'Inter' -> inter) so a saved+reopened font shows its name again.
   *  Returns '' for a font the picker doesn't offer (e.g. Computer Modern) -> placeholder. */
  _familyKeyFromFont(name) {
    const n = (name || '').toLowerCase();
    if (!n) return '';
    // Ordered most-specific-first; matches both the real face and its embedded open substitute.
    const hits = [
      ['ibm plex mono', 'ibmplexmono'], ['ibmplex', 'ibmplexmono'], ['jetbrains', 'jetbrainsmono'],
      ['source code', 'sourcecodepro'], ['fira code', 'firacode'], ['firacode', 'firacode'],
      ['source sans', 'sourcesans'], ['sourcesans', 'sourcesans'],
      ['libre baskerville', 'librebaskerville'], ['librebaskerville', 'librebaskerville'], ['baskerville', 'baskerville'],
      ['playfair', 'playfair'], ['noto serif', 'notoserif'], ['notoserif', 'notoserif'],
      ['eb garamond', 'garamond'], ['ebgaramond', 'garamond'], ['garamond', 'garamond'],
      ['merriweather', 'merriweather'], ['pt sans', 'ptsans'], ['ptsans', 'ptsans'],
      ['poppins', 'poppins'], ['nunito', 'nunito'], ['ubuntu', 'ubuntu'], ['lato', 'lato'], ['inter', 'inter'],
      ['carlito', 'calibri'], ['calibri', 'calibri'], ['caladea', 'cambria'], ['cambria', 'cambria'],
      ['consolas', 'consolas'], ['trebuchet', 'trebuchet'], ['tahoma', 'tahoma'], ['palatino', 'palatino'],
      ['comic neue', 'comicneue'], ['comicneue', 'comicneue'], ['comic', 'comicsans'],
      ['pacifico', 'pacifico'], ['brush script', 'brushscript'], ['brushscript', 'brushscript'],
      ['arimo', 'arial'], ['arial', 'arial'], ['helvetica', 'helvetica'], ['verdana', 'verdana'],
      ['tinos', 'times'], ['times', 'times'], ['cousine', 'courier'], ['courier', 'courier'],
      ['gelasio', 'georgia'], ['georgia', 'georgia'], ['roboto', 'roboto'],
      ['open sans', 'opensans'], ['opensans', 'opensans'], ['montserrat', 'montserrat'],
    ];
    for (const [needle, key] of hits) if (n.includes(needle)) return key;
    return '';
  }

  /** The catalogue key to SHOW for a target: an explicit family override, else a guess from the PDF
   *  font name, else '' (-> the "Select a Font Style" placeholder). */
  _displayFontKey(fam, fontName) {
    return this._normFamilyKey(fam) || this._familyKeyFromFont(fontName) || '';
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
  _setFontPickerValue(key) {
    const k = (key || '').toLowerCase();
    const hidden = document.getElementById('tt-font');
    const label = document.getElementById('tt-font-label');
    const e = PDFEditorApp._FONT_BY_KEY[k];
    if (hidden) hidden.value = e ? k : '';
    if (label) {
      label.textContent = e ? e.name : 'Select a Font Style';
      label.style.fontFamily = e ? e.css : '';
    }
  }

  /** Build the Sejda-style swatch palette popover and wire it to applyTextStyle('color', …). */
  _initColorPalette() {
    const btn = document.getElementById('tt-color-btn');
    const pop = document.getElementById('tt-color-pop');
    if (!btn || !pop) return;
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
      sw.addEventListener('mousedown', (e) => e.preventDefault());   // keep the editor focused
      sw.addEventListener('click', () => { this.applyTextStyle('color', this._hexToRgb(hex)); this._setColorSwatch(hex); pop.hidden = true; });
      pop.appendChild(sw);
    });
    // A "custom" native picker for anything outside the palette.
    const custom = document.createElement('label');
    custom.className = 'tt-sw tt-sw-custom'; custom.title = 'Custom colour';
    custom.innerHTML = 'Custom <input type="color" id="tt-color-custom" value="#000000" title="Custom colour" aria-label="Custom colour">';
    custom.addEventListener('mousedown', (e) => { if (e.target.tagName !== 'INPUT') e.preventDefault(); });
    pop.appendChild(custom);
    custom.querySelector('input').addEventListener('input', (e) => { this.applyTextStyle('color', this._hexToRgb(e.target.value)); this._setColorSwatch(e.target.value); });

    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => { pop.hidden = !pop.hidden; });
    // Close on a click outside the colour control.
    document.addEventListener('mousedown', (e) => { if (!pop.hidden && !e.target.closest('.tt-color-wrap')) pop.hidden = true; }, true);
  }

  _setColorSwatch(hex) { const sw = document.getElementById('tt-color-sw'); if (sw) sw.style.background = hex; }

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
    let bold = !!o.bold, italic = !!o.italic;
    if (t.kind === 'overlay' && o.runs && o.runs.length) {
      const flat = o.runs.flat();
      if (flat.length) { bold = flat.every(r => r.bold); italic = flat.every(r => r.italic); }
    }
    return { bold, italic, underline: !!o.underline, size,
             color: o.color, opacity: o.opacity, align: o.align,
             link: o.link ? o.link.uri : '',
             // Prefer the REAL font name (from PDF.js's rendered font object) so a saved+reopened font
             // re-selects in the picker; fall back to the generic guess before the page has resolved.
             family: this._displayFontKey(o.fontFamily, this._realFontName(o) || o.fontFamilyName || o.fontName) };
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
    // Always reflect the font: a known family shows its name; an unknown one ('') shows the
    // "Select a Font Style" placeholder so the picker is never blank.
    this._setFontPickerValue(s.family || '');
    this._setColorSwatch(s.color ? this._rgbToHex(s.color) : '#000000');
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
      if (l.color == null) { l.color = BLUE; div.style.color = this._rgbCss(BLUE); }
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
    if (edit.color == null) { edit.color = PDFEditorApp.LINK_BLUE; if (el) el.style.color = this._rgbCss(edit.color); }
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
    else if (kind === 'color') div.style.color = this._rgbCss(value);
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
    if (kind === 'bold') { l.bold = !!value; div.style.fontWeight = value ? 'bold' : 'normal'; }
    else if (kind === 'italic') { l.italic = !!value; div.style.fontStyle = value ? 'italic' : 'normal'; }
    else if (kind === 'underline') { l.underline = !!value; div.style.textDecoration = value ? 'underline' : 'none'; }
    else if (kind === 'size') { l.fontSizePx = value * this.scale; l.sizeOverridden = true; div.style.fontSize = (value * this.scale * (div.__displayScale || 1)) + 'px'; }
    else if (kind === 'color') { l.color = value; div.style.color = this._rgbCss(value); }
    else if (kind === 'opacity') { l.opacity = value; div.style.opacity = value; }
    else if (kind === 'align') { l.align = value; div.style.textAlign = value; }
    else if (kind === 'family') { l.fontFamily = value; div.style.fontFamily = this._familyCss(value); }
    else if (kind === 'link') { this._setLink(l, value); div.classList.toggle('tt-has-link', !!l.link); }
    this.trackEdit(this.lineToEdit(l, this.cleanEditableText(div.textContent)));
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

  /** Attach move / resize / rotate / delete behaviour to one insert overlay. */
  wireInsertOverlay(div, del, handle, rotate, edit, unit, pv) {
    const commitFromDiv = () => {
      const fontPx = parseFloat(div.style.fontSize);
      const topOffset = edit.style === 'signature' ? fontPx * 0.8 : fontPx * 0.9;
      // With mixed run sizes, the representative size is the largest run.
      edit.fontSize = (edit.runs && edit.runs.length)
        ? Math.max(...edit.runs.flat().map(r => r.size))
        : fontPx / unit;
      edit.x = parseFloat(div.style.left) / unit;
      edit.baseline = (parseFloat(div.style.top) + topOffset) / unit;
      this.commitHistory();
    };

    // Rotate: drag the top handle around the text origin (left edge at the baseline). That pivot
    // is fixed by the transform-origin, so it stays put under rotation. Shift snaps to 15°.
    if (rotate) {
      rotate.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        const parent = div.parentElement;
        if (!parent) return;        // overlay was just re-rendered (e.g. committing an open editor)
        const wrapRect = parent.getBoundingClientRect();
        const fontPx = parseFloat(div.style.fontSize);
        const pivotX = wrapRect.left + parseFloat(div.style.left);
        const pivotY = wrapRect.top + parseFloat(div.style.top) + fontPx * 0.9;
        div.style.transformOrigin = '0px ' + (fontPx * 0.9) + 'px';
        // Rotate by the change in pointer angle since grab (1:1 drag, no jump). The handle sits
        // away from the origin pivot, so an absolute angle would start offset; a delta doesn't.
        const startRot = edit.rotation || 0;
        const startAngle = Math.atan2(e.clientY - pivotY, e.clientX - pivotX);
        const move = (ev) => {
          let deg = startRot + (Math.atan2(ev.clientY - pivotY, ev.clientX - pivotX) - startAngle) * 180 / Math.PI;
          if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
          deg = Math.round(deg);
          edit.rotation = deg;
          div.style.transform = `rotate(${deg}deg)`;
        };
        const up = () => {
          window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
          this.commitHistory();
          this.showStatus(`Rotated to ${edit.rotation || 0}°`, 'success');
        };
        window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
      });
    }

    // Move (drag the body)
    div.addEventListener('mousedown', (e) => {
      if (e.target === del || e.target === handle || e.target === rotate) return;
      const isText = edit.style !== 'signature';
      if (isText) this.selectInsert(edit);   // clicking a text box selects it
      e.preventDefault(); e.stopPropagation();
      const sx = e.clientX, sy = e.clientY;
      const ox = parseFloat(div.style.left), oy = parseFloat(div.style.top);
      let dragged = false;
      const move = (ev) => {
        if (!dragged && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 4) return;   // ignore jitter
        dragged = true;
        div.style.left = (ox + ev.clientX - sx) + 'px';
        div.style.top = (oy + ev.clientY - sy) + 'px';
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        // A drag moves the box; a plain click on a TEXT box opens its editor so the user can place a
        // caret and select PART of the text to style or hyperlink (mirrors Canva/Figma text boxes).
        if (dragged) commitFromDiv();
        else if (isText && pv) this.openInsertEditor(edit, pv, false);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });

    // Resize (drag the corner handle = scale the font size). For a mixed-size box every run
    // scales by the same factor so their relative sizes are preserved.
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const sy = e.clientY;
      const startFont = parseFloat(div.style.fontSize);
      const hasRuns = !!(edit.runs && edit.runs.length);
      const spans = hasRuns ? Array.from(div.querySelectorAll('span')) : [];
      const spanStart = spans.map(s => parseFloat(s.style.fontSize) || startFont);
      let factor = 1;
      const move = (ev) => {
        const f = Math.max(8, startFont + (ev.clientY - sy));
        factor = f / startFont;
        div.style.fontSize = f + 'px';
        div.style.lineHeight = hasRuns ? '1.2' : f + 'px';
        spans.forEach((s, i) => { s.style.fontSize = (spanStart[i] * factor) + 'px'; });
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        if (hasRuns && factor !== 1) {
          edit.runs = edit.runs.map(line =>
            line.map(r => ({ text: r.text, size: Math.max(4, Math.round(r.size * factor)), bold: !!r.bold, italic: !!r.italic })));
        }
        commitFromDiv();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });

    // Delete
    del.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    del.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      this.edits = this.edits.filter(x => x !== edit);
      if (this.selectedInsert === edit) this.selectedInsert = null;
      if (this._ttTarget && this._ttTarget.edit === edit) this.hideTextToolbar();
      this.commitHistory();
      this.renderCurrentPage();
    });
  }

  // ----- Undo / redo (snapshots of this.edits) -----
  snapshotEdits() { return this.edits.map(e => ({ ...e })); }

  commitHistory() {
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(this.snapshotEdits());
    this.historyIndex = this.history.length - 1;
    this.updateHistoryButtons();
  }

  resetHistory() {
    this.history = [this.snapshotEdits()];
    this.historyIndex = 0;
    this.updateHistoryButtons();
  }

  undo() {
    if (this.historyIndex <= 0) return;
    this.historyIndex--;
    this.edits = this.history[this.historyIndex].map(e => ({ ...e }));
    this.updateHistoryButtons();
    this.renderCurrentPage();
    this.showStatus('Undo', 'info');
  }

  redo() {
    if (this.historyIndex >= this.history.length - 1) return;
    this.historyIndex++;
    this.edits = this.history[this.historyIndex].map(e => ({ ...e }));
    this.updateHistoryButtons();
    this.renderCurrentPage();
    this.showStatus('Redo', 'info');
  }

  updateHistoryButtons() {
    const u = document.getElementById('undoBtn');
    const r = document.getElementById('redoBtn');
    if (u) u.disabled = this.historyIndex <= 0;
    if (r) r.disabled = this.historyIndex >= this.history.length - 1;
  }

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
  onEraseStart(event, pv) {
    if (this.mode !== 'erase' || !this.controller.isLoaded) return;
    event.preventDefault();
    const rect = pv.canvas.getBoundingClientRect();
    this.eraseDrag = { startX: event.clientX, startY: event.clientY, rect, pv };
    const wrap = pv.wrapper;
    const sel = document.createElement('div');
    sel.style.position = 'absolute';
    sel.style.border = '1.5px dashed #e5484d';
    sel.style.background = 'rgba(229,72,77,0.12)';
    sel.style.zIndex = '300';
    sel.style.pointerEvents = 'none';
    wrap.appendChild(sel);
    this.eraseSel = sel;
  }

  onEraseMove(event) {
    if (!this.eraseDrag) return;
    const r = this.eraseDrag.rect;
    const x0 = this.eraseDrag.startX - r.left, y0 = this.eraseDrag.startY - r.top;
    const x1 = event.clientX - r.left, y1 = event.clientY - r.top;
    this.eraseSel.style.left = Math.min(x0, x1) + 'px';
    this.eraseSel.style.top = Math.min(y0, y1) + 'px';
    this.eraseSel.style.width = Math.abs(x1 - x0) + 'px';
    this.eraseSel.style.height = Math.abs(y1 - y0) + 'px';
  }

  onEraseEnd(event) {
    if (!this.eraseDrag) return;
    const r = this.eraseDrag.rect;
    const pv = this.eraseDrag.pv;
    const x0 = this.eraseDrag.startX - r.left, y0 = this.eraseDrag.startY - r.top;
    const x1 = event.clientX - r.left, y1 = event.clientY - r.top;
    if (this.eraseSel) { this.eraseSel.remove(); this.eraseSel = null; }
    this.eraseDrag = null;

    const leftCss = Math.min(x0, x1), topCss = Math.min(y0, y1);
    const wCss = Math.abs(x1 - x0), hCss = Math.abs(y1 - y0);
    if (!pv || wCss < 4 || hCss < 4) return;  // ignore stray clicks

    // Displayed px -> that page's intrinsic canvas px -> PDF points (top-left origin).
    const toIntrinsic = pv.canvas.width / r.width;
    const xPt = (leftCss * toIntrinsic) / this.scale;
    const topPt = (topCss * toIntrinsic) / this.scale;
    const wPt = (wCss * toIntrinsic) / this.scale;
    const hPt = (hCss * toIntrinsic) / this.scale;

    this.edits.push({
      pageIndex: pv.pageNum,
      kind: 'erase',
      x: xPt,
      right: xPt + wPt,
      top: topPt,
      bottom: topPt + hPt,
      newText: ''
    });
    this.commitHistory();
    this.showStatus('Area erased — click Save to apply (Clear to undo)', 'success');
    this.renderCurrentPage();
  }

  // ---------------------------------------------------------------------------
  // Pages manager: a drawer of page thumbnails the user can reorder (drag),
  // delete (hover trash), or extend with blank pages. Each operation rebuilds the
  // document with pdf-lib and reloads it, so the thumbnails, the scrollable page
  // view, and the eventual Save output all stay in lockstep automatically.
  // ---------------------------------------------------------------------------

  togglePagesPanel() {
    const open = document.getElementById('pagesDrawer')?.classList.contains('open');
    if (open) this.closePagesPanel(); else this.openPagesPanel();
  }

  openPagesPanel() {
    if (!this.controller.isLoaded || !this.pdfJsDoc) {
      this.showStatus('Open a PDF first', 'error');
      return;
    }
    this.selectedThumb = null;
    document.getElementById('pagesBackdrop')?.classList.add('open');
    document.getElementById('pagesDrawer')?.classList.add('open');
    this.renderPagesPanel();
  }

  closePagesPanel() {
    document.getElementById('pagesBackdrop')?.classList.remove('open');
    document.getElementById('pagesDrawer')?.classList.remove('open');
  }

  /** Build the thumbnail grid + the "insert position" dropdown from the current document. */
  renderPagesPanel() {
    const grid = document.getElementById('pagesGrid');
    if (!grid || !this.pdfJsDoc) return;
    const n = this.pdfJsDoc.numPages;

    const count = document.getElementById('pagesCount');
    if (count) count.textContent = `${n} page${n === 1 ? '' : 's'}`;
    this.rebuildInsertPosOptions(n);

    grid.innerHTML = '';
    const hint = document.createElement('div');
    hint.className = 'pages-hint';
    hint.textContent = 'Drag to reorder · hover to delete';
    grid.appendChild(hint);

    for (let i = 0; i < n; i++) {
      const thumb = document.createElement('div');
      thumb.className = 'page-thumb';
      thumb.draggable = true;
      thumb.dataset.index = String(i);
      if (i === this.selectedThumb) thumb.classList.add('selected');

      const canvas = document.createElement('canvas');
      canvas.className = 'thumb-canvas';
      thumb.appendChild(canvas);

      const del = document.createElement('button');
      del.className = 'page-thumb-del';
      del.title = 'Delete this page';
      del.setAttribute('aria-label', `Delete page ${i + 1}`);
      del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="m7 7 1 13h8l1-13"/></svg>';
      del.addEventListener('click', (e) => { e.stopPropagation(); this.deletePage(i); });
      thumb.appendChild(del);

      const num = document.createElement('div');
      num.className = 'thumb-num';
      num.textContent = `Page ${i + 1}`;
      thumb.appendChild(num);

      thumb.addEventListener('click', () => this.selectThumb(i));
      this.wireThumbDnD(thumb);
      grid.appendChild(thumb);

      this.renderThumbCanvas(canvas, i);   // async paint; doesn't block the drawer opening
    }
  }

  /** Render page `pageIndex` into the small thumbnail canvas (crisp on HiDPI screens). */
  async renderThumbCanvas(canvas, pageIndex) {
    try {
      const page = await this.pdfJsDoc.getPage(pageIndex + 1);
      const base = page.getViewport({ scale: 1 });
      const dpr = window.devicePixelRatio || 1;
      const scale = (130 / base.width) * dpr;
      const vp = page.getViewport({ scale });
      canvas.width = vp.width;
      canvas.height = vp.height;
      canvas.style.aspectRatio = `${base.width} / ${base.height}`;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
    } catch (e) {
      console.warn('Thumbnail render failed for page', pageIndex, e);
    }
  }

  /** Rebuild the "Insert at" dropdown: After page 1…N, plus End of document. */
  rebuildInsertPosOptions(n) {
    const sel = document.getElementById('insertPos');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `After page ${i + 1}`;
      sel.appendChild(opt);
    }
    const end = document.createElement('option');
    end.value = 'end';
    end.textContent = 'End of document';
    sel.appendChild(end);
    sel.value = (prev === 'end' || (prev !== '' && parseInt(prev, 10) < n)) ? prev : 'end';
  }

  /** Click a thumbnail to select it (sets "insert after this page"); click again to clear. */
  selectThumb(i) {
    this.selectedThumb = (this.selectedThumb === i) ? null : i;
    document.querySelectorAll('#pagesGrid .page-thumb').forEach((el) => {
      el.classList.toggle('selected', Number(el.dataset.index) === this.selectedThumb);
    });
    const sel = document.getElementById('insertPos');
    if (sel) sel.value = (this.selectedThumb == null) ? 'end' : String(this.selectedThumb);
  }

  /** Native HTML5 drag-and-drop wiring for one thumbnail. */
  wireThumbDnD(thumb) {
    thumb.addEventListener('dragstart', (e) => {
      this._dragFrom = Number(thumb.dataset.index);
      thumb.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', thumb.dataset.index);
      }
    });
    thumb.addEventListener('dragend', () => {
      thumb.classList.remove('dragging');
      this.clearDropMarkers();
    });
    thumb.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const rect = thumb.getBoundingClientRect();
      const after = (e.clientX - rect.left) > rect.width / 2;
      this.clearDropMarkers();
      thumb.classList.add(after ? 'drop-after' : 'drop-before');
    });
    thumb.addEventListener('dragleave', () => {
      thumb.classList.remove('drop-before', 'drop-after');
    });
    thumb.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = this._dragFrom;
      const j = Number(thumb.dataset.index);
      const after = thumb.classList.contains('drop-after');
      this.clearDropMarkers();
      this._dragFrom = null;
      if (from == null || Number.isNaN(from)) return;
      this.movePage(from, after ? j + 1 : j);   // insert before original index (after ? j+1 : j)
    });
  }

  clearDropMarkers() {
    document.querySelectorAll('#pagesGrid .page-thumb.drop-before, #pagesGrid .page-thumb.drop-after')
      .forEach(el => el.classList.remove('drop-before', 'drop-after'));
  }

  /** Move page `from` so it lands immediately before original index `insertBefore`. */
  movePage(from, insertBefore) {
    if (insertBefore === from || insertBefore === from + 1) return;   // dropped back in place
    const n = this.pdfJsDoc.numPages;
    const order = [];
    for (let i = 0; i < n; i++) {
      if (i === insertBefore) order.push({ src: from });
      if (i !== from) order.push({ src: i });
    }
    if (insertBefore >= n) order.push({ src: from });   // moved to the very end
    this.commitPageOrder(order, 'Pages reordered.', 'Reordering pages…');
  }

  /** Remove a page (never the last remaining one). */
  deletePage(index) {
    const n = this.pdfJsDoc.numPages;
    if (n <= 1) { this.showStatus('A PDF must keep at least one page.', 'error'); return; }
    if (this.selectedThumb === index) this.selectedThumb = null;
    const order = [];
    for (let i = 0; i < n; i++) if (i !== index) order.push({ src: i });
    this.commitPageOrder(order, `Page ${index + 1} deleted.`, 'Deleting page…');
  }

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
      const ok = await this.confirmDialog(
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
        editedPdfBytes = await PDFBackendService.editPDF(this.originalFileData, this.edits);
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
          const im = await this.loadImage(e.dataUrl);
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
    const ok = await this.confirmDialog(
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

// Initialize the app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.pdfEditorApp = new PDFEditorApp();   // exposed so Merge can clear the open doc
  initMerge();   // wire up the client-side "Merge PDF" feature (self-contained)
});
