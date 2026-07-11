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
      if (!m) return;
      const sel = window.getSelection();
      const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      const liveMatchSel = r && !r.collapsed && m.el && m.el.isConnected && m.el.contains(r.commonAncestorContainer);
      // No live selection over the match (or its box went stale in a rescan) — (re)select it. Robust to
      // a DETACHED m.el: findSelectCurrent re-resolves the current box before selecting, so a docked
      // Bold/colour during the "scanning…" window styles JUST the match, not the whole line.
      if (!liveMatchSel) this.findSelectCurrent();
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
    // Focus the input IMMEDIATELY so the panel is usable the instant it opens — do NOT block on a
    // full re-render first (on a 700-page lazy doc that stalled the panel for seconds, so taps
    // seemed to do nothing and the user tapped repeatedly). Re-place the boxes for the narrowed
    // stage asynchronously; the visible pages repaint via the windowed painter without blocking.
    const input = document.getElementById('findInput');
    input?.focus();
    if (this.pdfJsDoc && this.refresh) Promise.resolve().then(() => this.refresh());
    // The whole-document text index is built lazily WHEN the user actually searches (findRun), not
    // merely on opening the panel — indexing 700 pages the moment the panel opens is wasted work on
    // a phone/tablet if the user is only glancing.
    if (input) {
      if (input.value.trim()) this.findRun(input.value);
      input.select();
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
    const base = this.lazyEditMode ? this._findVirtualEntries() : this._findBoxEntries();
    // Added-text overlays (the Add tool's inserts) are searchable/replaceable too, in BOTH modes.
    // Appended OUTSIDE the cached virtual index so a replace that only rewrites an insert's text is
    // reflected on the very next scan (concat returns a fresh array — the cache is never mutated).
    // NOTE: rotated PDF text is NO LONGER a separate entry here — it's now a first-class editable
    // rotated LINE (see groupTextItemsByLine rotatedBreak + createEditableTextBoxes), so it flows
    // through base (box/virtual) entries and is fully replaceable, not just highlightable.
    return base.concat(this._findAddedEntries());
  },
  /** Eager path: every painted per-line editable box, with its committed text and page. */
  _findBoxEntries() {
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
  /** Added text (the Add tool) as searchable entries. Each is a tracked edit with redact:false and
   *  newText, rendered as an .insert-overlay (NOT an .editable-text-box) — so the box/virtual scans
   *  miss it. The box is resolved by edit identity when the page is painted (null until then: the
   *  query still matches on newText, and navigating a match materialises its page). Signatures &
   *  images aren't text and are skipped. Rotation lives on edit.rotation (a CSS transform) and is
   *  never touched by replace, so a rotated insert keeps its slant after find-and-replace. */
  _findAddedEntries() {
    const out = [];
    for (const e of (this.edits || [])) {
      if (!e || e.redact !== false || e.kind === 'image' || e.kind === 'erase' || e.style === 'signature') continue;
      const text = e.newText;
      if (!text || !text.trim()) continue;
      out.push({ el: this._overlayElFor(e), text, pageIndex: e.pageIndex, addEdit: e });
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
      // ASYNCHRONOUS CHUNKING: extract ~50 pages, then hand a macrotask back to the browser so it
      // can run layout / GC / touch handling before the next chunk. This is what stops the iPad
      // from freezing (and then panic-killing the tab) while indexing a 700-page document.
      const CHUNK = 50;
      let sinceBreath = 0;
      for (const pv of (this.pageViews || [])) {
        if (this.originalFileData !== gen || !this.lazyEditMode) return;
        await this._ensurePageExtracted(pv);
        // Free the pdf.js operator-list cache for pages that aren't on screen — extracting text
        // for 700 pages otherwise leaves 700 parsed pages resident (a big chunk of the iPad memory
        // that crashed the tab). The text we need is already copied into extractedTextItems; if the
        // page is later scrolled to, the painter re-parses it on demand.
        if (!pv._lePainted && !pv._lePainting && pv.page && pv.page.cleanup) { try { pv.page.cleanup(); } catch (_) {} }
        if (++sinceBreath >= CHUNK) { sinceBreath = 0; await new Promise((r) => setTimeout(r, 0)); }
      }
      if (this.originalFileData === gen) this._lazyIndexDone = true;
    } finally {
      if (this.originalFileData === gen) this._lazyIndexBuilding = false;
    }
  },
  /** Virtual entries from the index: the SAME line grouping the painter uses (identical text and
   *  geometry as the eventual boxes), with pending edits reflected. el stays null until the
   *  match's page is painted and _findMaterialize resolves the live box.
   *
   *  CACHED: grouping every page of a 700-page doc is expensive, and findRun calls this on EVERY
   *  keystroke and every rescan — doing it each time froze typing on iPad ("type 'se', 'o' lands
   *  seconds later"). We cache by a cheap signature (item count + extracted-page count + edit
   *  count); typing the query touches none of those, so keystrokes reuse the cache and only re-run
   *  the (fast) matcher. New indexed pages or a replace bump the signature and rebuild once. */
  _findVirtualEntries() {
    const items = this.extractedTextItems || [];
    const sig = items.length + ':' + ((this._extractedPages && this._extractedPages.size) || 0) + ':' + ((this.edits && this.edits.length) || 0);
    // Include the document identity so a newly loaded doc with coincidentally-equal counts can't
    // reuse the previous doc's cached lines.
    if (this._veCache && this._veSig === sig && this._veDoc === this.originalFileData) return this._veCache;
    const byPage = new Map();
    for (const it of items) {
      // Rotated glyphs are KEPT now (they're editable rotated lines): groupTextItemsByLine gives each
      // rotated run its own single-run line (rotatedBreak), so they never merge into — or scramble —
      // the horizontal body lines, and stay searchable/replaceable like any other line. (This used to
      // skip rotated items to avoid the watermark-scramble; the separate-line grouping now prevents it.)
      let a = byPage.get(it.pageIndex);
      if (!a) byPage.set(it.pageIndex, a = []);
      a.push(it);
    }
    // O(1) pending-edit lookup by geometry key — findLineEdit per line is O(edits), so on a doc
    // with thousands of tracked edits (a big Replace All) this whole-document loop was O(n²) and
    // froze the rescan. The key is the SAME deterministic grouping value on both sides, so an exact
    // rounded match is safe (no drift, unlike a cross-render compare).
    const editMap = this._buildEditKeyMap();
    const s = this.scale || 1;
    const out = [];
    for (const [pageIndex, pageItems] of byPage) {
      for (const line of this.groupTextItemsByLine(pageItems)) {
        const pend = editMap.get(pageIndex + ':' + Math.round(line.left / s) + ':' + Math.round(line.baseline / s));
        const text = pend ? pend.newText : line.text;
        if (text && text.trim()) out.push({ el: null, line, text, pageIndex });
      }
    }
    this._veCache = out;
    this._veSig = sig;
    this._veDoc = this.originalFileData;
    return out;
  },
  /** Map every replace edit by a geometry key (pageIndex:round(xPt):round(baselinePt)) for O(1)
   *  lookup from a line — used by the whole-document search/replace loops to stay linear. */
  _buildEditKeyMap() {
    const m = new Map();
    for (const e of (this.edits || [])) {
      if (e && e.redact !== false && e.kind !== 'erase' && e.baseline != null && e.x != null) {
        m.set(e.pageIndex + ':' + Math.round(e.x) + ':' + Math.round(e.baseline), e);
      }
    }
    return m;
  },
  /** The live box for a virtual match on a PAINTED page (matched by the line's own geometry). */
  _findResolveEl(m, pv) {
    pv = pv || (this.pageViews || [])[m.pageIndex];
    // Added-text match: its live box is the insert overlay, found by the edit's identity (it exists
    // once the page is painted — createInsertOverlays runs in both the eager and lazy paint paths).
    if (m.addEdit) return this._overlayElFor(m.addEdit);
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
    // WHITESPACE-SIGNIFICANT anchors: a space the user typed at the START or END of the query
    // means "word edge here" — searching ` light ` finds "the light on" but neither "headlight"
    // nor "head-light", while plain `light` keeps matching all of them. Each anchored side must
    // land on whitespace OR the line edge (so ` light` still matches a line STARTING with the
    // word — there is no literal space before column 0). f.q stores the RAW query so rescans and
    // replaces keep the anchors; the trimmed core is what actually gets matched.
    const qRaw = String(query ?? f.q ?? '');
    const qCore = qRaw.trim();
    const anchorL = !!qCore && /^\s/.test(qRaw);
    const anchorR = !!qCore && /\s$/.test(qRaw);
    if (qRaw !== f.q) f.override = {};       // a NEW search starts style-clean
    f.q = qRaw;
    f.matches = []; f.idx = -1;
    if (qCore) {
      // Match case (exact): case-SENSITIVE comparison AND no typo tolerance — with the fuzzy
      // budget left on, a pure case difference would still land as a 1-edit "close match",
      // which is exactly what the option exists to exclude.
      const matchCase = !!document.getElementById('findCaseCb')?.checked;
      const entries = this._findEntries();
      const ws = (ch) => ch === undefined || /\s/.test(ch);
      const collect = (budget) => {
        const out = [];
        for (const entry of entries) {
          for (const hit of findInText(entry.text, qCore, budget, { matchCase })) {
            if (anchorL && !(hit.start === 0 || ws(entry.text[hit.start - 1]))) continue;
            if (anchorR && !(hit.end >= entry.text.length || ws(entry.text[hit.end]))) continue;
            out.push({ ...entry, ...hit });
          }
        }
        return out;
      };
      // EXACT-FIRST, fuzzy as FALLBACK: when the document has exact hits, show ONLY those —
      // otherwise a short query like "text" also lights up its 1-edit neighbours ("tent",
      // "test"). The close-match rescue (typos, "Sofware"→Software) only runs when NOTHING
      // matches exactly, so it still saves a misspelt query without polluting a correct one.
      f.matches = collect(0);
      // Fuzzy fallback (typo tolerance) scans EVERY line with an edit-distance budget — fine on a
      // normal doc, but O(all lines) of a 466+ page doc froze the main thread ~1 s (felt worst as
      // the post-Replace-All rescan, when the exact query now matches nothing). Skip it on lazy
      // (big) docs: exact-first search there stays instant, which is what matters at that scale.
      if (!f.matches.length && !matchCase && !this.lazyEditMode) f.matches = collect(undefined);
      // Reading order: page, then vertical position on the page, then offset in the line.
      // Virtual (index) entries have no box yet — their line geometry gives the same ordering.
      // Added-text matches (Add tool) carry neither a painted box (until their page is materialised)
      // NOR a `line` — they use the edit's own baseline/x. WITHOUT this guard `m.line.top` threw on
      // an unpainted added match, silently crashing the whole search (the "added-text search does
      // nothing on iPad/lazy" bug — an added insert on an off-screen page has el=null AND line=undefined).
      const top = (m) => (m.el ? m.el.offsetTop : (m.line ? m.line.top : (m.addEdit ? m.addEdit.baseline : 0)));
      const left = (m) => (m.el ? m.el.offsetLeft : (m.line ? m.line.left : (m.addEdit ? m.addEdit.x : 0)));
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
    // Scroll to the match ONLY on a fresh query (the user just typed something new). A rescan of
    // the SAME query — fired every 600ms while a big index builds, or after a replace — must NOT
    // move the viewport, or it fights the user's own scrolling (the "keeps yanking down" on iPad).
    const freshQuery = f.q !== this._findScrolledFor;
    this._findScrolledFor = f.q;
    this._findGoto(at, freshQuery && !keepPos);
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
   *  when the build completes — with ONE guaranteed final pass after the flags flip: a rescan can
   *  execute a beat before the last page's boxes land while the flag turns true in the same
   *  window, which froze the count one page short (99 of 100) with no further rescans. */
  _findScheduleBuildRescan() {
    clearTimeout(this._findBuildT);
    const f = this._find;
    const indexing = this.lazyEditMode && this._lazyIndexDone === false;
    const building = this._textLayerComplete === false || indexing;
    if (!f.q) { this._findFinalPass = false; return; }
    if (!building) {
      // Build finished. If the PREVIOUS run happened mid-build, run one last full pass now.
      if (!this._findFinalPass) return;
      this._findFinalPass = false;
    } else {
      this._findFinalPass = true;      // a mid-build run occurred — owe one pass after completion
    }
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

  /** EXACT highlight rect for a match on an OCR line, in VIEWPORT coordinates (drop-in for the
   *  range rect). The overlay text is TRANSPARENT over the scan and its generic font's advances
   *  differ from the printed glyphs, so a DOM-range-measured highlight drifts onto neighbouring
   *  words. The recognised WORD ITEMS carry the exact printed pixel boxes — map the match's char
   *  span through them instead (sub-word positions interpolated by character fraction). */
  _ocrMatchRect(m) {
    // box matches carry the live line on el.__line; virtual (unpainted-page) matches carry m.line
    const line = m && ((m.el && m.el.__line) || m.line);
    if (!line || !line.ocr || !Array.isArray(line.items) || !line.items.length) return null;
    const pv = (this.pageViews || [])[m.pageIndex];
    if (!pv || !pv.canvas) return null;
    const text = line.text || '';
    const s = m.start, e = m.end;
    let cursor = 0, x0 = null, x1 = null, top = null, bottom = null;
    for (const it of line.items) {
      const t = (it.text || '').trim();
      if (!t) continue;
      const idx = text.indexOf(t, cursor);
      if (idx < 0) continue;
      cursor = idx + t.length;
      if (idx + t.length <= s || idx >= e) continue;          // item entirely outside the match
      const w = it.right - it.left, L = t.length || 1;
      const fs = Math.max(s, idx) - idx, fe = Math.min(e, idx + t.length) - idx;
      const ix0 = it.left + w * (fs / L), ix1 = it.left + w * (fe / L);
      x0 = x0 == null ? ix0 : Math.min(x0, ix0);
      x1 = x1 == null ? ix1 : Math.max(x1, ix1);
      top = top == null ? it.top : Math.min(top, it.top);
      bottom = bottom == null ? it.bottom : Math.max(bottom, it.bottom);
    }
    if (x0 == null || x1 <= x0) return null;
    const cr = pv.canvas.getBoundingClientRect();
    const k = cr.width / pv.canvas.width;                     // canvas px → on-screen css px
    return { left: cr.left + x0 * k, top: cr.top + top * k, width: (x1 - x0) * k, height: (bottom - top) * k };
  },

  /** Highlight match i (does NOT focus the box — navigation stays calm). With scroll=true also
   *  bring it into view; a lazy match on an UNPAINTED page is hydrated (jump the viewport, let the
   *  windowed painter build it) — but ONLY when scrolling is allowed. With scroll=false (a rescan)
   *  we just track the index/count and refresh the highlight if its box happens to be on screen;
   *  we never move the viewport or paint an off-screen page. */
  async _findGoto(i, scroll = true) {
    const f = this._find;
    const m = f.matches[i];
    if (!m) return;
    f.idx = i;
    this._findCount();
    if (!m.el || !m.el.isConnected) {
      if (!scroll) {   // rescan: don't hydrate/scroll an off-screen match, just sync the list/toolbar
        (f.cards || []).forEach((c, ci) => c.classList.toggle('active', ci === i));
        return;
      }
      const gen = (this._findGotoGen = (this._findGotoGen || 0) + 1);
      const el = await this._findMaterialize(m, true);
      // A newer goto/rescan superseded this one while the page painted — drop this highlight.
      if (!el || this._findGotoGen !== gen || f.matches[f.idx] !== m) return;
    }
    const range = this._matchRange(m);
    if (!range) return;
    // OCR line → position from the printed word boxes (exact); else from the DOM range as before.
    const rect = this._ocrMatchRect(m) || range.getBoundingClientRect();
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
    hl.style.transform = 'none';                   // clear any rotation left by a previous rotated match
    hl.style.left = (rect.left - wr.left - 2) + 'px';
    hl.style.top = (rect.top - wr.top - 1) + 'px';
    hl.style.width = (rect.width + 4) + 'px';
    hl.style.height = (rect.height + 2) + 'px';
    if (scroll) hl.scrollIntoView({ block: 'center' });
    // Sync the results list (active card) and the docked toolbar to the new current match.
    (f.cards || []).forEach((c, ci) => c.classList.toggle('active', ci === i));
    if (scroll && f.cards && f.cards[i]) f.cards[i].scrollIntoView({ block: 'nearest' });
    this._findToolbarOn(m);
  },

  /** Focus the current match's box and select the matched range — the text toolbar shows via the
   *  focus handler (docked in the panel for the current match) and reflects the selection, ready
   *  for a style override before replacing. */
  findSelectCurrent() {
    const m = this._find.matches[this._find.idx];
    if (!m) return false;
    // The rescan cadence (while a big index builds) swaps in fresh match objects and can leave m.el
    // pointing at a DETACHED box — re-resolve the current live box for this match's line so the
    // selection (and the style that follows) lands on the LIVE node. Without this a docked Bold/colour
    // during the "scanning…" window read no selection and fell through to the WHOLE line.
    if ((!m.el || !m.el.isConnected) && m.line && !m.addEdit) { const el = this._findResolveEl(m); if (el) m.el = el; }
    if (!m.el || !m.el.isConnected) return false;
    m.el.focus();
    const r = this._matchRange(m);
    if (!r) return false;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    // Point the docked toolbar at THIS live box so the partial-style capture reads the right element
    // (a stale _ttTarget.el from before the rescan would make the style miss the selection).
    this._ttTarget = { kind: 'line', el: m.el, line: m.el.__line || m.line };
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

  /** Replace ADDED-TEXT matches (the Add tool's inserts) as data — no contentEditable box. Each
   *  match carries its edit (m.addEdit) and offsets into that edit's newText; apply them right-to-
   *  left so earlier offsets stay valid, then the overlay re-renders from the updated edit. The
   *  edit's rotation and whole-box style (bold/italic/colour/font) are untouched, so a rotated or
   *  styled insert keeps its look. Per-run partial styling (edit.runs, only when the user styled
   *  PART of an insert) is collapsed to the whole-box style in a changed insert — the text stays
   *  correct. An insert replaced down to empty is removed. Returns {n, pages}. */
  _replaceAddedTextMatches(matches, rep) {
    const byEdit = new Map();
    for (const m of matches) {
      if (!m || !m.addEdit) continue;
      let a = byEdit.get(m.addEdit); if (!a) byEdit.set(m.addEdit, a = []); a.push(m);
    }
    let n = 0; const pages = new Set(); const remove = [];
    for (const [edit, list] of byEdit) {
      let text = edit.newText || '';
      list.sort((a, b) => b.start - a.start);   // right-to-left keeps earlier offsets valid
      for (const m of list) {
        const s = Math.max(0, Math.min(m.start, text.length));
        const e = Math.max(s, Math.min(m.end, text.length));
        text = text.slice(0, s) + rep + text.slice(e); n++;
      }
      // In-place mutation is safe for undo: snapshotEdits() shallow-copies each edit at commit, so
      // prior history snapshots keep their own newText/runs. Callers commit ONE snapshot afterwards.
      edit.newText = text;
      if (edit.runs) edit.runs = null;
      pages.add(edit.pageIndex);
      if (!text.trim()) remove.push(edit);      // replaced to nothing -> drop the insert
    }
    if (remove.length) {
      const drop = new Set(remove);
      this.edits = (this.edits || []).filter((x) => !drop.has(x));
      if (drop.has(this.selectedInsert)) this.selectedInsert = null;
    }
    return { n, pages };
  },
  /** Repaint the insert overlays on the given pages after an added-text replace. Only pages that are
   *  actually painted are touched (lazy docs redraw the rest from the tracked edit on scroll). */
  _reRenderInsertPages(pages) {
    for (const pi of (pages || [])) {
      const pv = (this.pageViews || [])[pi];
      if (!pv || !pv.wrapper) continue;
      if (this.lazyEditMode && !(pv._lePainted || pv._lePainting)) continue;
      this.refreshPageOverlays(pv);
    }
  },
  /** Replace ONLY the current added-text match (single Replace click on an insert). */
  async _findReplaceAddedCurrent(m) {
    if (!this._findBusyStart('replaceBtn')) return;
    await this._findNextPaint();
    const rep = document.getElementById('replaceInput')?.value ?? '';
    const after = { pageIndex: m.pageIndex, start: m.start };
    const { pages } = this._replaceAddedTextMatches([m], rep);
    this.commitHistory();                        // one undo step
    this._reRenderInsertPages(pages);
    this._findRescanAt(after);
  },

  /** Replace the current match with the Replace field's text (empty = delete the match). */
  async findReplaceCurrent() {
    const f = this._find;
    let m = f.matches[f.idx];
    if (!m) return;
    // Added-text insert: data replace (no editable box / execCommand path).
    if (m.addEdit) return this._findReplaceAddedCurrent(m);
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
    // boxes — rescan first so every match is live. (Guard el: added-text matches may carry none.)
    if (f.matches.some((m) => m.el && !m.el.isConnected)) {
      this.findRun(f.q, true);
      if (!f.matches.length) { this._findBusyEnd(); return; }
    }
    const rep = document.getElementById('replaceInput')?.value ?? '';
    // Added-text inserts (the Add tool) replace as DATA — no editable box / execCommand. Split them
    // out and fold them into the SAME undo batch as the box replacements below.
    const addedMatches = f.matches.filter((m) => m.addEdit);
    const byEl = new Map();
    f.matches.forEach((m) => { if (m.addEdit || !m.el) return; const a = byEl.get(m.el) || []; a.push(m); byEl.set(m.el, a); });
    let n = 0;
    let insertPages = null;
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
      // Added-text inserts: data replace inside the same undo batch (rotation/style preserved).
      if (addedMatches.length) {
        const r = this._replaceAddedTextMatches(addedMatches, rep);
        n += r.n; insertPages = r.pages;
      }
    } finally {
      this.endHistoryBatch();
    }
    if (insertPages) this._reRenderInsertPages(insertPages);
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
    const override = f.override && Object.keys(f.override).length ? f.override : null;
    // Group matches by their LINE (pure data identity — geometry, NOT a DOM box). Painting a box
    // per affected page is what OOM-killed the tab on a 700-page doc; we never touch the canvas.
    const byLine = new Map();
    for (const m of f.matches) {
      if (!m.line) continue;
      const key = m.pageIndex + ':' + Math.round(m.line.left) + ':' + Math.round(m.line.baseline);
      let g = byLine.get(key);
      if (!g) byLine.set(key, g = { line: m.line, pageIndex: m.pageIndex, list: [] });
      g.list.push(m);
    }
    // O(1) edit lookup/update by geometry key so tracking N line-edits is O(N), not O(N²)
    // (trackEdit's findIndex + findLineEdit are each O(edits) — quadratic at tens of thousands of
    // hits, which was timing the whole Replace All out).
    const s = this.scale || 1;
    const key = (pageIndex, xPt, basePt) => pageIndex + ':' + Math.round(xPt) + ':' + Math.round(basePt);
    const idxByKey = new Map();
    this.edits.forEach((e, i) => { if (e && e.baseline != null && e.x != null) idxByKey.set(key(e.pageIndex, e.x, e.baseline), i); });
    let n = 0;
    const repaint = new Set();
    const lineNewText = new Map();   // line object -> its replaced text, to PATCH the search cache
    let i = 0;
    for (const { line, pageIndex, list } of byLine.values()) {
      // DATA ONLY: build the replaced line text (+ styled runs for a sticky override) and update
      // this.edits directly. No canvas, no DOM box — the edit renders lazily when its page scrolls
      // into view (buildTextLayer reads the pending edit -> newText), and Save reads this.edits, so
      // the whole document updates with ~zero graphical memory.
      const k = key(pageIndex, line.left / s, line.baseline / s);
      const existIdx = idxByKey.get(k);
      const baseText = existIdx != null ? this.edits[existIdx].newText : (line.text || '');
      const edit = this._lazyLineReplaceEdit(line, list, rep, override, baseText);
      if (edit) {
        if (existIdx != null) this.edits[existIdx] = edit;
        else { this.edits.push(edit); idxByKey.set(k, this.edits.length - 1); }
        lineNewText.set(line, edit.newText);
        n += list.length;
      }
      const pv = this.pageViews[pageIndex];
      if (pv && (pv._lePainted || pv._lePainting)) repaint.add(pageIndex);   // on screen now
      // Breathe every 50 lines: yield the main thread so a huge Replace All (thousands of hits
      // for "the"/"and") never blocks past a frame — the iPad's watchdog can't panic-kill us.
      if ((++i % 50) === 0) await new Promise((r) => setTimeout(r, 0));
    }
    // Added-text inserts (the Add tool — no line geometry, so skipped by the byLine grouping above)
    // replace as data too, inside the SAME single undo step. Rotation/whole-box style preserved.
    const addRes = this._replaceAddedTextMatches(f.matches.filter((m) => m.addEdit), rep);
    n += addRes.n;
    this.commitHistory();          // ONE undo step for the whole Replace All
    // PATCH the virtual-entries cache in place (updated line text only) instead of letting the
    // post-replace rescan re-group all N pages from scratch — that full regroup was a ~700 ms
    // main-thread freeze on a 466-page doc (and grows with page count). The cache's line objects
    // ARE the match lines, so a reference-keyed patch is exact; bump the signature so the rescan
    // accepts the patched cache. (m.el entries — eager path — carry no `line`, so they're skipped.)
    if (this._veCache && lineNewText.size) {
      for (const e of this._veCache) { const nt = lineNewText.get(e.line); if (nt != null) e.text = nt; }
      const items = this.extractedTextItems || [];
      this._veSig = items.length + ':' + ((this._extractedPages && this._extractedPages.size) || 0) + ':' + ((this.edits && this.edits.length) || 0);
    }
    // Repaint ONLY the pages already on screen so their boxes show the new text immediately; every
    // other page draws the replacement from the tracked edits when the user scrolls to it.
    if (repaint.size && this.refresh) await this.refresh({ only: repaint });
    this._reRenderInsertPages(addRes.pages);   // redraw any painted pages whose inserts changed
    this.hideTextToolbar();
    if (this.showStatus) this.showStatus(`Replaced ${n} match${n === 1 ? '' : 'es'}.`, 'success');
    // Finish WITHOUT a full-document re-scan when we can prove zero matches remain: every current
    // match was just replaced, so unless the REPLACEMENT text itself contains the query, nothing
    // can match anymore. Re-scanning all N lines only to confirm "No matches" was a ~700 ms freeze
    // on a 466-page doc. If the replacement can re-match (e.g. seo→myseo), fall back to the rescan.
    const q = (this._find.q || '').trim();
    const repCanMatch = q && rep && rep.toLowerCase().includes(q.toLowerCase());
    if (!repCanMatch) {
      f.matches = []; f.idx = -1; f.cards = [];
      f.hl?.remove(); f.hl = null;
      this._findToolbarOff();
      const res = document.getElementById('findResults'); if (res) res.textContent = '';
      ['findPrevBtn', 'findNextBtn', 'replaceBtn', 'replaceAllBtn'].forEach((id) => { const b = document.getElementById(id); if (b) b.disabled = true; });
      this._findCount(); this._findSummary();
      this._findBusyEnd();
    } else {
      this._findRescanAt(null);
    }
  },

  /** Build ONE line's replace edit as pure data: apply every match (right-to-left so offsets stay
   *  valid), then, when a sticky style override is active, split the new text into runs so the
   *  replacements carry that style. Returns a lineToEdit result ready for trackEdit — no DOM. */
  _lazyLineReplaceEdit(line, matches, rep, override, baseText) {
    let text = baseText != null ? baseText : (line.text || '');
    const spans = [];
    for (const m of matches.slice().sort((a, b) => b.start - a.start)) {
      const s = Math.max(0, Math.min(m.start, text.length));
      const e = Math.max(s, Math.min(m.end, text.length));
      text = text.slice(0, s) + rep + text.slice(e);
      spans.push([s, s + rep.length]);           // replacement span in the FINAL text (right-to-left keeps these valid)
    }
    spans.sort((a, b) => a[0] - b[0]);
    let runs = null;
    if (override && rep.length) {
      const styled = () => {
        const r = {};
        if (override.bold != null) r.bold = !!override.bold;
        if (override.italic != null) r.italic = !!override.italic;
        if (override.underline != null) r.underline = !!override.underline;
        if (override.color) r.color = override.color;
        if (override.family) r.family = override.family;
        return r;
      };
      runs = []; let cur = 0;
      for (const [s, e] of spans) {
        if (s > cur) runs.push({ text: text.slice(cur, s) });
        runs.push({ ...styled(), text: text.slice(s, e) });
        cur = e;
      }
      if (cur < text.length) runs.push({ text: text.slice(cur) });
      runs = runs.filter((r) => r.text);
    }
    const edit = this.lineToEdit(line, text, runs && runs.length > 1 ? runs : null);
    // Whole-line override (single run) → land it on the box-level style so it still applies on save.
    if (override && (!runs || runs.length <= 1)) {
      if (override.bold != null) edit.bold = !!override.bold;
      if (override.italic != null) edit.italic = !!override.italic;
      if (override.underline) edit.underline = true;
      if (override.color) edit.color = override.color;
      if (override.family) edit.fontFamily = override.family;
    }
    return edit;
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
