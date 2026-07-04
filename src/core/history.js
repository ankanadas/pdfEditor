// Undo/redo history for text edits (snapshot/commit/reset + the toolbar buttons). In Highlight
// (annotate) mode the shared Undo/Redo drive the annotation layer's own history instead.
// Assembled onto PDFEditorApp.prototype (mixin); methods are verbatim (this = the app instance).

export const HistoryMethods = {
  snapshotEdits() { return this.edits.map(e => ({ ...e })); },

  // ---- Batching: a BULK operation (e.g. Replace All over N lines) is ONE undo step. Without
  // this, every per-line blur/style commit pushed its own snapshot — undoing a 16-page Replace
  // All took 16 clicks. begin/end nest; the single commit lands when the outermost batch ends.
  beginHistoryBatch() {
    this._histBatch = (this._histBatch || 0) + 1;
  },
  endHistoryBatch() {
    this._histBatch = Math.max(0, (this._histBatch || 0) - 1);
    if (!this._histBatch && this._histBatchDirty) {
      this._histBatchDirty = false;
      this.commitHistory();
    }
  },

  commitHistory() {
    if (this._histBatch) { this._histBatchDirty = true; return; }   // inside a batch: defer to endHistoryBatch
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
    const prev = this.edits;
    this.historyIndex--;
    this.edits = this.history[this.historyIndex].map(e => ({ ...e }));
    this.updateHistoryButtons();
    this._refreshEditDiff(prev, this.edits);
    this.showStatus('Undo', 'info');
  },

  redo() {
    if (this.mode === 'annotate') { this.annotationManager.redo(); this.updateHistoryButtons(); this.showStatus('Redo', 'info'); return; }
    if (this.historyIndex >= this.history.length - 1) return;
    const prev = this.edits;
    this.historyIndex++;
    this.edits = this.history[this.historyIndex].map(e => ({ ...e }));
    this.updateHistoryButtons();
    this._refreshEditDiff(prev, this.edits);
    this.showStatus('Redo', 'info');
  },

  /** Pages whose edit set differs between two snapshots (−1 = an edit without a page index). */
  _editPagesDiff(prev, next) {
    const group = (arr) => {
      const m = new Map();
      for (const e of arr || []) {
        const p = Number.isInteger(e.pageIndex) ? e.pageIndex : -1;
        m.set(p, (m.get(p) || '') + JSON.stringify(e));
      }
      return m;
    };
    const a = group(prev), b = group(next);
    const pages = new Set();
    for (const p of new Set([...a.keys(), ...b.keys()])) if (a.get(p) !== b.get(p)) pages.add(p);
    return pages;
  },

  /** Re-render ONLY the pages an undo/redo actually changed. A full refresh loops every page
   *  (canvas re-render + overlay rebuild each) — that made rapid undo on long documents lag the
   *  visible state by seconds. Falls back to the full pass when an edit carries no page index. */
  _refreshEditDiff(prev, next) {
    const pages = this._editPagesDiff(prev, next);
    if (!pages.size) return;                                   // nothing visible changed
    if (pages.has(-1)) { this.renderCurrentPage(); return; }   // unknown page -> full refresh
    this.refresh({ only: pages });
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
