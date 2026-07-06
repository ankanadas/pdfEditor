// Watermark removal — strip a repeated background text phrase (e.g. "CONFIDENTIAL", "DRAFT COPY")
// from the OPEN document, fully client-side. NO OCR, NO canvas pixel parsing: a pure string/object
// pipeline that reuses the editor's existing edit → redaction engine.
//
// How removal actually works here (we do NOT hand-delete stream objects):
//   An EMPTY edit is a deletion. lineToEdit(line, '') keeps `redact` on, so on Save both engines
//   (mupdf WASM applyRedactions REDACT_TEXT_REMOVE, and the pdf-lib cover fallback) remove the
//   original glyphs and draw nothing — the phrase is GONE from the output's text stream. Same
//   primitive the Search "Replace All with empty" path uses (wmscramble proves it on saved bytes).
//
// Two entry points, both independent of / additive to existing behaviour (findReplace.js and
// moveLines.js are UNTOUCHED):
//   1. GLOBAL purge (purgeWatermarkPhrase): find every occurrence of a phrase across ALL pages via
//      the EXISTING search index — the async 50-page CHUNK loop (_findEnsureIndex) that keeps iPad
//      memory flat — then Replace-All-with-empty (lazy docs hydrate/evict page by page). Snapshots &
//      restores the Search panel's inputs so the user's own search is untouched.
//   2. MANUAL pick-to-delete (a GATED mode): while the Watermark tool's "pick" mode is on, a single
//      CLICK on a text block SELECTS it (highlight + trash) instead of editing; Delete or the trash
//      removes it. Mode OFF ⇒ click edits exactly as before — default behaviour is never changed. The
//      whole interception lives here (a capture-phase listener), so no other module is modified.
//
// WatermarkMethods mix onto PDFEditorApp.prototype; initWatermark() wires the tool button + panel.

