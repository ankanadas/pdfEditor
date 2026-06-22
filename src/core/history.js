// Undo/redo history for text edits (snapshot/commit/reset + the toolbar buttons). In Highlight
// (annotate) mode the shared Undo/Redo drive the annotation layer's own history instead.
// Assembled onto PDFEditorApp.prototype (mixin); methods are verbatim (this = the app instance).

export const HistoryMethods = {
  snapshotEdits() { return this.edits.map(e => ({ ...e })); },

  commitHistory() {
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(this.snapshotEdits());
    this.historyIndex = this.history.length - 1;
    this.updateHistoryButtons();
  },

  resetHistory() {
    this.history = [this.snapshotEdits()];
    this.historyIndex = 0;
    this.updateHistoryButtons();
  },

  undo() {
    // In Highlight (annotate) mode the shared Undo button drives the annotation layer's own history.
    if (this.mode === 'annotate') { this.annotationManager.undo(); this.updateHistoryButtons(); this.showStatus('Undo', 'info'); return; }
    if (this.historyIndex <= 0) return;
    this.historyIndex--;
    this.edits = this.history[this.historyIndex].map(e => ({ ...e }));
    this.updateHistoryButtons();
    this.renderCurrentPage();
    this.showStatus('Undo', 'info');
  },

  redo() {
    if (this.mode === 'annotate') { this.annotationManager.redo(); this.updateHistoryButtons(); this.showStatus('Redo', 'info'); return; }
    if (this.historyIndex >= this.history.length - 1) return;
    this.historyIndex++;
    this.edits = this.history[this.historyIndex].map(e => ({ ...e }));
    this.updateHistoryButtons();
    this.renderCurrentPage();
    this.showStatus('Redo', 'info');
  },

  updateHistoryButtons() {
    const u = document.getElementById('undoBtn');
    const r = document.getElementById('redoBtn');
    // In Highlight mode the buttons reflect the annotation layer's history; otherwise the edit history.
    if (this.mode === 'annotate') {
      const am = this.annotationManager;
      if (u) u.disabled = !am.canUndo();
      if (r) r.disabled = !am.canRedo();
      return;
    }
    if (u) u.disabled = this.historyIndex <= 0;
    if (r) r.disabled = this.historyIndex >= this.history.length - 1;
  },
};
