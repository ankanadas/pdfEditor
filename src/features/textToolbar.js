// Floating text toolbar — show/hide/position, colour + link popovers, and applying style/colour/link/align to a box or per-line runs.
// Assembled onto PDFEditorApp.prototype (mixin); verbatim from app.js (this = the app).
import { hexToRgb, rgbCss, rgbToHex } from '../util/color.js';
import { LINK_BLUE } from '../util/fontCatalog.js';

export const TextToolbarMethods = {
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
    // +/- steppers (mobile has no native number spinner). Clamp to the same 4–200 range as the input.
    const stepSize = (delta) => { const el = document.getElementById('tt-size'); if (!el) return; const v = Math.max(4, Math.min(200, (parseInt(el.value, 10) || 14) + delta)); el.value = String(v); this.applyTextStyle('size', v); };
    on('tt-size-dec', 'mousedown', (e) => e.preventDefault());
    on('tt-size-inc', 'mousedown', (e) => e.preventDefault());
    on('tt-size-dec', 'click', () => stepSize(-1));
    on('tt-size-inc', 'click', () => stepSize(1));
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
    document.addEventListener('selectionchange', () => {
      if (!this._ttTarget) return;
      // Mobile: do NOT chase the caret/selection — it fires constantly while picking a font or typing and
      // makes the toolbar jump up/down. The visualViewport listeners keep it placed when the keyboard moves.
      if (window.matchMedia && window.matchMedia('(max-width: 767px)').matches) return;
      this._positionTextToolbar();
    });
    // Mobile: lock the page scale the instant a finger lands on ANY editable box (existing-text line or
    // add-text editor), BEFORE the browser focuses it — Safari decides whether to auto-zoom at focus time,
    // so locking on pointerdown (capture, ahead of focus) is the only reliable moment.
    document.addEventListener('pointerdown', (e) => {
      if (e.target && e.target.closest && e.target.closest('.editable-text-box, .insert-editor')) this._setViewportZoom(true);
    }, true);
    // Mobile: the soft keyboard resizes/shifts the VISUAL viewport without firing window 'resize' or
    // 'scroll'. Track it so the floating toolbar follows the visible area (and stays above the keyboard).
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => { if (this._ttTarget) this._positionTextToolbar(); });
      window.visualViewport.addEventListener('scroll', () => { if (this._ttTarget) this._positionTextToolbar(); });
    }
    // Dismiss the toolbar when the user finishes editing. A click/tap OUTSIDE both the toolbar (and its
    // pop-overs) and the active text deselects (an open Add-text editor commits via its own handler).
    const isOutside = (target) => {
      const t = this._ttTarget; if (!t) return false;
      if (target.closest && (target.closest('#textToolbar') || target.closest('.tt-font-pop,.tt-color-pop,.tt-link-pop'))) return false;
      const el = t.kind === 'overlay' ? this._overlayElFor(t.edit) : t.el;
      if (el && (target === el || el.contains(target))) return false;
      return true;
    };
    const dismiss = () => { const t = this._ttTarget; if (!t) return; if (t.kind === 'overlay') this.selectInsert(null); else this.hideTextToolbar(); };
    document.addEventListener('mousedown', (e) => {
      const t = this._ttTarget;
      if (!t || t.kind === 'editor') return;
      if (window.matchMedia && window.matchMedia('(max-width: 767px)').matches) return;   // mobile handled by the touch logic below
      if (isOutside(e.target)) dismiss();
    }, true);
    // Mobile: dismiss on a deliberate TAP outside, but NOT on a scroll/drag — the pinned toolbar must stay
    // while you scroll yet exit the edit when you tap blank space. Tracking the touch tells tap from scroll.
    let _ts = null;
    document.addEventListener('touchstart', (e) => { const p = e.touches[0]; _ts = p ? { x: p.clientX, y: p.clientY, moved: false } : null; }, true);
    document.addEventListener('touchmove', (e) => { const p = e.touches[0]; if (_ts && p && Math.abs(p.clientX - _ts.x) + Math.abs(p.clientY - _ts.y) > 12) _ts.moved = true; }, true);
    document.addEventListener('touchend', (e) => {
      const t = this._ttTarget, ts = _ts; _ts = null;
      if (!t || t.kind === 'editor' || !ts || ts.moved) return;       // no edit / add-editor (own handler) / a scroll → keep
      if (isOutside(e.target)) dismiss();
    }, true);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this._ttTarget && this._ttTarget.kind !== 'editor') this.hideTextToolbar(); });
  },
  _overlayElFor(edit) { return this.insertOverlays.find(o => o.__edit === edit) || null; },
  /** Build the Sejda-style swatch palette popover and wire it to applyTextStyle('color', …). */
  _initColorPalette() {
    this._buildColorPopover('tt-color-btn', 'tt-color-pop', (hex) => {
      this.applyTextStyle('color', hexToRgb(hex));
      this._setColorSwatch(hex, 'tt-color-sw');
    });
  },
  /**
   * Build the shared Sejda-style swatch palette popover on (btnId, popId): a grid of preset swatches
   * plus a native "Custom" picker. `onPick(hex)` fires on any selection. Reused by BOTH the text
   * floating toolbar and the annotation toolbar so they share one identical colour control.
   */
  _buildColorPopover(btnId, popId, onPick) {
    const btn = document.getElementById(btnId);
    const pop = document.getElementById(popId);
    if (!btn || !pop || pop._built) return;
    pop._built = true;
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
      sw.addEventListener('mousedown', (e) => e.preventDefault());   // keep the editor/canvas focused
      sw.addEventListener('click', () => { onPick(hex); pop.hidden = true; });
      pop.appendChild(sw);
    });
    // A "custom" native picker for anything outside the palette. The input keeps a per-popover id
    // (tt-color-custom for the text toolbar, ann-color-custom for annotations) so it stays scriptable.
    const customId = popId.replace('-pop', '-custom');
    const custom = document.createElement('label');
    custom.className = 'tt-sw tt-sw-custom'; custom.title = 'Custom colour';
    custom.innerHTML = `Custom <input type="color" id="${customId}" value="#000000" title="Custom colour" aria-label="Custom colour">`;
    custom.addEventListener('mousedown', (e) => { if (e.target.tagName !== 'INPUT') e.preventDefault(); });
    pop.appendChild(custom);
    custom.querySelector('input').addEventListener('input', (e) => onPick(e.target.value));

    btn.addEventListener('mousedown', (e) => e.preventDefault());
    const wrap = btn.closest('.tt-color-wrap');
    btn.addEventListener('click', () => {
      if (pop.hidden) {
        if (window.matchMedia && window.matchMedia('(max-width: 767px)').matches) {
          const ae = document.activeElement; if (ae && ae.blur) ae.blur();   // close keyboard → full grid visible
          // iOS clamps a position:fixed element to a `-webkit-overflow-scrolling` ancestor (the highlight
          // action bar), cramming the grid into one row. Re-parent to <body> so it anchors to the viewport.
          if (pop.parentElement !== document.body) document.body.appendChild(pop);
        }
        pop.hidden = false;
      } else pop.hidden = true;
    });
    // Close on a click/tap outside the colour control's wrap AND the popover itself (it may now live in body).
    document.addEventListener('mousedown', (e) => {
      if (!pop.hidden && !pop.contains(e.target) && (!wrap || !wrap.contains(e.target))) pop.hidden = true;
    }, true);
  },
  _setColorSwatch(hex, id = 'tt-color-sw') { const sw = document.getElementById(id); if (sw) sw.style.background = hex; },
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
      // Mobile: re-parent to <body> so iOS doesn't clamp this fixed sheet to the toolbar's overflow-scroll
      // container (which hid it). The URL input still gets focus so the user can type.
      if (window.matchMedia && window.matchMedia('(max-width: 767px)').matches && pop.parentElement !== document.body) document.body.appendChild(pop);
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
    document.addEventListener('mousedown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('.tt-link-wrap')) close(); }, true);
  },
  /** Add a scheme to a bare URL/email so it forms a valid clickable link ('example.com' -> https://…,
   *  'a@b.com' -> mailto:…). Empty stays empty (= remove). */
  _normalizeUrl(v) {
    const s = (v || '').trim();
    if (!s) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;     // already has a scheme (http:, mailto:, tel:, …)
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'mailto:' + s;
    return 'https://' + s;
  },
  /** Show the toolbar for a target { kind:'editor'|'overlay'|'line', el, edit?, line? }. */
  /** Mobile only: lock the page scale to 1 while a text editor is open so Safari can't auto-zoom on
   *  focusing a small-font editable box (which used to fling the page + toolbar around). Pinch-zoom of
   *  the PDF is restored the moment editing ends, so reading the document by pinching still works. */
  _setViewportZoom(locked) {
    if (!window.matchMedia || !window.matchMedia('(max-width: 767px)').matches) return;
    const m = document.querySelector('meta[name=viewport]');
    if (!m) return;
    const want = locked
      ? 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no'
      : 'width=device-width, initial-scale=1.0';
    if (m.getAttribute('content') !== want) m.setAttribute('content', want);
  },
  _showTextToolbar(target) {
    this._ttTarget = target;
    const tb = document.getElementById('textToolbar');
    if (!tb) return;
    this._setViewportZoom(true);                 // freeze scale while editing (mobile) — no focus auto-zoom
    tb.hidden = false; tb.classList.add('show');
    const dup = document.getElementById('tt-dup');
    if (dup) dup.disabled = (target.kind === 'line');   // duplicate/move are added-text only
    const lp = document.getElementById('tt-link-pop'); if (lp) lp.hidden = true;   // fresh per selection
    this._reflectTextToolbar();
    this._positionTextToolbar();
  },
  hideTextToolbar() {
    this._ttTarget = null;
    const tb = document.getElementById('textToolbar');
    if (tb) { tb.classList.remove('show'); tb.hidden = true; }
    // Also close the text toolbar's pop-overs (the colour one may have been re-parented to <body> on mobile,
    // so it wouldn't hide with the toolbar otherwise — it would linger as an overlay over the next mode).
    ['tt-link-pop', 'tt-color-pop', 'tt-font-pop'].forEach(id => { const e = document.getElementById(id); if (e) e.hidden = true; });
    this._setViewportZoom(false);                // editing done — restore pinch-zoom of the PDF (mobile)
  },
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
    let bold = !!o.bold, italic = !!o.italic, underline = !!o.underline;
    if (t.kind === 'overlay' && o.runs && o.runs.length) {
      const flat = o.runs.flat();
      if (flat.length) { bold = flat.every(r => r.bold); italic = flat.every(r => r.italic); }
    } else if (t.kind === 'line' && o.styleRuns && o.styleRuns.length) {
      // A mixed existing line reflects bold/italic/underline as "every run" — so the buttons light up
      // only when the WHOLE line is that style (a partly-bold line shows the Bold button off).
      bold = o.styleRuns.every(r => r.bold);
      italic = o.styleRuns.every(r => r.italic);
      underline = o.styleRuns.every(r => r.underline);
    }
    // Prefer the REAL font name (from PDF.js's rendered font object) so a saved+reopened font
    // re-selects in the picker; fall back to the generic guess before the page has resolved.
    const famKey = this._displayFontKey(o.fontFamily, this._realFontName(o) || o.fontFamilyName || o.fontName);
    return { bold, italic, underline, size,
             // Reflect the line's REAL ink colour (sampled into textColor) when the user hasn't set an
             // explicit toolbar colour yet — otherwise the swatch shows black on first open for a
             // white/grey/coloured line until you change it.
             color: o.color || o.textColor, opacity: o.opacity, align: o.align,
             link: o.link ? o.link.uri : '',
             family: famKey,
             // Existing text whose original font isn't in the dropdown (LaTeX/Computer-Modern or any
             // other unmapped embedded face) is REDRAWN in its own/closest original face on save, so
             // the picker shows "Original" instead of an unset Arial-looking placeholder.
             fontOriginal: (t.kind === 'line' && !famKey) };
  },
  _reflectTextToolbar() {
    const s = this._ttStyle();
    const tog = (id, v) => document.getElementById(id)?.classList.toggle('on', !!v);
    tog('tt-bold', s.bold); tog('tt-italic', s.italic); tog('tt-underline', s.underline);
    tog('tt-link', s.link);
    tog('tt-align-left', (s.align || 'left') === 'left'); tog('tt-align-center', s.align === 'center'); tog('tt-align-right', s.align === 'right');
    // Don't clobber an input the user is actively typing into (else mid-type reflect mangles it).
    const set = (id, v) => { const el = document.getElementById(id); if (el != null && v != null && el !== document.activeElement) el.value = v; };
    if (s.size) set('tt-size', s.size);
    // Reflect the font: a known family shows its name; existing text on an unmapped original font
    // (LaTeX/Computer-Modern, etc.) shows "Original" (the editor preserves it — not an Arial default);
    // otherwise the "Select a Font Style" placeholder (added text).
    this._setFontPickerValue(s.family || '', s.fontOriginal ? 'Original' : undefined);
    this._setColorSwatch(s.color ? rgbToHex(s.color) : '#000000');
    set('tt-opacity', Math.round((s.opacity == null ? 1 : s.opacity) * 100));
  },
  /** Position the toolbar above the selected text, clamped inside the stage, flipping below if it
   *  would clip the top. Anchors to the (PDF-positioned) DOM element so it tracks zoom/scroll/resize. */
  _positionTextToolbar() {
    const t = this._ttTarget, tb = document.getElementById('textToolbar');
    if (!t || !tb || tb.hidden) return;
    // MOBILE: the toolbar is CSS-PINNED as a fixed bar at the top. Never reposition it and — crucially —
    // never auto-hide it here when the edited line scrolls out of view: it must STAY put while the user
    // scrolls. Return BEFORE the isConnected check below (which was hiding it on scroll). Desktop keeps
    // tracking the element.
    if (window.matchMedia && window.matchMedia('(max-width: 767px)').matches) {
      // MOBILE: pin to the TOP of the VISUAL viewport so the bar stays visible when the keyboard scrolls
      // the page up (a plain position:fixed top:0 ends up ABOVE the visible area on iOS Safari). The
      // visualViewport 'resize'/'scroll' listeners re-run this so it tracks the keyboard. Never auto-hide.
      const vv = window.visualViewport;
      if (vv) { tb.style.top = Math.round(vv.offsetTop) + 'px'; tb.style.left = Math.round(vv.offsetLeft) + 'px'; tb.style.width = Math.round(vv.width) + 'px'; }
      else { tb.style.top = '0px'; tb.style.left = '0px'; }
      return;
    }
    const el = t.kind === 'overlay' ? this._overlayElFor(t.edit) : t.el;
    if (!el || !el.isConnected) { this.hideTextToolbar(); return; }
    const r = el.getBoundingClientRect();
    const tw = tb.offsetWidth || 360, th = tb.offsetHeight || 40;
    // DESKTOP (unchanged): anchor within the stage, flipping below if it would clip the top.
    const stage = document.getElementById('stage');
    const sr = stage ? stage.getBoundingClientRect() : { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight };
    let left = Math.max(sr.left + 4, Math.min(r.left + r.width / 2 - tw / 2, sr.right - tw - 4));
    let top = r.top - th - 8;
    if (top < sr.top + 4) top = r.bottom + 8;                       // would clip the top -> drop below
    top = Math.max(sr.top + 4, Math.min(top, sr.bottom - th - 4));  // keep on-screen
    tb.style.left = left + 'px';
    tb.style.top = top + 'px';
  },
  /** Apply a hyperlink (or clear it with value=''). With an active text SELECTION in the open editor
   *  it links only that selection; otherwise the whole text object. Linked text defaults to blue +
   *  underline (the standard look) UNLESS the user already set a colour, which then supersedes. */
  _applyLink(t, value) {
    const uri = (value == null ? '' : String(value)).trim();
    const BLUE = LINK_BLUE;
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
      if (l.color == null) { l.color = BLUE; div.style.color = rgbCss(BLUE); }
      l.underline = true; div.style.textDecoration = 'underline';
    }
    this.trackEdit(this.lineToEdit(l, text));
  },
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
  },
  /** Default a whole text object's link look to blue + underline, unless a colour is already set. */
  _defaultLinkStyle(edit, el) {
    if (edit.color == null) { edit.color = LINK_BLUE; if (el) el.style.color = rgbCss(edit.color); }
    edit.underline = true; if (el) el.style.textDecoration = 'underline';
  },
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
  },
  _setBoxField(edit, kind, value) {
    if (kind === 'underline') edit.underline = !!value;
    else if (kind === 'color') edit.color = value;
    else if (kind === 'opacity') edit.opacity = value;
    else if (kind === 'align') edit.align = value;
    else if (kind === 'family') edit.fontFamily = value;
    else if (kind === 'link') this._setLink(edit, value);
  },
  /** Set/clear a hyperlink on an edit/line. A URL stores `{uri}`; clearing it marks `linkRemoved` so
   *  the backend drops a previously-present (e.g. detected-on-load) link instead of re-adding it. */
  _setLink(obj, value) {
    const uri = (value == null ? '' : String(value)).trim();
    if (uri) { obj.link = { uri }; obj.linkRemoved = false; }
    else { if (obj.link) obj.linkRemoved = true; obj.link = null; }
  },
  _restyleEditorDiv(div, kind, value) {
    if (!div) return;
    if (kind === 'underline') div.style.textDecoration = value ? 'underline' : 'none';
    else if (kind === 'color') div.style.color = rgbCss(value);
    else if (kind === 'opacity') div.style.opacity = value;
    else if (kind === 'align') div.style.textAlign = value;
    else if (kind === 'family') div.style.fontFamily = this._familyCss(value);
    else if (kind === 'link') div.classList.toggle('tt-has-link', !!(value && String(value).trim()));
  },
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
  },
  /** Whole-line styling for a focused existing-text line box (updates CSS in place + tracks the edit
   *  immediately; trackEdit does not re-render, so the box keeps focus). */
  _applyLineStyle(t, kind, value) {
    const l = t.line, div = t.el;
    const wasUnderlined = !!l.underline;   // capture BEFORE the toggle, to know if an old rule needs covering
    // Mark bold/italic as EXPLICITLY set by the user so the save honours it verbatim (incl. turning a
    // bold/italic line OFF). Otherwise the engine's "recover a missed bold" union would re-bold it.
    if (kind === 'bold') l.boldSet = true;
    if (kind === 'italic') l.italicSet = true;
    // The box is styled with the PAGE's OWN font (pdf.js loadedName, e.g. a baked Helvetica-Bold face —
    // carried in BOTH l.fontName and l.fontCss) whose weight/slant is BAKED IN, so CSS font-weight/style
    // can't restyle it and the box keeps LOOKING bold after an unbold (editor ≠ what the save produces).
    // The moment the user overrides bold/italic, switch the preview to a purely GENERIC, weight-respecting
    // family stack (dropping the baked face) so it renders the chosen weight — matching the saved output.
    if (kind === 'bold' || kind === 'italic') {
      div.style.fontFamily = l.fontFamily ? this._familyCss(l.fontFamily)
        : (l.serif ? '"Times New Roman", Times, serif' : 'Arial, Helvetica, sans-serif');
    }
    const rich = !!(l.styleRuns && l.styleRuns.length) &&
      div.querySelector('span[data-bold],span[data-italic],span[data-underline]');
    if (rich && (kind === 'bold' || kind === 'italic' || kind === 'underline')) {
      // Whole-line B/I/U on a MIXED line: apply it to EVERY run span (so the line becomes uniformly
      // that style) while keeping the per-run model for the others.
      div.querySelectorAll('span').forEach((sp) => {
        if (kind === 'underline') {
          if (value) { sp.setAttribute('data-underline', '1'); sp.style.textDecoration = 'underline'; }
          else { sp.removeAttribute('data-underline'); sp.style.textDecoration = 'none'; }
        } else {
          sp.setAttribute('data-' + kind, value ? '1' : '0');
          sp.style[kind === 'bold' ? 'fontWeight' : 'fontStyle'] = value ? (kind === 'bold' ? 'bold' : 'italic') : 'normal';
        }
      });
      l[kind] = !!value;
    } else if (kind === 'bold') { l.bold = !!value; div.style.fontWeight = value ? 'bold' : 'normal'; }
    else if (kind === 'italic') { l.italic = !!value; div.style.fontStyle = value ? 'italic' : 'normal'; }
    else if (kind === 'underline') { l.underline = !!value; div.style.textDecoration = value ? 'underline' : 'none'; }
    else if (kind === 'size') { l.fontSizePx = value * this.scale; l.sizeOverridden = true; div.style.fontSize = (value * this.scale * (div.__displayScale || 1)) + 'px'; }
    else if (kind === 'color') { l.color = value; div.style.color = rgbCss(value); }
    else if (kind === 'opacity') { l.opacity = value; div.style.opacity = value; }
    else if (kind === 'align') { l.align = value; div.style.textAlign = value; }
    else if (kind === 'family') { l.fontFamily = value; div.style.fontFamily = this._familyCss(value); }
    else if (kind === 'link') { this._setLink(l, value); div.classList.toggle('tt-has-link', !!l.link); }
    // Removing an underline that was there (incl. one WE baked on a prior save): flag the edit so the
    // backend covers the old rule. Re-adding clears the flag so a fresh underline is drawn instead.
    if (kind === 'underline') l._coverUnderline = wasUnderlined && !value;
    const runs = this._readLineRuns(div);
    if (runs) l.styleRuns = runs;
    this.trackEdit(this.lineToEdit(l, this.cleanEditableText(div.textContent), runs));
  },
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
  },
  /** Delete the active text: an added object is removed; an existing line is blanked (redacted). */
  deleteActiveText() {
    const t = this._ttTarget;
    if (!t) return;
    if (t.kind === 'editor') {
      // An OPEN Add-text editor: cancel it so the text box is removed (not committed).
      if (this._activeInsertEditor && this._activeInsertEditor.cancel) this._activeInsertEditor.cancel();
      else this.hideTextToolbar();
      return;
    }
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
  },
};