export const WatermarkMethods = {
  /**
   * Delete ONE existing text line by tracking an EMPTY edit (redaction removes the original on Save;
   * nothing is drawn). Idempotent per line (trackEdit de-dups by page+x+baseline). `div` is the live
   * box to blank out for instant feedback. Returns true when an edit was tracked.
   */
  _deleteLine(div, line) {
    if (!line) return false;
    this.trackEdit(this.lineToEdit(line, '', null));   // '' == delete; redact stays on
    if (div) {
      div.textContent = '';
      div.dataset.originalText = '';
      div.style.display = 'none';                       // read as removed now; Save redacts for real
    }
    if (this.showStatus) this.showStatus('Block removed — Save to apply.', 'info');
    return true;
  },

  // ─── Manual pick-to-delete (gated mode — nothing here runs unless it's turned on) ──────────────
  /** Turn ON pick mode: a capture-phase pointerdown listener intercepts clicks on `.editable-text-box`
   *  and SELECTS them for deletion instead of letting the box focus/edit. Idempotent. */
  _wmEnterPickMode() {
    if (this._wmPick) return;
    const onDown = (e) => this._wmPickPointerDown(e);
    const onKey = (e) => this._wmPickKeydown(e);
    document.addEventListener('pointerdown', onDown, true);   // capture: beat the box's own handler
    document.addEventListener('keydown', onKey, true);
    document.body.classList.add('wm-picking');
    this._wmPick = { onDown, onKey, selected: null, banner: this._wmMakeBanner() };
    if (this.showStatus) this.showStatus('Pick mode: click a block to select it, then Delete (or 🗑). Esc when done.', 'info');
  },
  _wmExitPickMode() {
    const p = this._wmPick;
    if (!p) return;
    document.removeEventListener('pointerdown', p.onDown, true);
    document.removeEventListener('keydown', p.onKey, true);
    document.body.classList.remove('wm-picking');
    this._wmClearSelect();
    if (p.banner) { try { p.banner.remove(); } catch (_) {} }
    this._wmPick = null;
  },
  _wmPickActive() { return !!this._wmPick; },

  _wmMakeBanner() {
    const bar = document.createElement('div');
    bar.className = 'wm-pick-banner';
    const span = document.createElement('span');
    span.textContent = 'Watermark pick mode — click a block to select, then press Delete or 🗑. ';
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'wm-pick-done';
    done.textContent = 'Done';
    done.addEventListener('click', () => this._wmExitPickMode());
    bar.appendChild(span);
    bar.appendChild(done);
    document.body.appendChild(bar);
    return bar;
  },

  _wmPickPointerDown(e) {
    const t = e.target;
    if (t && t.closest && (t.closest('.wm-pick-banner') || t.closest('.wm-line-trash'))) return; // handled elsewhere
    const box = t && t.closest ? t.closest('.editable-text-box') : null;
    if (!box) { this._wmClearSelect(); return; }   // click on empty page: just deselect (stay in mode)
    e.preventDefault();    // suppress the native caret/focus (the box's own beginDrag relies on this too)
    e.stopPropagation();   // block the box's pointerdown → no edit / no drag
    this._wmSelectForDelete(box);
  },
  _wmPickKeydown(e) {
    if (!this._wmPick) return;
    if (e.key === 'Escape') { e.preventDefault(); this._wmExitPickMode(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this._wmPick.selected) {
      e.preventDefault();
      const { box, line } = this._wmPick.selected;
      this._wmClearSelect();
      this._deleteLine(box, line);
    }
  },

  _wmSelectForDelete(box) {
    this._wmClearSelect();
    const line = box.__line || null;
    const pv = this._wmPvForBox(box);
    box.classList.add('wm-selected');
    this._wmPick.selected = { box, line };
    if (pv) this._wmAttachTrash(box, line, pv);
  },
  _wmClearSelect() {
    if (this._wmPick && this._wmPick.selected) {
      try { this._wmPick.selected.box.classList.remove('wm-selected'); } catch (_) {}
      this._wmPick.selected = null;
    }
    this._wmRemoveTrash();
  },
  _wmPvForBox(box) {
    for (const pv of (this.pageViews || [])) {
      if (pv && pv.wrapper && pv.wrapper.contains(box)) return pv;
    }
    return null;
  },

  /** Floating trash button on the selected block (position:absolute inside the page wrapper). */
  _wmAttachTrash(box, line, pv) {
    this._wmRemoveTrash();
    if (!box || !pv || !pv.wrapper) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wm-line-trash';
    btn.title = 'Delete this block (Del)';
    btn.setAttribute('aria-label', 'Delete this block');
    btn.textContent = '🗑';
    btn.style.left = (parseFloat(box.style.left) || 0) + 'px';
    btn.style.top = Math.max(0, (parseFloat(box.style.top) || 0) - 24) + 'px';
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const b = box, l = line;
      this._wmClearSelect();
      this._deleteLine(b, l);
    });
    pv.wrapper.appendChild(btn);
    this._wmTrashBtn = btn;
  },
  _wmRemoveTrash() { if (this._wmTrashBtn) { try { this._wmTrashBtn.remove(); } catch (_) {} this._wmTrashBtn = null; } },

  // ─── Global phrase purge ───────────────────────────────────────────────────────────────────────
  /**
   * Find `phrase` on every page and replace with empty (== delete) via the existing search +
   * Replace-All engine. Marks edits only — the caller/user Saves to write the cleaned PDF (same model
   * as any edit). Returns { matches, pages }.
   *
   * @param {string} phrase
   * @param {{matchCase?:boolean}} [opts]
   */
  async purgeWatermarkPhrase(phrase, opts = {}) {
    const q = String(phrase || '').trim();
    if (!q) return { matches: 0, pages: 0 };
    const matchCase = !!opts.matchCase;

    const findEl = document.getElementById('findInput');
    const repEl = document.getElementById('replaceInput');
    const caseEl = document.getElementById('findCaseCb');
    const snap = { find: findEl && findEl.value, rep: repEl && repEl.value, cs: caseEl && caseEl.checked };
    try {
      if (caseEl) caseEl.checked = matchCase;
      if (repEl) repEl.value = '';                       // empty replacement == purge
      if (findEl) findEl.value = q;

      this.findRun(q, false);
      if (this.lazyEditMode) {                           // big doc: wait for the async 50-page index
        await this._wmWaitForIndex();
        this.findRun(q, true);
      }
      const f = this._find || { matches: [] };
      const total = (f.matches || []).length;
      const pages = new Set((f.matches || []).map((m) => m.pageIndex)).size;
      if (!total) return { matches: 0, pages: 0 };

      await this.findReplaceAll();                       // replace every match with empty, one undo step
      return { matches: total, pages };
    } finally {
      if (findEl && snap.find !== undefined) findEl.value = snap.find;
      if (repEl && snap.rep !== undefined) repEl.value = snap.rep;
      if (caseEl && snap.cs !== undefined) caseEl.checked = snap.cs;
      try { this.findRun(findEl ? findEl.value : '', false); } catch (_) {}   // clear the leftover highlight
    }
  },

  /** Await the lazy search index (the async 50-page CHUNK build in _findEnsureIndex). */
  async _wmWaitForIndex(maxMs = 180000) {
    const started = Date.now();
    if (this._findEnsureIndex) { try { this._findEnsureIndex(); } catch (_) {} }
    while (this.lazyEditMode && !this._lazyIndexDone) {
      if (Date.now() - started > maxMs) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  },
};

// ─── Tool button + side panel (self-contained, mirrors initSplit) ──────────────────────────────
let els = null;
let busy = false;
let progTimer = null;

export function initWatermark() {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup, { once: true });
  else setup();
}

