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

  closePagesPanel() {
    document.getElementById('pagesBackdrop')?.classList.remove('open');
    document.getElementById('pagesDrawer')?.classList.remove('open');
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

      const rotL = document.createElement('button');
      rotL.className = 'page-thumb-rot left';
      rotL.title = 'Rotate left';
      rotL.setAttribute('aria-label', `Rotate page ${i + 1} left`);
      rotL.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 5 5v0a5 5 0 0 1-5 5H9"/></svg>';
      rotL.addEventListener('click', (e) => { e.stopPropagation(); this.rotatePage(i, -1); });
      thumb.appendChild(rotL);

      const rotR = document.createElement('button');
      rotR.className = 'page-thumb-rot right';
      rotR.title = 'Rotate right';
      rotR.setAttribute('aria-label', `Rotate page ${i + 1} right`);
      rotR.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0-5 5v0a5 5 0 0 0 5 5h6"/></svg>';
      rotR.addEventListener('click', (e) => { e.stopPropagation(); this.rotatePage(i, 1); });
      thumb.appendChild(rotR);

      const num = document.createElement('div');
      num.className = 'thumb-num';
      num.textContent = `Page ${i + 1}`;
      thumb.appendChild(num);

      thumb.addEventListener('click', () => this.selectThumb(i));
      this.platform.bindPageReorder(thumb);   // desktop: HTML5 DnD; mobile: MOBILE-TODO
      grid.appendChild(thumb);

      this.renderThumbCanvas(canvas, i);   // async paint; doesn't block the drawer opening
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
  },

  /**
   * Rotate one page in place. dir = +1 (right / +90°) or -1 (left / −90°). Lossless: applyPageOrder
   * bakes it as PDF /Rotate combined with the page's existing rotation. Committed immediately through
   * the same path reorder/delete use (so it persists across later reorder/delete/insert and reaches
   * the saved/downloaded output); a CSS transform on the thumbnail gives instant feedback meanwhile.
   */
  rotatePage(index, dir) {
    const n = this.pdfJsDoc.numPages;
    const delta = dir > 0 ? 90 : 270;        // right = +90; left = −90 ≡ +270
    // Instant visual cue on this thumbnail (the commit re-render replaces it with the baked rotation).
    const cv = document.querySelector(`#pagesGrid .page-thumb[data-index="${index}"] .thumb-canvas`);
    if (cv) {
      const cur = /rotate\((-?\d+)deg\)/.exec(cv.style.transform);
      cv.style.transform = `rotate(${((cur ? +cur[1] : 0) + delta) % 360}deg)`;
    }
    const order = [];
    for (let i = 0; i < n; i++) order.push(i === index ? { src: i, rot: delta } : { src: i });
    this.commitPageOrder(order, `Page ${index + 1} rotated ${dir > 0 ? 'right' : 'left'}.`, 'Rotating page…');
  },

  /** Remove a page (never the last remaining one). */
  deletePage(index) {
    const n = this.pdfJsDoc.numPages;
    if (n <= 1) { this.showStatus('A PDF must keep at least one page.', 'error'); return; }
    if (this.selectedThumb === index) this.selectedThumb = null;
    const order = [];
    for (let i = 0; i < n; i++) if (i !== index) order.push({ src: i });
    this.commitPageOrder(order, `Page ${index + 1} deleted.`, 'Deleting page…');
  },
};
