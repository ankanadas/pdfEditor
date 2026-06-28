// Mode / tool state — switch tool mode, reflect the active tool, the mode indicator, and route a page click to the active tool.
// Assembled onto PDFEditorApp.prototype (mixin); verbatim from app.js (this = the app).

export const ModeManagerMethods = {
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
  },
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
  },
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
    } else if (this.mode === 'view') {
      indicator.textContent = 'View only (large file)';
      indicator.classList.remove('active');
    } else {
      indicator.textContent = 'Pick a tool';
      indicator.classList.remove('active');
    }
  },
  handleCanvasClick(event, pv) {
    if (!this.controller.isLoaded) {
      this.showStatus('Open a PDF first.', 'error');
      return;
    }
    if (!this.mode) {
      this.showStatus('Pick a tool on the left first — Edit, Add, or Sign — then click the page.', 'error');
      return;
    }
    // Editing is disabled on ROTATED pages: a click maps to the unrotated coordinate space, so an
    // added edit would save in the wrong place. Block it cleanly (the page still views fine).
    if (((pv.page && pv.page.rotate) || 0) % 360 !== 0) {
      this.showStatus('Editing is disabled on rotated pages. Un-rotate the page to edit it.', 'info');
      return;
    }
    // Map the click to that page's intrinsic canvas pixels (handles CSS scaling), then
    // to PDF points (top-left origin) — the coordinate space used when saving.
    const rect = pv.canvas.getBoundingClientRect();
    const toIntrinsic = pv.canvas.width / rect.width;
    const xPt = ((event.clientX - rect.left) * toIntrinsic) / this.scale;
    const clickYPt = ((event.clientY - rect.top) * toIntrinsic) / this.scale;

    // Dynamic clicking model: in EVERY editing mode (Add, smart/auto, AND Edit) existing text is
    // covered by editable line boxes, so a click that lands on the bare canvas is genuinely blank
    // space → add new text there. Picking the Edit tool no longer "locks out" adding; picking Add no
    // longer locks out editing (clicking a line still edits it via its box). 'view' stays read-only.
    if (this.mode === 'text' || this.mode === 'auto' || this.mode === 'edit') {
      // The click that closes an open Add-text editor must NOT also open a fresh one — it only
      // commits. The next deliberate click then adds/edits based on where it lands. Compare the EVENT
      // timestamps (same physical click = mousedown→click a few ms apart, regardless of how long the
      // commit's re-render took); a later deliberate click has a far larger timeStamp → not suppressed.
      if (event && event.timeStamp - (this._lastInsertCommitAt || -1e9) < 350) { this._lastInsertCommitAt = -1e9; return; }
      // This click is exiting an existing-text edit (flagged on its mousedown while the box was focused) —
      // commit only, don't chain-open a fresh Add-text box. A later deliberate click still adds text.
      if (this._exitEditClick) { this._exitEditClick = false; return; }
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
  },
};
