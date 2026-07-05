// Search & Replace side panel — fuzzy search over the editable text layer (the per-line
// contentEditable boxes the app builds from the PDF's extracted text plus pending edits;
// div.dataset.originalText is the committed text). The Search tool in the left rail toggles the
// panel; matches list as per-page snippet cards. Fuzzy matching (util/fuzzyFind) absorbs PDF text
// quirks: ligatures, curly quotes, spacing variances, typos. Replacing works THROUGH the box
// exactly like the user typing: select the matched range, insert the replacement, blur to commit —
// so per-run styling, undo/redo (trackEdit → commitHistory), re-rendering and save fidelity all
// reuse the proven edit path.
//
// Styling rule (spec): while a match is found, the SAME #textToolbar used for Edit/Add docks as a
// SINGLE-LINE strip at the top of the main column — in the spot the contextual mode hint ("Edit or
// add text …") normally occupies (see _maybeDockTextToolbar; not a floating bubble). If it is
// untouched, the replacement inherits the matched text's own style (font family/size/colour/
// weight — that is what selection-insert does natively here); touching any control first SELECTS
// the match in its box (the capture-phase mousedown below), so the change styles the matched range
// via the partial-style machinery and the replacement then lands inside that styled run (override).
// Assembled onto PDFEditorApp.prototype (this = the app).
import { findInText } from '../util/fuzzyFind.js';
import { rgbToHex } from '../util/color.js';

// Result cards rendered at most; beyond this the list notes how many more exist (stepping still
// walks ALL matches — the cap only bounds the DOM).
const MAX_RESULT_CARDS = 200;

// Toolbar kinds a search-wide style override can carry (the partial-style capable set — size stays
// per-match because for existing lines it is whole-line semantics, not a range style).
const OVERRIDE_KINDS = ['family', 'color', 'bold', 'italic', 'underline'];

