// File I/O — open/parse a PDF, enable UI after load, close the document.
// Assembled onto PDFEditorApp.prototype (mixin); verbatim from app.js (this = the app).
import * as pdfjsLib from 'pdfjs-dist';
import { confirmDialog } from '../util/dialog.js';
import { MupdfService } from '../services/mupdfService.js';
import {
  editLimitBytes, editLimitMb, EDIT_LIMIT_PAGES, lazyRenderThreshold, deviceCapBytes, DEVICE_CAP_MESSAGE,
} from './limits.js';

// View-only controls stay enabled even for large (non-editable) files; edit controls are gated.
const VIEW_CONTROLS = ['prevPageBtn', 'nextPageBtn', 'pagesPanelBtn', 'splitBtn', 'watermarkBtn'];
const EDIT_CONTROLS = ['saveBtn', 'textInput', 'editModeBtn', 'textModeBtn',
  'signatureModeBtn', 'eraseModeBtn', 'stampModeBtn', 'annotateModeBtn', 'checkModeBtn', 'searchToolBtn', 'clearSignatureBtn'];

export const FileIOMethods = {
  /**
   * Enable the tools/controls that require a loaded PDF. When `large` is true the document is
   * over the edit limit (200 MB desktop / 30 MB mobile, or 1500 pages) and opens VIEW-ONLY: viewing, paging, Rotate/Reorder
   * and Merge stay available, but the editing tools (Edit/Add/Sign/Erase/Stamp/Highlight/Save)
   * are disabled.
   */
  enableUiAfterLoad(large = false) {
    VIEW_CONTROLS.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = false; });
    EDIT_CONTROLS.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = !!large; });
  },
  /** Clear the loaded PDF and return to the empty upload state. Used by the Merge panel
   *  when the user removes the current document (the one open here). */
  closeDocument() {
    this.pdfJsDoc = null;
    this.originalFile = null;
    this.originalFileData = null;
    this.largeFileMode = false;
    this.lazyEditMode = false;
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
    const pageNumInput = document.getElementById('pageNumInput');
    if (pageNumInput) { pageNumInput.value = ''; pageNumInput.disabled = true; }
    const modeIndicator = document.getElementById('modeIndicator');
    if (modeIndicator) modeIndicator.textContent = 'No PDF loaded';
    this.annotationManager.unmountAll();
    ['saveBtn', 'textInput', 'prevPageBtn', 'nextPageBtn', 'pagesPanelBtn',
     'editModeBtn', 'textModeBtn', 'signatureModeBtn', 'eraseModeBtn', 'stampModeBtn',
     'annotateModeBtn', 'clearSignatureBtn']
      .forEach((id) => { const el = document.getElementById(id); if (el) el.disabled = true; });
    document.querySelectorAll('.tool.active').forEach((el) => el.classList.remove('active'));
  },
  /**
   * Modal shown when a file is opened that's too large to EDIT (over the device byte limit / 1500 pages) but small
   * enough to view. Offers Rotate/Reorder or Merge (both client-side). Cancel/X leaves the file
   * open view-only. Handlers are assigned with onclick (idempotent across repeated opens).
   */
  _openLargeFileDialog() {
    const modal = document.getElementById('largeFileModal');
    if (!modal) return;
    // Name the LIMIT the file crossed (so the user learns the cap), not the file's own numbers.
    // The byte cap is device-aware (200 MB desktop / 30 MB mobile).
    const mb = editLimitMb();
    const overSize = this.originalFile && this.originalFile.size > editLimitBytes();
    const overPages = this.pdfJsDoc && this.pdfJsDoc.numPages > EDIT_LIMIT_PAGES;
    let reason;
    if (overSize && overPages) reason = `is greater than ${mb} MB and has more than ${EDIT_LIMIT_PAGES} pages`;
    else if (overSize) reason = `is greater than ${mb} MB`;
    else reason = `has more than ${EDIT_LIMIT_PAGES} pages`;
    const msgEl = document.getElementById('largeFileMsg');
    if (msgEl) msgEl.textContent =
      `This file ${reason}, which is too large to edit. You can still rotate, reorder, or merge it.`;
    const close = () => modal.classList.remove('open');
    // Cancel / X / backdrop => the user chose to VIEW: dismiss and render the view-only editor now.
    const cancel = () => { close(); this._ensureLargeViewRendered(); };
    const reorderBtn = document.getElementById('largeFileReorder');
    const mergeBtn = document.getElementById('largeFileMerge');
    const closeBtn = document.getElementById('largeFileClose');
    // Picking a tool just opens that tool — the editor is NOT rendered (the tool has what it needs).
    if (reorderBtn) reorderBtn.onclick = () => { close(); this.openPagesPanel(); };
    if (mergeBtn) mergeBtn.onclick = () => { close(); document.getElementById('mergeBtn')?.click(); };
    if (closeBtn) closeBtn.onclick = cancel;
    modal.onclick = (e) => { if (e.target === modal) cancel(); };
    modal.classList.add('open');
  },
  /** Render the large file's view-only pages on demand (once). Called on Cancel or when leaving a tool. */
  async _ensureLargeViewRendered() {
    if (!this.largeFileMode || this._largeViewRendered || !this.pdfJsDoc) return;
    this._largeViewRendered = true;
    await this.buildPages();
    document.getElementById('stage')?.scrollTo({ top: 0 });
  },
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

    // Only the absolute DEVICE cap blocks loading outright — a file we can't safely hold in this
    // browser. Files merely over the EDIT limit (30 MB / 500 pages) still open, view-only (handled
    // after we know the page count); they can be viewed, merged and rotated/reordered, just not edited.
    if (file.size > deviceCapBytes()) {
      this.showStatus(DEVICE_CAP_MESSAGE, 'error');
      document.body.classList.remove('has-pdf');  // keep the upload screen showing
      event.target.value = '';                     // allow re-selecting after picking a smaller file
      return;
    }
    // Within the device cap — reveal the editor (it may still be view-only, decided below).
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

      // If the user supplied a real password, unlock a copy IN THE BROWSER (mupdf-wasm) so the
      // edit/save pipeline works on plain bytes (the saved copy is unlocked, by design). If WASM
      // can't unlock it, we keep the viewable PDF.js doc and the save chain flattens.
      let workingData = arrayBuffer.slice(0);
      if (enteredPassword) {
        this.showStatus('Unlocking PDF…', 'info');
        // WASM-only: unlock in the browser (mupdf-wasm, no server). If WASM is unsupported or
        // fails, we keep the locked doc and let save flatten.
        let res = null;
        if (MupdfService.isSupported()) {
          try {
            res = await MupdfService.decryptPDF(arrayBuffer.slice(0), enteredPassword);
          } catch (e) {
            console.warn('WASM decrypt unavailable; protected PDF will save as a flattened copy:', e);
          }
        }
        if (res && res.bytes) {
          const dec = res.bytes;
          workingData = dec.buffer.slice(dec.byteOffset, dec.byteOffset + dec.byteLength);
          this.pdfJsDoc = await pdfjsLib.getDocument({ data: dec.slice(0) }).promise;
        } else {
          console.warn('Could not unlock the PDF; it will save as a flattened copy.');
        }
      }
      this.originalFileData = workingData; // Clone the (possibly decrypted) ArrayBuffer

      // Owner/editing-restriction gate: ask the user to confirm they're authorised before their FIRST
      // edit (see _confirmEditAllowed / the stage mousedown gate). Reset the confirmation per document.
      this._editRestricted = editRestricted;
      this._restrictionConfirmed = false;

      // Decide editable vs view-only by the OUTPUT we just loaded: over the device-aware byte
      // limit (200 MB desktop / 30 MB mobile) OR > 500 pages (whichever hits first) means editing
      // is unsupported, but the file still opens for viewing/merge/reorder.
      const pageCount = this.pdfJsDoc.numPages;
      this.largeFileMode = (file.size > editLimitBytes()) || (pageCount > EDIT_LIMIT_PAGES);
      // Editable but past the (device-aware) render threshold: render lazily (paint near the
      // viewport, evict far pages) — eagerly painting hundreds of full-res canvases is 1-2 GB and
      // crashes iPad Safari. Desktop threshold 500; touch devices virtualize at 50 (a 466-page book
      // on iPad was crashing precisely because 466 < 500 kept it on the eager path).
      this.lazyEditMode = !this.largeFileMode && pageCount > lazyRenderThreshold();

      if (this.largeFileMode) {
        // Large file: do NOT render the editor first. Show the choice dialog immediately; only render
        // the (possibly huge) view-only page bitmaps if the user actually chooses to view (Cancel) or
        // returns from a tool. Picking Rotate/Reorder or Merge goes straight to that tool — no render.
        this.controller.isLoaded = true;
        this.currentPage = 0;
        this._largeViewRendered = false;
        const container = document.getElementById('canvasContainer');
        if (container) container.innerHTML = '';      // blank editor behind the modal (no stale doc)
        this.pageViews = [];
        this.setMode('view');
        this.enableUiAfterLoad(true);
        this.updateModeIndicator();
        this.showStatus('', '');   // clear the "Loading PDF…" toast (no controller 'loaded' fires here)
        if (this._suppressLargeDialog) {
          // Came from Merge: don't show the choose-a-tool dialog AND don't pop an editor toast
          // (the Merge box already shows the "editing disabled" banner). Just open it view-only.
          this._suppressLargeDialog = false;
          this._largeViewRendered = true;
          await this.buildPages();
          document.getElementById('stage')?.scrollTo({ top: 0 });
        } else {
          this._openLargeFileDialog();
        }
        return;
      }

      // ----- Normal editable flow -----
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
      // LAZY-editable docs (501+ pages) hydrate text per page as it scrolls into view instead
      // (getTextContent × 1000+ up front costs a minute+ and holds every page's items at once);
      // see _ensurePageExtracted, called by the windowed painter before building a page's boxes.
      if (this.lazyEditMode) {
        this.extractedTextItems = [];
        this.extractedLinks = [];
        this._extractedPages = new Set();
      } else {
        await this.extractTextFromPDFjs();
      }

      this.currentPage = 0;
      // Smart default: don't force a tool choice. Set it BEFORE buildPages so the pages render
      // the editable line boxes straight away (the page is immediately interactive — clicking
      // existing text edits it, clicking a blank area adds new text; see setMode/handleCanvasClick).
      // Setting it up front also means a fast tool click during load can't be clobbered by a late
      // mode switch.
      this.setMode('auto');
      await this.buildPages();
      document.getElementById('stage')?.scrollTo({ top: 0 });

      // Pre-warm the mupdf-wasm worker NOW (while the doc just loaded — almost certainly still online) so
      // the ~MB WASM binary is fetched + initialised before the user edits. Otherwise mupdf loads lazily on
      // the FIRST save, and if the user has gone offline by then the WASM fetch fails, the tier declines,
      // and the save falls to the degraded pdf-lib path (lost colour / partial styling). Fire-and-forget.
      try { if (MupdfService.isSupported()) MupdfService.ready().catch(() => {}); } catch (_) {}

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
  },
};
