// Erase tool — drag a rectangle to white-out a region; queued as a redact=erase edit.
// Assembled onto PDFEditorApp.prototype (mixin); verbatim from app.js (this = the app).

export const EraseMethods = {
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
  },

  onEraseMove(event) {
    if (!this.eraseDrag) return;
    const r = this.eraseDrag.rect;
    const x0 = this.eraseDrag.startX - r.left, y0 = this.eraseDrag.startY - r.top;
    const x1 = event.clientX - r.left, y1 = event.clientY - r.top;
    this.eraseSel.style.left = Math.min(x0, x1) + 'px';
    this.eraseSel.style.top = Math.min(y0, y1) + 'px';
    this.eraseSel.style.width = Math.abs(x1 - x0) + 'px';
    this.eraseSel.style.height = Math.abs(y1 - y0) + 'px';
  },

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
  },
};
