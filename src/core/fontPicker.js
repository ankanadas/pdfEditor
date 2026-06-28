// Font picker — catalogue key resolution, recent fonts, the picker dropdown + its value.
// Assembled onto PDFEditorApp.prototype (mixin); verbatim from app.js (this = the app).
import { familyKeyFromFont } from '../util/fonts.js';
import { FONT_CATALOG, FONT_BY_KEY } from '../util/fontCatalog.js';

export const FontPickerMethods = {
  /**
   * Get CSS font family from PDF font name
   */
  getFontFamily(fontName) {
    if (!fontName) return 'Arial, sans-serif';
    
    const fontLower = fontName.toLowerCase();
    if (fontLower.includes('times') || fontLower.includes('serif')) {
      return '"Times New Roman", Times, serif';
    } else if (fontLower.includes('courier') || fontLower.includes('mono')) {
      return '"Courier New", Courier, monospace';
    } else {
      return 'Arial, Helvetica, sans-serif';
    }
  },
  /** The on-screen font-family for a stored key (editor text + dropdown preview). */
  _familyCss(f) {
    const e = FONT_BY_KEY[(f || '').toLowerCase()];
    if (e) return e.css;
    return ({ serif: '"Times New Roman", "pf-tinos", serif', mono: '"Courier New", "pf-cousine", monospace' })[f]
      || 'Arial, "pf-arimo", sans-serif';
  },
  /** Normalise a stored fontFamily to a catalogue key. Catalogue keys pass through; the legacy
   *  sans/serif/mono map to their nearest entry; anything else -> '' (unknown). */
  _normFamilyKey(fam) {
    const f = (fam || '').toLowerCase();
    if (FONT_BY_KEY[f]) return f;
    return ({ sans: 'arial', serif: 'times', mono: 'courier' })[f] || '';
  },
  /** The catalogue key to SHOW for a target: an explicit family override, else a guess from the PDF
   *  font name, else '' (-> the "Select a Font Style" placeholder). */
  _displayFontKey(fam, fontName) {
    return this._normFamilyKey(fam) || familyKeyFromFont(fontName) || '';
  },
  /** Resolve a text item's REAL font name (e.g. 'Inter Regular', 'Carlito Bold') from PDF.js's font
   *  object. getTextContent only exposes a loaded id ('g_d0_f5') + a generic family, but once a page
   *  has rendered its commonObjs hold the real name — which lets the picker re-show a saved font on
   *  reopen. Returns '' until the font is resolved (then callers fall back to the generic guess). */
  _realFontName(o) {
    if (!o || !o.fontName) return '';
    for (const pv of this.pageViews || []) {
      try {
        const co = pv.page && pv.page.commonObjs;
        if (!co) continue;
        if (typeof co.has === 'function' && !co.has(o.fontName)) continue;
        const f = co.get(o.fontName);
        if (f && f.name) return f.name;
      } catch (_) { /* not resolved on this page yet */ }
    }
    return '';
  },
  // ----- Searchable font picker (built once; the toolbar shows/reuses it) ---------------------------
  _recentFonts() {
    try { return JSON.parse(localStorage.getItem('qpe_recent_fonts') || '[]').filter(k => FONT_BY_KEY[k]); }
    catch (_) { return []; }
  },
  _pushRecentFont(key) {
    if (!FONT_BY_KEY[key]) return;
    const list = [key, ...this._recentFonts().filter(k => k !== key)].slice(0, 5);
    try { localStorage.setItem('qpe_recent_fonts', JSON.stringify(list)); } catch (_) {}
  },
  _initFontPicker() {
    const btn = document.getElementById('tt-font-btn');
    const pop = document.getElementById('tt-font-pop');
    const search = document.getElementById('tt-font-search');
    const list = document.getElementById('tt-font-list');
    const empty = document.getElementById('tt-font-empty');
    if (!btn || !pop || !search || !list || this._fontPickerInit) return;
    this._fontPickerInit = true;

    const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    const open = () => {
      const isMobile = window.matchMedia && window.matchMedia('(max-width: 767px)').matches;
      if (isMobile) {
        // Mobile: blur the editor so the keyboard CLOSES — the full-screen font sheet then shows the whole
        // list. Do NOT auto-focus the search box (focusing an input inside a fixed popover makes iOS
        // scroll-to-input and clip the sheet). The user can tap the search field to filter.
        const ae = document.activeElement; if (ae && ae.blur && ae !== search) ae.blur();
        // iOS clamps a position:fixed element to its overflow-scrolling ancestor — the text toolbar is now a
        // horizontal scroll row, so the font list rendered as a thin clipped strip (or not at all). Re-parent
        // to <body> so it anchors to the viewport and shows the full list.
        if (pop.parentElement !== document.body) document.body.appendChild(pop);
      }
      pop.hidden = false; btn.setAttribute('aria-expanded', 'true');
      search.value = ''; this._renderFontList('');
      if (!isMobile) setTimeout(() => search.focus(), 20);
    };
    btn.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden ? open() : close(); });
    search.addEventListener('input', () => this._renderFontList(search.value));
    // Choosing a row applies the font and remembers it.
    list.addEventListener('click', (e) => {
      const opt = e.target.closest('.tt-font-opt'); if (!opt) return;
      const key = opt.dataset.key;
      this.applyTextStyle('family', key);
      this._pushRecentFont(key);
      this._setFontPickerValue(key);
      close();
    });
    // Keyboard: arrows move the active row, Enter selects, Esc closes.
    search.addEventListener('keydown', (e) => {
      const opts = Array.from(list.querySelectorAll('.tt-font-opt'));
      let i = opts.findIndex(o => o.classList.contains('active'));
      if (e.key === 'ArrowDown') { e.preventDefault(); i = Math.min(opts.length - 1, i + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); i = Math.max(0, i - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); if (opts[i < 0 ? 0 : i]) opts[i < 0 ? 0 : i].click(); return; }
      else if (e.key === 'Escape') { close(); btn.focus(); return; }
      else return;
      opts.forEach(o => o.classList.remove('active'));
      if (opts[i]) { opts[i].classList.add('active'); opts[i].scrollIntoView({ block: 'nearest' }); }
    });
    document.addEventListener('click', (e) => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('#tt-fontpick')) close(); });
    this.__fontPickerEls = { btn, pop, search, list, empty };
  },
  _renderFontList(filter) {
    const { list, empty } = this.__fontPickerEls || {};
    if (!list) return;
    const q = (filter || '').trim().toLowerCase();
    const cur = document.getElementById('tt-font')?.value || '';
    list.innerHTML = '';
    const optHTML = (f) => {
      const sel = f.key === cur ? ' selected' : '';
      // f.css contains double quotes (e.g. "pf-arimo", "Times New Roman"); they MUST be HTML-escaped or
      // they close the style="" attribute early — which left every quoted font rendering in the default
      // face instead of its own. &quot; decodes back to " so the CSS font-family is valid.
      const cssAttr = f.css.replace(/"/g, '&quot;');
      return `<button type="button" class="tt-font-opt${sel}" role="option" data-key="${f.key}" ` +
        `style="font-family:${cssAttr}"><span>${f.name}</span><span class="tt-font-tag">${f.tag}</span></button>`;
    };
    const match = (f) => !q || f.name.toLowerCase().includes(q) || f.tag.toLowerCase().includes(q);
    let html = '';
    if (!q) {
      const recent = this._recentFonts().map(k => FONT_BY_KEY[k]).filter(Boolean);
      if (recent.length) html += `<div class="tt-font-group">Recently used</div>` + recent.map(optHTML).join('') + `<div class="tt-font-group">All fonts</div>`;
    }
    // All fonts listed ALPHABETICALLY by display name (the "Recently used" group above keeps recency).
    const shown = FONT_CATALOG.filter(match).slice().sort((a, b) => a.name.localeCompare(b.name));
    html += shown.map(optHTML).join('');
    list.innerHTML = html;
    if (empty) empty.hidden = shown.length > 0;
  },
  /** Reflect the current font key on the picker button (rendered in its own face), and update the
   *  hidden #tt-font value-holder the rest of the toolbar reads. '' -> the placeholder. */
  _setFontPickerValue(key, labelOverride) {
    const k = (key || '').toLowerCase();
    const hidden = document.getElementById('tt-font');
    const label = document.getElementById('tt-font-label');
    const e = FONT_BY_KEY[k];
    if (hidden) hidden.value = e ? k : '';
    if (label) {
      label.textContent = e ? e.name : (labelOverride || 'Select a Font Style');
      label.style.fontFamily = e ? e.css : '';
    }
  },
};