export const FindReplaceMethods = {
  initFindReplace() {
    this._find = { q: '', matches: [], idx: -1, hl: null, cards: [], override: {} };
    const $ = (id) => document.getElementById(id);
    const input = $('findInput');
    if (!input) return;
    let deb = null;
    input.addEventListener('input', () => {
      clearTimeout(deb);
      deb = setTimeout(() => this.findRun(input.value), 160);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.findStep(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { this.findClear(); input.blur(); }
    });
    $('findPrevBtn')?.addEventListener('click', () => this.findStep(-1));
    $('findNextBtn')?.addEventListener('click', () => this.findStep(1));
    $('replaceBtn')?.addEventListener('click', () => this.findReplaceCurrent());
    $('replaceAllBtn')?.addEventListener('click', () => this.findReplaceAll());
    $('replaceInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.findReplaceCurrent(); }
    });
    // Panel plumbing: the Search tool toggles it; ✕ closes; Clear resets the query in place.
    $('searchToolBtn')?.addEventListener('click', () => {
      const panel = $('searchPanel');
      if (panel && panel.hidden) this.findPanelOpen(); else this.findPanelClose();
    });
    $('searchPanelClose')?.addEventListener('click', () => this.findPanelClose());
    $('findClearBtn')?.addEventListener('click', () => { this.findClear(); input.focus(); });
    $('findCaseCb')?.addEventListener('change', () => this.findRun(input.value));   // re-run with/without case
    // Docked toolbar: the first interaction with any control SELECTS the current match in its box
    // (capture phase — ahead of the control's own handler), so every existing partial-style path
    // (font/colour/B/I/U on JUST the match) applies untouched. Skipped when the match range is
    // already live-selected (e.g. the user clicked the on-page highlight first).
    const tb = $('textToolbar');
    tb?.addEventListener('mousedown', () => {
      if (!tb.classList.contains('tt-docked')) return;
      const m = this._find.matches[this._find.idx];
      if (!m || !m.el || !m.el.isConnected) return;
      const sel = window.getSelection();
      const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      if (!(r && !r.collapsed && m.el.contains(r.commonAncestorContainer))) this.findSelectCurrent();
    }, true);
  },

  /** Open the Search panel (Search toggle in the TOP bar): the panel narrows the stage, and the
   *  responsive canvases (max-width:100%) shrink with it — but the text boxes were positioned with
   *  the displayScale captured at build time, so WITHOUT a re-render every box/highlight would sit
   *  off-place. Re-render first, then re-run a kept query on the fresh layer and focus the box. */
  async findPanelOpen() {
    const panel = document.getElementById('searchPanel');
    if (!panel) return;
    panel.hidden = false;
    const btn = document.getElementById('searchToolBtn');
    btn?.classList.add('active');
    btn?.setAttribute('aria-pressed', 'true');
    if (this.pdfJsDoc && this.refresh) await this.refresh();   // re-place boxes for the narrowed stage
    if (this.lazyEditMode) this._findEnsureIndex();            // pre-warm the whole-doc text index
    const input = document.getElementById('findInput');
    if (input) {
      if (input.value.trim()) this.findRun(input.value);
      input.focus(); input.select();
    }
  },

  /** Close the panel: highlights + docked toolbar go away; the query stays for reopening. The
   *  stage widens back, so re-render for the same reason findPanelOpen does. */
  findPanelClose() {
    const panel = document.getElementById('searchPanel');
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    const btn = document.getElementById('searchToolBtn');
    btn?.classList.remove('active');
    btn?.setAttribute('aria-pressed', 'false');
    const f = this._find;
    f.matches = []; f.idx = -1; f.cards = []; f.override = {};
    f.hl?.remove(); f.hl = null;
    clearTimeout(this._findBuildT);
    this._findBusyEnd();
    this._findToolbarOff();
    const res = document.getElementById('findResults');
    if (res) res.textContent = '';
    this._findCount();
    this._findSummary();
    ['findPrevBtn', 'findNextBtn', 'replaceBtn', 'replaceAllBtn'].forEach((id) => {
      const b = document.getElementById(id); if (b) b.disabled = true;
    });
    if (this.pdfJsDoc && this.refresh) this.refresh();         // re-place boxes for the widened stage
  },

  // ---- Docked text toolbar (consulted by _showTextToolbar / hideTextToolbar) -------------------
  /** Dock #textToolbar into the top strip (#searchTbSlot, where the mode hint normally shows) when
   *  the show-target IS the current find match with the panel open; undock (back to a floating
   *  bubble) for anything else. */
  _maybeDockTextToolbar(tb, target) {
    const slot = document.getElementById('searchTbSlot');
    const panel = document.getElementById('searchPanel');
    const f = this._find;
    const m = f && f.matches[f.idx];
    const dock = !!(slot && panel && !panel.hidden && target && target.kind === 'line' && m && m.el === target.el);
    if (!dock) { this._undockTextToolbar(tb); return; }
    if (tb.parentElement !== slot) slot.appendChild(tb);
    tb.classList.add('tt-docked');
    slot.hidden = false;
  },
  /** Restore the toolbar to its floating home (<body>) and collapse the panel slot. */
  _undockTextToolbar(tb) {
    tb = tb || document.getElementById('textToolbar');
    const slot = document.getElementById('searchTbSlot');
    if (slot) slot.hidden = true;
    if (tb && tb.classList.contains('tt-docked')) {
      tb.classList.remove('tt-docked');
      document.body.appendChild(tb);
    }
  },
  /** Show the docked toolbar for match m (the requirement: visible only while a match is found).
   *  Passive — reflects the match's style without focusing its box, so typing stays in the find
   *  input; the capture-phase mousedown in initFindReplace selects the match on first use. */
  _findToolbarOn(m) {
    const panel = document.getElementById('searchPanel');
    const line = m && m.el ? m.el.__line : null;
    if (!panel || panel.hidden || !line || !this._showTextToolbar) return;
    this._showTextToolbar({ kind: 'line', el: m.el, line });
  },
  /** Hide the toolbar IF it is ours (docked); a floating toolbar on some other edit is left alone. */
  _findToolbarOff() {
    const tb = document.getElementById('textToolbar');
    if (tb && tb.classList.contains('tt-docked') && this.hideTextToolbar) this.hideTextToolbar();
  },
  /** Style of the CURRENT match's own run, for the toolbar reflect (consulted by _ttStyle when no
   *  live selection exists — the passive docked show never selects, so without this a styled
   *  replacement would reflect the LINE average: "not bold / Original font" instead of its own
   *  font/colour/B/I/U). Whole-line matches defer to the line summary, which is already right. */
  _findMatchRunStyle(el) {
    const panel = document.getElementById('searchPanel');
    if (!panel || panel.hidden) return null;
    const m = this._find.matches[this._find.idx];
    if (!m || m.el !== el || !el.isConnected) return null;
    const full = (el.textContent || '').length;
    if (m.start === 0 && m.end >= full) return null;
    return this._lineCharRangeStyle(el, m.start);
  },

  // ---- Sticky style override (docked toolbar -> EVERY replacement) ------------------------------
  /** Called from applyTextStyle: while the toolbar is docked, remember the user's choice so it
   *  applies to every replacement of this search — not just the currently selected match. */
  _findRecordOverride(kind, value) {
    const tb = document.getElementById('textToolbar');
    if (!tb || !tb.classList.contains('tt-docked')) return;
    if (!OVERRIDE_KINDS.includes(kind)) return;
    this._find.override = this._find.override || {};
    this._find.override[kind] = value;
  },
  /** Re-assert the sticky choices on the docked toolbar's controls after a reflect (stepping to
   *  another match would otherwise show that match's own style — e.g. "Original" in the font
   *  picker — as if the user's pick had been dropped). */
  _findReflectOverride() {
    const tb = document.getElementById('textToolbar');
    const o = this._find && this._find.override;
    if (!tb || !tb.classList.contains('tt-docked') || !o) return;
    const tog = (id, v) => document.getElementById(id)?.classList.toggle('on', !!v);
    if ('bold' in o) tog('tt-bold', o.bold);
    if ('italic' in o) tog('tt-italic', o.italic);
    if ('underline' in o) tog('tt-underline', o.underline);
    if ('color' in o && o.color) this._setColorSwatch(rgbToHex(o.color));
    if ('family' in o && o.family) this._setFontPickerValue(o.family);
  },
  /** Style the CURRENTLY SELECTED match range with every recorded override (family first so the
   *  styled runs keep composing). Styling never changes the text, so match offsets stay valid; the
   *  partial-style machinery restores the same selection afterwards, ready for the insert. */
  _findApplyOverride(t) {
    const o = this._find.override;
    if (!t || !t.line || !o || !Object.keys(o).length) return;
    const prev = this._ttTarget;
    this._ttTarget = t;               // the partial-style selection capture reads the target
    for (const kind of OVERRIDE_KINDS) {
      if (kind in o) this._applyLineStyle(t, kind, o[kind]);
    }
    this._ttTarget = prev;
  },

  /** The searchable text layer: every line box, with its committed text and page.
   *  LAZY-editable docs (501+ pages) never have boxes for more than the painted window, so they
   *  search the BACKGROUND INDEX instead (virtual entries, el resolved on demand); ≤500-page docs
   *  keep this exact DOM scan. */
  _findEntries() {
    if (this.lazyEditMode) return this._findVirtualEntries();
    const out = [];
    for (const pv of (this.pageViews || [])) {
      if (!pv || !pv.wrapper) continue;
      pv.wrapper.querySelectorAll('.editable-text-box').forEach((el) => {
        const text = el.dataset.originalText || el.textContent || '';
        if (text.trim()) out.push({ el, text, pageIndex: pv.pageNum });
      });
    }
    return out;
  },

  // ---- Background index for LAZY-editable docs (search is decoupled from the painted window) ----
  /** Build the whole-document text index in the background: hydrate every page's text geometry
   *  (idempotent, shared with the painter — pages the user visited are already done) WITHOUT
   *  painting anything. Data-only: extractedTextItems grows; no canvas, no layout. Progress is
   *  exposed via _lazyIndexDone so the summary shows "scanning…" until the count is final. */
  async _findEnsureIndex() {
    if (!this.lazyEditMode || !this.pdfJsDoc) return;
    const gen = this.originalFileData;                 // doc identity: a new load aborts this build
    if (this._lazyIndexFor === gen && (this._lazyIndexDone || this._lazyIndexBuilding)) return;
    this._lazyIndexFor = gen;
    this._lazyIndexBuilding = true;
    this._lazyIndexDone = false;
    try {
      for (const pv of (this.pageViews || [])) {
        if (this.originalFileData !== gen || !this.lazyEditMode) return;
        await this._ensurePageExtracted(pv);
        // Yield between pages so typing/scrolling stays smooth while the index builds.
        if ((pv.pageNum & 3) === 3) await new Promise((r) => setTimeout(r, 0));
      }
      if (this.originalFileData === gen) this._lazyIndexDone = true;
    } finally {
      if (this.originalFileData === gen) this._lazyIndexBuilding = false;
    }
  },
  /** Virtual entries from the index: the SAME line grouping the painter uses (identical text and
   *  geometry as the eventual boxes), with pending edits reflected. el stays null until the
   *  match's page is painted and _findMaterialize resolves the live box. */
  _findVirtualEntries() {
    const byPage = new Map();
    for (const it of (this.extractedTextItems || [])) {
      let a = byPage.get(it.pageIndex);
      if (!a) byPage.set(it.pageIndex, a = []);
      a.push(it);
    }
    const out = [];
    for (const [pageIndex, items] of byPage) {
      for (const line of this.groupTextItemsByLine(items)) {
        const pend = this.findLineEdit(line);
        const text = pend ? pend.newText : line.text;
        if (text && text.trim()) out.push({ el: null, line, text, pageIndex });
      }
    }
    return out;
  },
  /** The live box for a virtual match on a PAINTED page (matched by the line's own geometry). */
  _findResolveEl(m, pv) {
    pv = pv || (this.pageViews || [])[m.pageIndex];
    if (!pv || !pv.wrapper || !m.line) return null;
    for (const el of pv.wrapper.querySelectorAll('.editable-text-box')) {
      const ln = el.__line;
      if (ln && Math.abs(ln.left - m.line.left) < 2 && Math.abs(ln.baseline - m.line.baseline) < 2) return el;
    }
    return null;
  },
  /** Materialise a virtual match: (optionally) scroll its page into view, drive the windowed
   *  painter directly, and poll until the page's boxes exist and the match's box resolves. The
   *  highlight/replace machinery then runs on the SAME live-element path as small documents. */
  async _findMaterialize(m, scroll = true) {
    if (m.el && m.el.isConnected) return m.el;
    if (!this.lazyEditMode) return null;
    const pv = (this.pageViews || [])[m.pageIndex];
    if (!pv) return null;
    if (scroll) pv.wrapper.scrollIntoView({ block: 'center' });
    if (this._lePaint) this._lePaint(pv);
    const t0 = performance.now();
    while (performance.now() - t0 < 12000) {
      const el = this._findResolveEl(m, pv);
      if (el) { m.el = el; return el; }
      await new Promise((r) => setTimeout(r, 120));
      if (this._lePaint) this._lePaint(pv);          // re-kick if an eviction raced the resolve
    }
    return null;
  },

  /** Run the search; with keepPos=true try to stay at/after the previous match (post-replace). */
  findRun(query, keepPos = false) {
    const f = this._find;
    const prevAt = keepPos && f.matches[f.idx]
      ? { p: f.matches[f.idx].pageIndex, s: f.matches[f.idx].start } : null;
    const qNew = (query ?? f.q ?? '').trim();
    if (qNew !== f.q) f.override = {};       // a NEW search starts style-clean
    f.q = qNew;
    f.matches = []; f.idx = -1;
    if (f.q) {
      // Match case (exact): case-SENSITIVE comparison AND no typo tolerance — with the fuzzy
      // budget left on, a pure case difference would still land as a 1-edit "close match",
      // which is exactly what the option exists to exclude.
      const matchCase = !!document.getElementById('findCaseCb')?.checked;
      const entries = this._findEntries();
      const collect = (budget) => {
        const out = [];
        for (const entry of entries) {
          for (const hit of findInText(entry.text, f.q, budget, { matchCase })) out.push({ ...entry, ...hit });
        }
        return out;
      };
      // EXACT-FIRST, fuzzy as FALLBACK: when the document has exact hits, show ONLY those —
      // otherwise a short query like "text" also lights up its 1-edit neighbours ("tent",
      // "test"). The close-match rescue (typos, "Sofware"→Software) only runs when NOTHING
      // matches exactly, so it still saves a misspelt query without polluting a correct one.
      f.matches = collect(0);
      if (!f.matches.length && !matchCase) f.matches = collect(undefined);   // undefined -> default edit budget
      // Reading order: page, then vertical position on the page, then offset in the line.
      // Virtual (index) entries have no box yet — their line geometry gives the same ordering.
      const top = (m) => (m.el ? m.el.offsetTop : m.line.top);
      const left = (m) => (m.el ? m.el.offsetLeft : m.line.left);
      f.matches.sort((a, b) => a.pageIndex - b.pageIndex || top(a) - top(b)
        || left(a) - left(b) || a.start - b.start);
      // Lazy docs: make sure the background index is building; the rescan below converges the
      // count as pages are indexed (data-only — nothing paints).
      if (this.lazyEditMode) this._findEnsureIndex();
    }
    const on = f.matches.length > 0;
    ['findPrevBtn', 'findNextBtn', 'replaceBtn', 'replaceAllBtn'].forEach((id) => {
      const b = document.getElementById(id); if (b) b.disabled = !on;
    });
    this._findRenderResults();
    this._findSummary();
    // The text layer builds PROGRESSIVELY on big documents — a query typed mid-build only sees the
    // pages that exist so far (a 100-page doc reported "1 of 43"). Keep re-scanning until the
    // renderer flags the build complete, so the count/cards converge to the whole document.
    this._findScheduleBuildRescan();
    if (!on) { f.hl?.remove(); f.hl = null; this._findToolbarOff(); this._findCount(); return; }
    let at = 0;
    if (prevAt) {
      const i = f.matches.findIndex((m) => m.pageIndex > prevAt.p
        || (m.pageIndex === prevAt.p && m.start >= prevAt.s));
      if (i >= 0) at = i;
    }
    this._findGoto(at);
  },

  /** Step to the next (+1) / previous (−1) match, wrapping; rescans if boxes were rebuilt.
   *  (Virtual matches — el not resolved yet — are NOT stale; only a disconnected box is.) */
  findStep(d) {
    const f = this._find;
    if (f.matches.some((m) => m.el && !m.el.isConnected)) this.findRun(f.q, true);
    if (!f.matches.length) return;
    this._findGoto((f.idx + d + f.matches.length) % f.matches.length);
  },

  _findCount() {
    const el = document.getElementById('findCount');
    const f = this._find;
    if (el) el.textContent = f.matches.length ? `${f.idx + 1} of ${f.matches.length}` : '0 of 0';
  },

  /** "N matches" line in the panel head (blank until there is a query). */
  _findSummary() {
    const el = document.getElementById('findSummary');
    if (!el) return;
    const f = this._find;
    let s = f.matches.length ? `${f.matches.length} match${f.matches.length === 1 ? '' : 'es'} found`
      : (f.q ? 'No matches' : '');
    // Mid-build: the number is a floor, not the final count — say so instead of looking done.
    // (Eager docs: the progressive text layer; lazy docs: the background index still filling.)
    if (f.q && (this._textLayerComplete === false || (this.lazyEditMode && this._lazyIndexDone === false))) s += ' — scanning…';
    el.textContent = s;
  },

  /** While the renderer is still building the text layer page-by-page, re-run the active query on
   *  a short cadence (anchored via keepPos) so the results grow to cover the WHOLE document. Stops
   *  when the build completes (one final run lands with the flag true) or the query changes. */
  _findScheduleBuildRescan() {
    clearTimeout(this._findBuildT);
    const f = this._find;
    const indexing = this.lazyEditMode && this._lazyIndexDone === false;
    if (!f.q || (this._textLayerComplete !== false && !indexing)) return;
    const q = f.q;
    this._findBuildT = setTimeout(() => {
      if (this._find.q !== q || this._find.busy) return;   // query changed / replace in flight
      const panel = document.getElementById('searchPanel');
      if (!panel || panel.hidden) return;
      this.findRun(q, true);                               // re-schedules itself until complete
    }, 600);
  },

  /** Rebuild the results list: one snippet card per match ("Page N — …context around the hit…"),
   *  clicking a card jumps to that match. Capped at MAX_RESULT_CARDS with an explicit "+N more". */
  _findRenderResults() {
    const wrap = document.getElementById('findResults');
    if (!wrap) return;
    wrap.textContent = '';
    const f = this._find;
    f.cards = [];
    const CTX = 34;                                    // context characters shown around the hit
    f.matches.slice(0, MAX_RESULT_CARDS).forEach((m, i) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'find-card';
      card.title = 'Jump to this match';
      const pg = document.createElement('span');
      pg.className = 'find-card-page';
      pg.textContent = 'Page ' + (m.pageIndex + 1);    // pv.pageNum is 0-based
      const snip = document.createElement('span');
      snip.className = 'find-card-snip';
      const a = Math.max(0, m.start - CTX), b = Math.min(m.text.length, m.end + CTX);
      snip.appendChild(document.createTextNode((a > 0 ? '…' : '') + m.text.slice(a, m.start)));
      const mk = document.createElement('mark');
      mk.textContent = m.text.slice(m.start, m.end);
      snip.appendChild(mk);
      snip.appendChild(document.createTextNode(m.text.slice(m.end, b) + (b < m.text.length ? '…' : '')));
      card.append(pg, snip);
      card.addEventListener('click', () => this._findGoto(i));
      wrap.appendChild(card);
      f.cards.push(card);
    });
    if (f.matches.length > MAX_RESULT_CARDS) {
      const more = document.createElement('div');
      more.className = 'find-card-more';
      more.textContent = `…and ${f.matches.length - MAX_RESULT_CARDS} more — Enter steps through all of them`;
      wrap.appendChild(more);
    }
  },

  /** A DOM Range spanning match m inside its box (walks text nodes, so styled runs are fine). */
  _matchRange(m) {
    if (!m || !m.el || !m.el.isConnected) return null;
    const tw = document.createTreeWalker(m.el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let acc = 0, node, haveStart = false;
    while ((node = tw.nextNode())) {
      const len = node.nodeValue.length;
      if (!haveStart && acc + len > m.start) { range.setStart(node, Math.max(0, m.start - acc)); haveStart = true; }
      if (haveStart && acc + len >= m.end) { range.setEnd(node, Math.max(0, m.end - acc)); return range; }
      acc += len;
    }
    return null;
  },

  /** Highlight match i and scroll it into view (does NOT focus the box — navigation stays calm).
   *  On a lazy doc the match may live on an UNPAINTED page: jump the viewport there, let the
   *  windowed painter hydrate it, resolve the live box, THEN place the highlight as usual. */
  async _findGoto(i) {
    const f = this._find;
    const m = f.matches[i];
    if (!m) return;
    f.idx = i;
    this._findCount();
    if (!m.el || !m.el.isConnected) {
      const gen = (this._findGotoGen = (this._findGotoGen || 0) + 1);
      const el = await this._findMaterialize(m, true);
      // A newer goto/rescan superseded this one while the page painted — drop this highlight.
      if (!el || this._findGotoGen !== gen || f.matches[f.idx] !== m) return;
    }
    const range = this._matchRange(m);
    if (!range) return;
    const rect = range.getBoundingClientRect();
    const wrap = m.el.offsetParent || m.el.parentElement;
    if (!wrap) return;
    const wr = wrap.getBoundingClientRect();
    let hl = f.hl;
    if (!hl || !hl.isConnected || hl.parentElement !== wrap) {
      hl?.remove();
      hl = document.createElement('div');
      hl.className = 'find-hl';
      hl.title = 'Click to select this match — style it with the toolbar, or hit Replace';
      hl.addEventListener('click', () => this.findSelectCurrent());
      wrap.appendChild(hl);
      f.hl = hl;
    }
    hl.style.left = (rect.left - wr.left - 2) + 'px';
    hl.style.top = (rect.top - wr.top - 1) + 'px';
    hl.style.width = (rect.width + 4) + 'px';
    hl.style.height = (rect.height + 2) + 'px';
    hl.scrollIntoView({ block: 'center' });
    // Sync the results list (active card) and the docked toolbar to the new current match.
    (f.cards || []).forEach((c, ci) => c.classList.toggle('active', ci === i));
    if (f.cards && f.cards[i]) f.cards[i].scrollIntoView({ block: 'nearest' });
    this._findToolbarOn(m);
  },

  /** Focus the current match's box and select the matched range — the text toolbar shows via the
   *  focus handler (docked in the panel for the current match) and reflects the selection, ready
   *  for a style override before replacing. */
  findSelectCurrent() {
    const m = this._find.matches[this._find.idx];
    if (!m || !m.el || !m.el.isConnected) return false;
    m.el.focus();
    const r = this._matchRange(m);
    if (!r) return false;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    // The toolbar's selection capture listens for mouseup on the box (same as manual selection).
    m.el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return true;
  },

  // ---- Replace-in-progress state (spinner on the clicked button, controls locked) --------------
  /** Lock the replace controls and put a spinner on the button driving the operation. Returns
   *  false when a replace is already running (re-entry guard). */
  _findBusyStart(btnId) {
    const f = this._find;
    if (f.busy) return false;
    f.busy = true;
    ['findPrevBtn', 'findNextBtn', 'replaceBtn', 'replaceAllBtn'].forEach((id) => {
      const b = document.getElementById(id); if (b) b.disabled = true;
    });
    document.getElementById(btnId)?.classList.add('find-busy');
    return true;
  },
  /** Clear the spinner; the rescan's findRun re-enables the buttons per the fresh match state. */
  _findBusyEnd() {
    this._find.busy = false;
    ['replaceBtn', 'replaceAllBtn'].forEach((id) => document.getElementById(id)?.classList.remove('find-busy'));
  },
  /** One painted frame — lets the spinner actually RENDER before the synchronous replace work
   *  blocks the main thread (otherwise the browser never paints it). */
  _findNextPaint() {
    return new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
  },

  /** Replace over the LIVE selection like typing does — keeps surrounding styled runs intact. */
  _findInsertOverSelection(replacement) {
    let ok = false;
    try { ok = document.execCommand('insertText', false, replacement); } catch (_) { ok = false; }
    if (!ok) {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const r = sel.getRangeAt(0);
      r.deleteContents();
      if (replacement) {
        const node = document.createTextNode(replacement);
        r.insertNode(node);
        r.setStartAfter(node);
      }
      sel.removeAllRanges();
      sel.addRange(r);
    }
  },

  /** Replace the current match with the Replace field's text (empty = delete the match). */
  async findReplaceCurrent() {
    const f = this._find;
    let m = f.matches[f.idx];
    if (!m) return;
    if (m.el && !m.el.isConnected) {
      // Stale text layer (a mode round-trip or re-render rebuilt the boxes): rescan and CONTINUE
      // with the fresh match — returning here made the first Replace click a silent no-op.
      this.findRun(f.q, true);
      m = f.matches[f.idx];
      if (!m || (m.el && !m.el.isConnected)) return;
    }
    if (!this._findBusyStart('replaceBtn')) return;
    await this._findNextPaint();                   // let the spinner render before the work
    // Virtual match on an unpainted page (lazy doc): hydrate it first — the replace itself then
    // runs through the identical live-box path (styling, undo, save) as a small document.
    if (!m.el || !m.el.isConnected) {
      const el = await this._findMaterialize(m, true);
      if (!el) { this._findBusyEnd(); return; }
    }
    const rep = document.getElementById('replaceInput')?.value ?? '';
    const after = { pageIndex: m.pageIndex, start: m.start };
    if (!this.findSelectCurrent()) { this._findBusyEnd(); return; }
    // Sticky override: the docked toolbar's choices style THIS match's range first (idempotent if
    // the user already styled it live), so the replacement lands inside the styled run.
    this._findApplyOverride({ kind: 'line', el: m.el, line: m.el.__line });
    this._findInsertOverSelection(rep);
    m.el.blur();                                   // commit via the standard edit path (undo/redo included)
    this._findRescanAt(after);
  },

  /** Replace every current match (right-to-left per line so earlier offsets stay valid). */
  async findReplaceAll() {
    const f = this._find;
    if (!f.matches.length) return;
    if (!this._findBusyStart('replaceAllBtn')) return;
    await this._findNextPaint();                   // let the spinner render before the batch
    // LAZY doc: virtual matches replace page by page — hydrate each affected page, run the same
    // live-box replacement, move on (the painter's window cap evicts behind us, so a Replace All
    // across a 1200-page doc never accumulates canvases).
    if (this.lazyEditMode) { await this._findReplaceAllLazy(); return; }
    // Stale text layer (mode round-trip): the grouping below would silently SKIP disconnected
    // boxes — rescan first so every match is live.
    if (f.matches.some((m) => !m.el.isConnected)) {
      this.findRun(f.q, true);
      if (!f.matches.length) { this._findBusyEnd(); return; }
    }
    const rep = document.getElementById('replaceInput')?.value ?? '';
    const byEl = new Map();
    f.matches.forEach((m) => { const a = byEl.get(m.el) || []; a.push(m); byEl.set(m.el, a); });
    let n = 0;
    // ONE undo step for the WHOLE batch: every per-line blur/style commit inside the loop is
    // batched, and a single history snapshot lands at endHistoryBatch — so one Ctrl+Z reverts
    // the entire Replace All instead of needing one undo per replaced line.
    this.beginHistoryBatch();
    try {
      for (const [el, list] of byEl) {
        if (!el.isConnected) continue;
        el.focus();
        list.sort((a, b) => b.start - a.start);
        const t = el.__line ? { kind: 'line', el, line: el.__line } : null;
        for (const m of list) {
          const r = this._matchRange(m);
          if (!r) continue;
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
          // Sticky override: EVERY replacement gets the docked toolbar's font/colour/B/I/U — not
          // just the one match the user styled live. Styling keeps the text unchanged, so the
          // right-to-left offsets stay valid; the selection is restored over the match afterwards.
          if (t) this._findApplyOverride(t);
          this._findInsertOverSelection(rep);
          n++;
        }
        el.blur();
      }
    } finally {
      this.endHistoryBatch();
    }
    // The per-box focus above re-shows the toolbar, and for boxes OTHER than the current match it
    // UNDOCKS into a floating bubble anchored to that line — which then just lingered on screen
    // after the batch (the rescan's cleanup only hides a DOCKED toolbar). Hide it outright; the
    // rescan below re-docks it if matches remain.
    this.hideTextToolbar();
    if (this.showStatus) this.showStatus(`Replaced ${n} match${n === 1 ? '' : 'es'}.`, 'success');
    this._findRescanAt(null);
  },

  /** Replace All over the background index (lazy docs): group matches by LINE, walk pages in
   *  order, hydrate each page once, replace its matches right-to-left through the live box —
   *  the exact insert/override/blur mechanics of the eager path — then let the window cap evict.
   *  One history batch = one undo step for the whole operation, same as the eager Replace All. */
  async _findReplaceAllLazy() {
    const f = this._find;
    const rep = document.getElementById('replaceInput')?.value ?? '';
    const byLine = new Map();
    f.matches.forEach((m) => {
      const k = m.line || m.el;
      const a = byLine.get(k) || [];
      a.push(m);
      byLine.set(k, a);
    });
    let n = 0;
    this.beginHistoryBatch();
    try {
      for (const [, list] of byLine) {
        const el = await this._findMaterialize(list[0], false);
        if (!el) continue;                          // page failed to hydrate — skip, keep going
        el.focus();
        list.sort((a, b) => b.start - a.start);
        const t = el.__line ? { kind: 'line', el, line: el.__line } : null;
        for (const m of list) {
          m.el = el;
          const r = this._matchRange(m);
          if (!r) continue;
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
          if (t) this._findApplyOverride(t);
          this._findInsertOverSelection(rep);
          n++;
        }
        el.blur();
      }
    } finally {
      this.endHistoryBatch();
    }
    this.hideTextToolbar();
    if (this.showStatus) this.showStatus(`Replaced ${n} match${n === 1 ? '' : 'es'}.`, 'success');
    this._findRescanAt(null);
  },

  /** Re-run the search after a replace (the commit may rebuild boxes), staying near `pos`.
   *  Also ends the replace-in-progress state — the spinner runs until this rescan lands. */
  _findRescanAt(pos) {
    setTimeout(() => {
      this.findRun(this._find.q, !pos);
      if (pos && this._find.matches.length) {
        const i = this._find.matches.findIndex((m) => m.pageIndex > pos.pageIndex
          || (m.pageIndex === pos.pageIndex && m.start >= pos.start));
        if (i >= 0) this._findGoto(i);
      }
      this._findBusyEnd();
    }, 350);
  },

  findClear() {
    const f = this._find;
    f.q = ''; f.matches = []; f.idx = -1; f.cards = []; f.override = {};
    const inp = document.getElementById('findInput');
    if (inp) inp.value = '';
    f.hl?.remove(); f.hl = null;
    clearTimeout(this._findBuildT);
    this._findBusyEnd();
    this._findToolbarOff();
    const res = document.getElementById('findResults');
    if (res) res.textContent = '';
    this._findCount();
    this._findSummary();
    ['findPrevBtn', 'findNextBtn', 'replaceBtn', 'replaceAllBtn'].forEach((id) => {
      const b = document.getElementById(id); if (b) b.disabled = true;
    });
  },
};
