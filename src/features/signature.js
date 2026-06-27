// Signature tool — draw/type/upload pad, saved-signatures store + picker, ghost-cursor
// placement. Assembled onto PDFEditorApp.prototype (mixin); verbatim from app.js.
import { imageRatio } from '../util/image.js';
import { trimCanvas } from '../util/canvas.js';
import { SIGN_FONTS } from '../util/fontCatalog.js';

const SIG_STORE_KEY = 'qpe_signatures';
const SIG_STORE_MAX = 8;

export const SignatureMethods = {
  initSignatureDialog() {
    this.signTab = 'draw';
    this.signColor = '#111318';
    this.signPenWidth = 2.8;
    this.signTypeFont = SIGN_FONTS[0];
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
  },

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
  },

  setSignTab(tab) {
    this.signTab = tab;
    document.querySelectorAll('.sign-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.sign-panel').forEach(p => { p.hidden = (p.dataset.panel !== tab); });
  },

  /** Render the Type tab's font choices, previewing the entered name in each font/colour. */
  renderSignFontList() {
    const list = document.getElementById('signFontList');
    if (!list) return;
    const name = (document.getElementById('signTypeInput')?.value || '').trim();
    list.innerHTML = '';
    SIGN_FONTS.forEach((font) => {
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
  },

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
  },

  openSignPad() {
    if (!this.controller.isLoaded) { this.showStatus('Open a PDF first', 'error'); return; }
    this.signPadClear();
    this.setSignTab('draw');
    document.getElementById('signPad')?.classList.add('open');
  },

  closeSignPad() {
    document.getElementById('signPad')?.classList.remove('open');
  },

  /** Branded yes/no dialog. Resolves true (proceed) or false (cancel). */

  signPadClear() {
    const c = document.getElementById('signPadCanvas');
    if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height);
    this._padHasInk = false;
    const ti = document.getElementById('signTypeInput'); if (ti) ti.value = '';
    this.signImageData = null;
    const img = document.getElementById('signImagePreview'); if (img) { img.hidden = true; img.src = ''; }
    const prompt = document.getElementById('signImagePrompt'); if (prompt) prompt.hidden = false;
    this.renderSignFontList();
  },

  async signPadAdd() {
    // Signatures are placed from this dialog rather than a page click, so gate them here too.
    if (!(await this._confirmEditAllowed())) return;
    this.showStatus('Preparing signature…', 'info');   // immediate feedback while we rasterise
    let dataUrl = null, ratio = 0.3;

    if (this.signTab === 'draw') {
      const c = document.getElementById('signPadCanvas');
      const trimmed = c && this._padHasInk ? trimCanvas(c) : null;
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
      ratio = await imageRatio(dataUrl);
    }
    if (!dataUrl) return;

    // Remember it for next time (localStorage, on-device only) and enter ghost-placement mode —
    // a semi-transparent preview follows the cursor; the next click/tap on the page drops it there.
    this.saveSignatureToStore(dataUrl, ratio);
    this.closeSignPad();
    this.startSignaturePlacement(dataUrl, ratio);
  },

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
    const trimmed = trimCanvas(c) || { dataUrl: c.toDataURL('image/png'), w, h };
    return trimmed;
  },

  // ---------------------------------------------------------------------------------------------
  // Saved signatures: kept in the browser's own localStorage (nothing ever leaves the device, in
  // keeping with the "files are never stored" promise — this is the user's own signature, on their
  // own machine). Each entry is { dataUrl, ratio, ts }. Capped, most-recent-first.
  // ---------------------------------------------------------------------------------------------

  loadSavedSignatures() {
    try {
      const a = JSON.parse(localStorage.getItem(SIG_STORE_KEY) || '[]');
      return Array.isArray(a) ? a.filter(s => s && typeof s.dataUrl === 'string') : [];
    } catch (e) { return []; }
  },

  saveSignatureToStore(dataUrl, ratio) {
    if (!dataUrl) return;
    let list = this.loadSavedSignatures().filter(s => s.dataUrl !== dataUrl);
    list.unshift({ dataUrl, ratio: ratio || 0.3, ts: Date.now() });
    list = list.slice(0, SIG_STORE_MAX);
    // If storage is full (large image signatures), drop the oldest and retry until it fits.
    while (list.length) {
      try { localStorage.setItem(SIG_STORE_KEY, JSON.stringify(list)); break; }
      catch (e) { list.pop(); }
    }
  },

  deleteSavedSignature(dataUrl) {
    const list = this.loadSavedSignatures().filter(s => s.dataUrl !== dataUrl);
    try { localStorage.setItem(SIG_STORE_KEY, JSON.stringify(list)); } catch (e) {}
  },

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
  },

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
      // Rotated pages map clicks to the unrotated space, so a signature would save in the wrong place.
      if (((pv.page && pv.page.rotate) || 0) % 360 !== 0) {
        this.showStatus('Signatures can’t be placed on rotated pages. Un-rotate the page first.', 'info');
        this._cancelSignaturePlacement();
        return;
      }
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
  },

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
  },

  /** Place a previously-saved signature (chosen from the picker): start ghost-placement mode. */
  async placeSavedSignature(sig) {
    if (!sig || !sig.dataUrl) return;
    this.closeSignPicker();
    if (!(await this._confirmEditAllowed())) return;
    this.saveSignatureToStore(sig.dataUrl, sig.ratio);     // bump it to most-recent
    this.showStatus('Preparing signature…', 'info');
    this.startSignaturePlacement(sig.dataUrl, sig.ratio);
  },

  // ----- Signature picker: tap Sign -> a small list of saved signatures + "Add new signature" -----
  openSignFlow() {
    if (!this.controller.isLoaded) { this.showStatus('Open a PDF first', 'error'); return; }
    const saved = this.loadSavedSignatures();
    if (saved.length) this.openSignPicker(saved);
    else this.openSignPad();                              // nothing saved yet -> straight to the pad
  },

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
  },

  closeSignPicker() {
    const pop = document.getElementById('signPicker');
    if (pop) pop.hidden = true;
    this._signPickerOpen = false;
  },

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
  },
};