function app() { return window.pdfEditorApp || null; }
function hasDoc() { return !!(app() && app().pdfJsDoc && document.body.classList.contains('has-pdf')); }

function setup() {
  els = {
    openBtn: document.getElementById('watermarkBtn'),
    backdrop: document.getElementById('wmBackdrop'),
    closeBtn: document.getElementById('wmClose'),
    cancelBtn: document.getElementById('wmCancel'),
    phrase: document.getElementById('wmPhrase'),
    caseCb: document.getElementById('wmCase'),
    go: document.getElementById('wmPurge'),
    manual: document.getElementById('wmManual'),
    status: document.getElementById('wmStatus'),
    progress: document.getElementById('wmProgress'),
    progressBar: document.getElementById('wmProgressBar'),
  };
  if (!els.backdrop || !els.openBtn) return;   // Watermark UI not on this page

  els.openBtn.addEventListener('click', openDrawer);
  els.closeBtn && els.closeBtn.addEventListener('click', closeDrawer);
  els.cancelBtn && els.cancelBtn.addEventListener('click', closeDrawer);
  els.backdrop.addEventListener('click', (e) => { if (e.target === els.backdrop) closeDrawer(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.backdrop.classList.contains('open')) closeDrawer();
  });
  els.go && els.go.addEventListener('click', doPurge);
  els.manual && els.manual.addEventListener('click', enterManual);
  els.phrase && els.phrase.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doPurge(); } });
  els.phrase && els.phrase.addEventListener('input', updateButtons);
}

function openDrawer() {
  if (!hasDoc()) return;
  const a = app();
  if (a && a._wmExitPickMode) a._wmExitPickMode();   // leave pick mode if it was on
  els.backdrop.classList.add('open');
  els.openBtn.classList.add('active');
  if (els.phrase) { els.phrase.value = ''; setTimeout(() => els.phrase.focus(), 30); }
  status('', '');
  hideProgress();
  updateButtons();
}
function closeDrawer() {
  els.backdrop.classList.remove('open');
  els.openBtn.classList.remove('active');
  stopProgressPoll();
}

// "Pick blocks manually": leave the panel and turn on click-to-select deletion on the page.
function enterManual() {
  const a = app();
  if (!a || !a._wmEnterPickMode) return;
  closeDrawer();
  a._wmEnterPickMode();
}

function updateButtons() {
  const ready = !busy && !!(els.phrase && els.phrase.value.trim()) && hasDoc();
  if (els.go) els.go.disabled = !ready;
  if (els.manual) els.manual.disabled = busy || !hasDoc();
}

async function doPurge() {
  const a = app();
  if (busy || !a) return;
  const phrase = (els.phrase && els.phrase.value.trim()) || '';
  if (!phrase) { status('Type the watermark phrase to remove.', 'err'); return; }
  const matchCase = !!(els.caseCb && els.caseCb.checked);
  setBusy(true);
  status(`Scanning every page for “${phrase}”…`, 'info');
  startProgressPoll();
  try {
    const { matches, pages } = await a.purgeWatermarkPhrase(phrase, { matchCase });
    stopProgressPoll();
    showProgress(100);
    if (!matches) {
      status(`No “${phrase}” found in this document.`, 'err');
    } else {
      status(`Removed ${matches} occurrence${matches === 1 ? '' : 's'} across ${pages} page${pages === 1 ? '' : 's'}. Click Save to download the cleaned PDF.`, 'ok');
    }
  } catch (e) {
    console.error('Watermark purge failed:', e);
    stopProgressPoll();
    status('Sorry, the purge failed. The document may be protected — Save it here first, then retry.', 'err');
  } finally {
    setBusy(false);
    setTimeout(() => { if (!busy) hideProgress(); }, 900);
  }
}

// Progress reflects the async index build: extracted-page count / total, so the bar advances as the
// 50-page chunk loop sweeps the document.
function startProgressPoll() {
  stopProgressPoll();
  showProgress(2);
  progTimer = setInterval(() => {
    const a = app();
    const total = (a && a.pdfJsDoc && a.pdfJsDoc.numPages) || 0;
    const done = (a && a._extractedPages && a._extractedPages.size) || 0;
    if (total) showProgress(Math.min(96, Math.round((done / total) * 96) + 2));
  }, 120);
}
function stopProgressPoll() { if (progTimer) { clearInterval(progTimer); progTimer = null; } }

function setBusy(on) { busy = on; updateButtons(); }
function showProgress(pct) {
  if (!els.progress) return;
  els.progress.hidden = false;
  els.progressBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}
function hideProgress() {
  if (!els.progress) return;
  els.progress.hidden = true;
  els.progressBar.style.width = '0%';
}
function status(text, kind) {
  if (!els.status) return;
  els.status.className = 'wm-status' + (kind ? ` ${kind}` : '');
  els.status.textContent = text || '';
}
