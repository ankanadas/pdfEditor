// Pages panel — open/close the Rotate/Reorder drawer, render thumbnails, drag-to-reorder, rotate,
// insert-pos options, move/delete pages. Assembled onto PDFEditorApp.prototype (mixin).
import { LARGE_FILE_WARNING } from '../core/limits.js';

export const PagesPanelMethods = {
  togglePagesPanel() {
    const open = document.getElementById('pagesDrawer')?.classList.contains('open');
    if (open) this.closePagesPanel(); else this.openPagesPanel();
  },

  openPagesPanel() {
    if (!this.controller.isLoaded || !this.pdfJsDoc) {
      this.showStatus('Open a PDF first', 'error');
      return;
    }
    this.selectedThumb = null;
    document.getElementById('pagesBackdrop')?.classList.add('open');
    document.getElementById('pagesDrawer')?.classList.add('open');
    this.renderPagesPanel();
  },

  async closePagesPanel() {
    document.getElementById('pagesBackdrop')?.classList.remove('open');
    document.getElementById('pagesDrawer')?.classList.remove('open');
    // Editable docs bake any pending rotation into the editor on close (one rebuild). Large/view-only
    // docs keep it pending — it's baked into the file by the Download button instead.
    if (!this.largeFileMode && this._hasPendingRot()) await this._flushPendingRot();
  },

  /** Build the thumbnail grid + the "insert position" dropdown from the current document. */
  renderPagesPanel() {
    const grid = document.getElementById('pagesGrid');
    if (!grid || !this.pdfJsDoc) return;
    const n = this.pdfJsDoc.numPages;

    const count = document.getElementById('pagesCount');
    if (count) count.textContent = `${n} page${n === 1 ? '' : 's'}`;
    this.rebuildInsertPosOptions(n);
    this._reflectPagesLargeUI();

    grid.innerHTML = '';
    const hint = document.createElement('div');
    hint.className = 'pages-hint';
    hint.textContent = 'Drag to reorder · use the purple bar to rotate · hover a page to delete';
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

      // Always-visible rotate bar with labelled Left / Right controls (not hover-only).
      const bar = document.createElement('div');
      bar.className = 'thumb-rotbar';
      const ROT_L = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 5 5v3"/></svg>';
      const ROT_R = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0-5 5v3"/></svg>';
      const mkRot = (dir, label, icon) => {
        const btn = document.createElement('button');
        btn.className = 'thumb-rot';
        btn.type = 'button';
        btn.setAttribute('aria-label', `Rotate page ${i + 1} ${dir > 0 ? 'right' : 'left'}`);
        btn.innerHTML = `${icon}<span>${label}</span>`;
        btn.addEventListener('click', (e) => { e.stopPropagation(); this.rotatePage(i, dir); });
        return btn;
      };
      bar.appendChild(mkRot(-1, 'Left', ROT_L));
      bar.appendChild(mkRot(1, 'Right', ROT_R));
      thumb.appendChild(bar);

      thumb.addEventListener('click', () => this.selectThumb(i));
      this.platform.bindPageReorder(thumb);   // desktop: HTML5 DnD; mobile: MOBILE-TODO
      grid.appendChild(thumb);

      this.renderThumbCanvas(canvas, i);   // async paint; doesn't block the drawer opening
      this._applyThumbRotCss(canvas, (this._pendingRot && this._pendingRot[i]) || 0);  // restore any pending preview
    }
  },

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
  },

  /**
   * In large/view-only mode the page tool can't route results back into the editor, so it shows a
   * warning banner + a Download button (the only way to save the rotated/reordered result). In normal
   * mode both are hidden. Wired idempotently via onclick.
   */
  _reflectPagesLargeUI() {
    const large = !!this.largeFileMode;
    const warn = document.getElementById('pagesLargeWarn');
    const dl = document.getElementById('pagesDownload');
    if (warn) {
      warn.textContent = large ? LARGE_FILE_WARNING : '';
      warn.hidden = !large;
    }
    if (dl) {
      dl.hidden = !large;
      dl.onclick = () => this.downloadCurrentPdf();
    }
  },

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
  },

  /** Click a thumbnail to select it (sets "insert after this page"); click again to clear. */
  selectThumb(i) {
    this.selectedThumb = (this.selectedThumb === i) ? null : i;
    document.querySelectorAll('#pagesGrid .page-thumb').forEach((el) => {
      el.classList.toggle('selected', Number(el.dataset.index) === this.selectedThumb);
    });
    const sel = document.getElementById('insertPos');
    if (sel) sel.value = (this.selectedThumb == null) ? 'end' : String(this.selectedThumb);
  },

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
  },

  clearDropMarkers() {
    document.querySelectorAll('#pagesGrid .page-thumb.drop-before, #pagesGrid .page-thumb.drop-after')
      .forEach(el => el.classList.remove('drop-before', 'drop-after'));
  },

  /** Move page `from` so it lands immediately before original index `insertBefore`. Folds in rotation. */
  movePage(from, insertBefore) {
    if (insertBefore === from || insertBefore === from + 1) return;   // dropped back in place
    const n = this.pdfJsDoc.numPages;
    const pend = this._pendingRot || {};
    const push = (src) => order.push({ src, rot: pend[src] || 0 });
    const order = [];
    for (let i = 0; i < n; i++) {
      if (i === insertBefore) push(from);
      if (i !== from) push(i);
    }
    if (insertBefore >= n) push(from);   // moved to the very end
    this._pendingRot = {};
    this.commitPageOrder(order, 'Pages reordered.', 'Reordering pages…');
  },

  /**
   * Rotate one page. dir = +1 (right / +90°) or -1 (left / −90°). For SPEED this does NOT rebuild the
   * PDF per click — it accumulates a pending rotation per page and previews it instantly with a CSS
   * transform on the thumbnail. The rotation is baked LOSSLESSLY as PDF /Rotate only once, later, when
   * it actually has to be (a reorder/delete folds it in; Download bakes it; Save bakes it; closing the
   * panel on an editable doc bakes it). So clicking rotate is instant no matter how big the file is.
   */
  rotatePage(index, dir) {
    this._pendingRot = this._pendingRot || {};
    const next = (((this._pendingRot[index] || 0) + (dir > 0 ? 90 : 270)) % 360 + 360) % 360;
    this._pendingRot[index] = next;
    const cv = document.querySelector(`#pagesGrid .page-thumb[data-index="${index}"] .thumb-canvas`);
    this._applyThumbRotCss(cv, next);
    this._reflectPendingRot();
  },

  /** Preview a page's pending rotation on its thumbnail canvas (scaled to stay inside the tile). */
  _applyThumbRotCss(canvas, deg) {
    if (!canvas) return;
    const quarter = deg === 90 || deg === 270;     // portrait<->landscape: shrink to fit the tile
    canvas.style.transform = deg ? `rotate(${deg}deg)${quarter ? ' scale(.72)' : ''}` : '';
  },

  _hasPendingRot() { return !!(this._pendingRot && Object.keys(this._pendingRot).length); },

  /** Build an order over the current pages carrying each page's pending rotation, then clear it. */
  _pendingRotOrder() {
    const n = this.pdfJsDoc.numPages;
    const order = [];
    for (let i = 0; i < n; i++) order.push({ src: i, rot: (this._pendingRot && this._pendingRot[i]) || 0 });
    this._pendingRot = {};
    return order;
  },

  /** Bake any pending rotations into the document (one rebuild). Used on panel close / before save. */
  async _flushPendingRot() {
    if (!this._hasPendingRot()) return;
    await this.commitPageOrder(this._pendingRotOrder(), 'Rotation applied.', 'Applying rotation…');
  },

  /** Show that rotations are pending (Download bakes them for large files; close/Save for editable). */
  _reflectPendingRot() {
    const dl = document.getElementById('pagesDownload');
    if (dl && this.largeFileMode) dl.hidden = false;
    const hint = document.getElementById('pagesLargeWarn');
    if (hint && !this.largeFileMode && this._hasPendingRot()) {
      hint.textContent = 'Rotation is previewed here — it’s applied when you close this panel or Save.';
      hint.hidden = false;
    }
  },

  /** Remove a page (never the last remaining one). Folds in any pending rotation. */
  deletePage(index) {
    const n = this.pdfJsDoc.numPages;
    if (n <= 1) { this.showStatus('A PDF must keep at least one page.', 'error'); return; }
    if (this.selectedThumb === index) this.selectedThumb = null;
    const pend = this._pendingRot || {};
    const order = [];
    for (let i = 0; i < n; i++) if (i !== index) order.push({ src: i, rot: pend[i] || 0 });
    this._pendingRot = {};
    this.commitPageOrder(order, `Page ${index + 1} deleted.`, 'Deleting page…');
  },
};
