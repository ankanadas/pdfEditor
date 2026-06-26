// Annotate (Highlight) toolbar — init the sub-toolbar + activate an annotation tool.
// Assembled onto PDFEditorApp.prototype (mixin); verbatim from app.js (this = the app).

export const AnnotateToolbarMethods = {
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
    // Show the colour the DEFAULT tool will actually apply: highlight tools FILL with highlightColor
    // (yellow), shapes STROKE with strokeColor (red). Otherwise the swatch shows the shape colour while
    // a highlight comes out a different colour ("wrong colour first time").
    const t0 = this._lastAnnotateTool || 'highlight';
    this._setColorSwatch((t0 === 'highlight' || t0 === 'freeHighlight') ? am.highlightColor : am.strokeColor, 'ann-color-sw');
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
  },
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
    // Reflect the colour THIS tool actually applies (highlight fill vs shape stroke).
    const isHl = (tool === 'highlight' || tool === 'freeHighlight');
    this._setColorSwatch(isHl ? am.highlightColor : am.strokeColor, 'ann-color-sw');
    // Activate the tool with the persisted settings.
    am.setTool(tool, {
      strokeColor: am.strokeColor,
      strokeWidth: am.strokeWidth,
      highlightColor: am.highlightColor,
      highlightOpacity: am.highlightOpacity,
    });
  },
};
