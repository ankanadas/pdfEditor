// Insert editor — added text/image overlays: open editor, serialize, place, create/select overlays, wire drag/resize/rotate.
// Assembled onto PDFEditorApp.prototype (mixin); verbatim from app.js (this = the app).
import { hexToRgb, rgbCss, rgbToHex } from '../util/color.js';

export const InsertEditorMethods = {
  /**
   * Open an in-place multi-line text editor (a positioned contentEditable div) for an "Add text"
   * box. `isNew` = a fresh box from clicking the page (committed only if non-empty); otherwise it
   * re-edits an existing overlay (double-click). Enter inserts a new line; Esc cancels; clicking
   * away commits. A single box can mix font size, bold and italic per run: the top toolbar's size
   * box / B / I restyle the current selection, or — with a collapsed caret — set the style for text
   * typed next. Existing text is never changed. Runs are stored on edit.runs (lines ->
   * [{text,size,bold,italic}]); edit.newText/fontSize are kept in sync.
   */
  openInsertEditor(edit, pv, isNew) {
    // Already editing this box (e.g. a click + the dblclick both fired)? Keep the open editor.
    if (!isNew && this._activeInsertEditor && this.selectedInsert === edit && pv.wrapper.querySelector('.insert-editor')) return;
    const ds = (pv.canvas.clientWidth || pv.canvas.width) / pv.canvas.width;
    const unit = this.scale * ds;
    const baseFontPx = edit.fontSize * unit;
    const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // A run span carries size/bold/italic AND (optionally) underline / colour / link, so a partial
    // selection can be styled or hyperlinked. `applyRunStyle` writes both the data-* attr (for
    // serialisation) and the matching CSS (for the live editor) for any of these kinds.
    const applyRunStyle = (span, kind, value) => {
      if (kind === 'size') { span.setAttribute('data-sz', value); span.style.fontSize = (value * unit) + 'px'; }
      else if (kind === 'bold') { span.setAttribute('data-bold', value ? '1' : '0'); span.style.fontWeight = value ? 'bold' : 'normal'; }
      else if (kind === 'italic') { span.setAttribute('data-italic', value ? '1' : '0'); span.style.fontStyle = value ? 'italic' : 'normal'; }
      else if (kind === 'underline') { if (value) { span.setAttribute('data-underline', '1'); span.style.textDecoration = 'underline'; } else { span.removeAttribute('data-underline'); span.style.textDecoration = 'none'; } }
      else if (kind === 'color') { const hex = rgbToHex(value); span.setAttribute('data-color', hex); span.style.color = rgbCss(value); }
      else if (kind === 'family') { span.setAttribute('data-family', value); span.style.fontFamily = this._familyCss(value); }
      else if (kind === 'link') { if (value) { span.setAttribute('data-link', value); span.classList.add('tt-has-link'); } else { span.removeAttribute('data-link'); span.classList.remove('tt-has-link'); } }
    };
    const styledSpan = (st) => {
      const span = document.createElement('span');
      ['size', 'bold', 'italic'].forEach(k => applyRunStyle(span, k, st[k]));
      if (st.underline) applyRunStyle(span, 'underline', true);
      if (st.color) applyRunStyle(span, 'color', st.color);
      if (st.family) applyRunStyle(span, 'family', st.family);
      if (st.link) applyRunStyle(span, 'link', st.link);
      return span;
    };
    const spanHTML = (t, st) => { const sp = styledSpan(st); sp.textContent = t; return sp.outerHTML; };

    // This box is now the active one.
    this.selectedInsert = edit;
    this._insertSavedRange = null;

    // Hide the existing static overlay (if any) while its editor is open.
    const overlay = isNew ? null : this.insertOverlays.find(o => o.__edit === edit);
    if (overlay) overlay.style.display = 'none';

    const div = document.createElement('div');
    div.className = 'insert-editor';
    div.contentEditable = 'true';
    div.spellcheck = false;
    div.setAttribute('data-placeholder', 'Type here… (Enter for a new line)');
    div.style.left = (edit.x * unit) + 'px';
    div.style.top = (edit.baseline * unit - baseFontPx * 0.9) + 'px';
    // Base size for un-spanned (typed) text. Typed characters get wrapped in spans at the box default,
    // so this only affects the empty placeholder — which lets us floor it at 16px on mobile so Safari
    // can't focus-zoom an empty add-text box (the visible typed text keeps its real per-run size).
    const _mob = window.matchMedia && window.matchMedia('(max-width: 767px)').matches;
    div.style.fontSize = (_mob ? Math.max(16, baseFontPx) : baseFontPx) + 'px';
    div.style.fontWeight = edit.bold ? 'bold' : 'normal';
    div.style.fontStyle = edit.italic ? 'italic' : 'normal';
    div.style.fontFamily = this._familyCss(edit.fontFamily);   // preview in the chosen face (any catalogue font)
    const boxDefaults = { size: Math.round(edit.fontSize) || 12, bold: !!edit.bold, italic: !!edit.italic };
    // Seed content: from saved runs if present, else one span per line at the box defaults.
    if (edit.runs && edit.runs.length) {
      // Re-seed EVERY per-run style (not just size/bold/italic) so re-opening a committed box keeps the
      // partial underline / colour / font / link the user applied — the earlier code dropped all but B/I.
      div.innerHTML = edit.runs
        .map(line => line.map(r => spanHTML(r.text, { size: r.size, bold: !!r.bold, italic: !!r.italic, underline: !!r.underline, color: r.color || null, family: r.fontFamily || null, link: r.link || null })).join(''))
        .join('<br>');
    } else if (edit.newText) {
      div.innerHTML = String(edit.newText).split('\n')
        .map(line => spanHTML(line, boxDefaults)).join('<br>');
    }

    const maxW = pv.canvas.clientWidth - edit.x * unit - 4;
    const grow = () => {
      div.style.width = 'auto';
      div.style.height = 'auto';
      div.style.width = Math.min(div.scrollWidth + 6, Math.max(44, maxW)) + 'px';
      div.style.height = (div.scrollHeight + 4) + 'px';
    };

    // The style {size,bold,italic} at a range/caret: nearest ancestor that sets each attribute,
    // independently, falling back to the box defaults.
    const caretStyle = (range) => {
      let node = null, offset = 0;
      if (range) { node = range.endContainer; offset = range.endOffset; }
      else { const sel = window.getSelection(); if (sel && sel.rangeCount) { node = sel.focusNode; offset = sel.focusOffset; } }
      // If the position is at an element boundary (e.g. a whole-content selection ends on the
      // editor div), descend into the run just before the caret so we read its real style — not
      // the box default. Skip <br>.
      if (node && node.nodeType === Node.ELEMENT_NODE) {
        let child = node.childNodes[Math.max(0, offset - 1)] || node.childNodes[offset];
        while (child && child.nodeType === Node.ELEMENT_NODE && child.nodeName !== 'BR' && child.lastChild) {
          child = child.lastChild;
        }
        if (child) node = child;
      }
      if (node && node.nodeType === Node.TEXT_NODE) node = node.parentNode;
      const st = { ...boxDefaults };
      let fS = false, fB = false, fI = false, fU = false, fC = false, fL = false;
      while (node && node !== div && node.getAttribute) {
        if (!fS && node.hasAttribute('data-sz')) { st.size = Math.round(parseFloat(node.getAttribute('data-sz'))); fS = true; }
        if (!fB && node.hasAttribute('data-bold')) { st.bold = node.getAttribute('data-bold') === '1'; fB = true; }
        if (!fI && node.hasAttribute('data-italic')) { st.italic = node.getAttribute('data-italic') === '1'; fI = true; }
        if (!fU && node.hasAttribute('data-underline')) { st.underline = node.getAttribute('data-underline') === '1'; fU = true; }
        if (!fC && node.hasAttribute('data-color')) { st.color = hexToRgb(node.getAttribute('data-color')); fC = true; }
        if (!fL && node.hasAttribute('data-link')) { st.link = node.getAttribute('data-link'); fL = true; }
        node = node.parentNode;
      }
      return st;
    };

    // The range to act on: the live selection if it's inside this editor, else the last one we
    // saved before focus moved to the toolbar (so the toolbar controls still target the text).
    const workingRange = () => {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const r = sel.getRangeAt(0);
        if (div.contains(r.commonAncestorContainer)) return r;
      }
      const sv = this._insertSavedRange;
      return (sv && div.contains(sv.commonAncestorContainer)) ? sv : null;
    };
    const saveRange = () => {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const r = sel.getRangeAt(0);
        if (div.contains(r.commonAncestorContainer)) this._insertSavedRange = r.cloneRange();
      }
    };
    // Reflect bold/italic at the caret in the toolbar. The SIZE box is intentionally NOT synced
    // from the caret — it's a "pen size" that stays where the user set it (so it doesn't jump back
    // to a run's size when you click into the text). It's seeded once when the editor opens.
    const syncToolbar = () => {
      const st = caretStyle(workingRange());
      document.getElementById('addBold')?.classList.toggle('on', st.bold);
      document.getElementById('addItalic')?.classList.toggle('on', st.italic);
    };

    // A pending "pen" style: when size/B/I is changed with nothing selected, we don't touch any
    // existing text — instead the next characters typed get this style (see the beforeinput
    // handler). It survives the toolbar's number input stealing focus, which a caret-holder span
    // could not. Stays set until the user restyles a selection or the box is committed.
    let pendingStyle = null;

    // Apply one style property to the selection (restyle just that text, keeping the other two
    // properties), or — with a collapsed caret — arm it as the pen for text typed next. `kind` is
    // 'size' | 'bold' | 'italic'.
    const applyStyle = (kind, value) => {
      if (kind === 'size') { value = Math.max(4, Math.min(200, Math.round(value))); this._lastInsertSize = value; }
      let range = workingRange();
      const sel = window.getSelection();
      const liveInEditor = sel && sel.rangeCount && div.contains(sel.getRangeAt(0).commonAncestorContainer);
      const hasText = div.textContent.replace(/​/g, '').trim().length > 0;
      if ((!range || range.collapsed) && !hasText) {
        // EMPTY box, nothing selected: arm the pen for the next typed characters + set the box default.
        const base = pendingStyle || { ...boxDefaults };
        pendingStyle = { ...base }; pendingStyle[kind] = value;
        edit.fontSize = pendingStyle.size; edit.bold = pendingStyle.bold; edit.italic = pendingStyle.italic;
        div.style.fontSize = (pendingStyle.size * unit) + 'px';
        div.style.fontWeight = pendingStyle.bold ? 'bold' : 'normal';
        div.style.fontStyle = pendingStyle.italic ? 'italic' : 'normal';
        boxDefaults.size = pendingStyle.size; boxDefaults.bold = pendingStyle.bold; boxDefaults.italic = pendingStyle.italic;
        syncToolbar(); return;
      }
      if (!range || range.collapsed) {
        // Text present but nothing selected: apply to the WHOLE box — changing the size/B/I resizes/
        // restyles the text you just typed (the intuitive behaviour) and the box default so new text
        // matches too. (A specific selection still restyles only that run — see below.)
        const r = document.createRange(); r.selectNodeContents(div);
        if (liveInEditor) { sel.removeAllRanges(); sel.addRange(r); }
        range = r;
        boxDefaults[kind] = value;
        if (kind === 'size') edit.fontSize = value;
      }
      // A real selection: restyle just that text and drop the pen. Wrap it in a span carrying the new
      // style (size/bold/italic/underline/color/link) and propagate to any nested same-kind spans.
      pendingStyle = null;
      const attr = { size: 'data-sz', bold: 'data-bold', italic: 'data-italic', underline: 'data-underline', color: 'data-color', family: 'data-family', link: 'data-link' }[kind];
      const frag = range.extractContents();
      const span = document.createElement('span');
      applyRunStyle(span, kind, value);
      span.appendChild(frag);
      if (attr) span.querySelectorAll('[' + attr + ']').forEach(sp => applyRunStyle(sp, kind, value));
      range.insertNode(span);
      const r2 = document.createRange();
      r2.selectNodeContents(span);
      if (liveInEditor) { sel.removeAllRanges(); sel.addRange(r2); }
      this._insertSavedRange = r2.cloneRange();
      grow(); syncToolbar();
    };

    // Enter -> a <br> (keeps the model to text nodes + spans + <br>, so serialization is simple).
    // At the end of content we also drop a style-preserving caret holder so the new line continues
    // at the current style and is focusable.
    const insertLineBreak = () => {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (!div.contains(range.commonAncestorContainer)) return;
      const st = pendingStyle ? { ...pendingStyle } : caretStyle(range);
      range.deleteContents();
      const br = document.createElement('br');
      range.insertNode(br);
      range.setStartAfter(br); range.collapse(true);
      if (!br.nextSibling) {
        const span = styledSpan(st);
        span.appendChild(document.createTextNode('\u200b'));
        br.parentNode.appendChild(span);
        range.setStart(span.firstChild, 1); range.collapse(true);
      }
      sel.removeAllRanges(); sel.addRange(range);
    };

    // Expose the editor to the top toolbar (size box / B / I act on it while it's open) and reveal
    // the Add-text toolbar group regardless of the current tool.
    this._activeInsertEditor = { applyStyle, style: () => caretStyle(workingRange()),
      hasSelection: () => { const r = workingRange(); return !!(r && !r.collapsed); },
      // True when the selection covers the WHOLE box — then colour/underline/font apply box-level (the
      // intuitive "the whole text is red"), not per-run, so the overlay div itself carries the style.
      isWholeSelection: () => { const r = workingRange(); if (!r || r.collapsed) return false; const full = (div.textContent || '').replace(/​/g, ''); return r.toString().length >= full.length - 1; } };
    document.body.classList.add('editing-insert');

    pv.wrapper.appendChild(div);
    grow();
    // Mobile: lock the page scale BEFORE focusing the editor. Safari decides whether to auto-zoom at
    // focus time, so the viewport must already be locked — locking it afterwards (in _showTextToolbar)
    // was too late and the page still zoomed. hideTextToolbar restores pinch-zoom when editing ends.
    if (this._setViewportZoom) this._setViewportZoom(true);
    div.focus();
    if (!isNew) {
      // Re-opening: drop the caret at the very end of the text (inside the last run) so appended
      // text continues that run's style and the toolbar reflects it — not the box's largest size.
      let last = div.lastChild;
      while (last && last.nodeType !== Node.TEXT_NODE && last.lastChild) last = last.lastChild;
      const r = document.createRange();
      if (last && last.nodeType === Node.TEXT_NODE) r.setStart(last, last.nodeValue.length);
      else { r.selectNodeContents(div); r.collapse(false); }
      r.collapse(true);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    }
    saveRange();
    // Seed the (sticky) size box once: keep whatever size the user last set rather than reverting
    // to this box's largest run.
    const sizeEl0 = document.getElementById('addSize');
    if (sizeEl0) sizeEl0.value = this._lastInsertSize || boxDefaults.size;
    syncToolbar();

    // Reflect any box-level styling already on this edit (re-opening) onto the live editor, then
    // show the shared floating toolbar anchored to it.
    ['underline', 'color', 'opacity', 'align', 'family'].forEach(k => {
      const v = k === 'family' ? edit.fontFamily : edit[k];
      if (v != null && !(k === 'opacity' && v >= 1)) this._restyleEditorDiv(div, k, v);
    });
    this._showTextToolbar({ kind: 'editor', el: div, edit });

    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('touchstart', onTS, true);
      document.removeEventListener('touchmove', onTM, true);
      document.removeEventListener('touchend', onTE, true);
      document.body.classList.remove('editing-insert');
      if (this._ttTarget && this._ttTarget.kind === 'editor') this.hideTextToolbar();
      this._activeInsertEditor = null;
      this._insertSavedRange = null;
      const result = commit ? this.serializeEditor(div, boxDefaults) : null;
      div.remove();
      let changed = false;
      if (commit) {
        if (result.text.trim()) {
          edit.newText = result.text;
          edit.runs = result.runs;
          edit.fontSize = result.maxSize;          // representative size (geometry + default)
          if (isNew) this.edits.push(edit);
          changed = true;
        } else if (!isNew) {
          this.edits = this.edits.filter(x => x !== edit);   // emptied existing -> delete
          this.selectedInsert = null;
          changed = true;
        } else {
          this.selectedInsert = null;                        // isNew && empty -> discard
        }
      } else if (isNew) {
        this.selectedInsert = null;                          // cancelled a brand-new box
      }
      if (changed) this.commitHistory();
      this.renderCurrentPage();
      // If this commit was triggered by clicking an existing-text line (switching Add -> Edit), the
      // re-render above detached the box the click landed on, so the browser never focused it. Re-focus
      // the line now at the click point and drop a collapsed caret (no selection bleed).
      if (this._refocusLineAt) {
        const pt = this._refocusLineAt; this._refocusLineAt = null;
        let tries = 0;
        const tryFocus = () => {
          const box = document.elementFromPoint(pt.x, pt.y);
          const lineBox = box && box.closest && box.closest('.editable-text-box');
          if (lineBox) { lineBox.focus(); const r = document.createRange(); r.selectNodeContents(lineBox); r.collapse(true); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); return; }
          if (++tries < 15) requestAnimationFrame(tryFocus);     // boxes may rebuild over a few frames
        };
        requestAnimationFrame(tryFocus);
      }
    };
    // Let the toolbar's Delete remove the whole Add-text box: cancel (don't commit) -> the editor +
    // its (uncommitted) text are discarded and the box disappears.
    if (this._activeInsertEditor) this._activeInsertEditor.cancel = () => finish(false);

    // Commit when the user mouses down anywhere that isn't this editor or the Add-text toolbar
    // (so adjusting size/B/I keeps the box open). Esc cancels.
    const onStyleControl = (tgt) => tgt.closest && tgt.closest('.ctx-text, #textToolbar, .tt-font-pop, .tt-color-pop, .tt-link-pop');
    const onDocDown = (e) => {
      if (done || div.contains(e.target)) return;
      // Don't commit when the click is on a styling control (Add bar, floating toolbar, or a picker sheet).
      if (onStyleControl(e.target)) return;
      // Remember if the commit is being driven by a click on an existing-text line, so finish() can
      // re-focus that line after the re-render (switching Add -> Edit in one click).
      const lineHit = e.target && e.target.closest && e.target.closest('.editable-text-box');
      this._refocusLineAt = lineHit ? { x: e.clientX, y: e.clientY } : null;
      // Record the EVENT's timestamp (not Date.now()) so the page-click guard is immune to how long
      // finish()/renderCurrentPage() takes — else a slow re-render pushes Date.now() past the window and
      // the SAME click that committed also chain-opens a fresh Add-text box.
      this._lastInsertCommitAt = e.timeStamp;
      finish(true);
    };
    // Also commit on an outside POINTERDOWN (mouse/pen) — an overlay's drag handler calls
    // preventDefault() on its pointerdown, which suppresses the compatibility mousedown, so clicking
    // ANOTHER text box (overlay) wouldn't otherwise close this editor and an empty box would linger.
    // Capture phase fires before the overlay's own pointerdown (whose stopPropagation can't reach us).
    // Touch is left to the tap handlers below so scroll-to-dismiss still works on mobile.
    const onDocPointerDown = (e) => { if (e.pointerType === 'touch') return; onDocDown(e); };
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('pointerdown', onDocPointerDown, true);
    // Mobile: also commit on a deliberate TAP outside — on iOS the keyboard-dismiss can eat the mousedown,
    // so one tap on blank space wouldn't close the box ("can't exit add mode"). Track touch to tell tap/scroll.
    const onTS = (e) => { const p = e.touches && e.touches[0]; this._etap = p ? { x: p.clientX, y: p.clientY, moved: false } : null; };
    const onTM = (e) => { const p = e.touches && e.touches[0]; if (this._etap && p && Math.abs(p.clientX - this._etap.x) + Math.abs(p.clientY - this._etap.y) > 12) this._etap.moved = true; };
    const onTE = (e) => {
      const ts = this._etap; this._etap = null;
      if (done || !ts || ts.moved || div.contains(e.target) || onStyleControl(e.target)) return;
      this._lastInsertCommitAt = e.timeStamp;
      finish(true);
    };
    document.addEventListener('touchstart', onTS, true);
    document.addEventListener('touchmove', onTM, true);
    document.addEventListener('touchend', onTE, true);

    // When a pen style is armed (size/B/I set with no selection), insert typed characters in a
    // span of that style so the new text — not the existing text — picks up the change. This is
    // what makes "set size, then type" work even though the toolbar input stole focus.
    div.addEventListener('beforeinput', (e) => {
      if (!pendingStyle || e.inputType !== 'insertText' || e.data == null) return;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const r = sel.getRangeAt(0);
      if (!div.contains(r.commonAncestorContainer)) return;
      e.preventDefault();
      r.deleteContents();
      const span = styledSpan(pendingStyle);
      span.textContent = e.data;
      r.insertNode(span);
      const r2 = document.createRange();
      r2.setStartAfter(span); r2.collapse(true);
      sel.removeAllRanges(); sel.addRange(r2);
      this._insertSavedRange = r2.cloneRange();
      grow();
    });
    div.addEventListener('input', () => { saveRange(); grow(); });
    div.addEventListener('keyup', () => { saveRange(); syncToolbar(); });
    div.addEventListener('mouseup', () => { saveRange(); syncToolbar(); });
    div.addEventListener('keydown', (e) => {
      e.stopPropagation();                 // don't trigger global shortcuts (undo/redo) while typing
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      else if (e.key === 'Enter') { e.preventDefault(); insertLineBreak(); grow(); }
    });
  },
  /**
   * Read a contentEditable "Add text" editor back into a runs model. Walks text nodes, styling
   * spans (data-sz / data-bold / data-italic, each inherited independently) and <br> line breaks,
   * cleaning stray zero-width / control chars. `defaults` = {size,bold,italic} for un-styled text.
   * Returns { runs: [[{text,size,bold,italic}], ...], text: "lines\njoined", maxSize }.
   */
  serializeEditor(root, defaults) {
    const base = { size: Math.round(defaults.size) || 12, bold: !!defaults.bold, italic: !!defaults.italic };
    const lines = [[]];
    const sameColor = (a, b) => (a == null && b == null) || (Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);
    const pushText = (t, st) => {
      if (!t) return;
      const line = lines[lines.length - 1];
      const last = line[line.length - 1];
      if (last && last.size === st.size && last.bold === st.bold && last.italic === st.italic
          && !!last.underline === !!st.underline && sameColor(last.color, st.color) && (last.link || '') === (st.link || '')
          && (last.fontFamily || '') === (st.family || '')) {
        last.text += t;
      } else {
        const r = { text: t, size: st.size, bold: st.bold, italic: st.italic };
        if (st.underline) r.underline = true;
        if (st.color) r.color = st.color;
        if (st.family) r.fontFamily = st.family;          // partial font change (per-run)
        if (st.link) r.link = st.link;
        line.push(r);
      }
    };
    const styleFrom = (child, inherited) => {
      const st = { ...inherited };
      if (child.getAttribute) {
        const sz = child.getAttribute('data-sz'); if (sz) st.size = Math.round(parseFloat(sz));
        const b = child.getAttribute('data-bold'); if (b !== null) st.bold = b === '1';
        const i = child.getAttribute('data-italic'); if (i !== null) st.italic = i === '1';
        if (child.hasAttribute('data-underline')) st.underline = child.getAttribute('data-underline') === '1';
        const c = child.getAttribute('data-color'); if (c) st.color = hexToRgb(c);
        const fam = child.getAttribute('data-family'); if (fam) st.family = fam;
        const lk = child.getAttribute('data-link'); if (lk !== null) st.link = lk;
      }
      return st;
    };
    const walk = (node, inherited) => {
      node.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          pushText(this.cleanEditableText(child.nodeValue), inherited);
        } else if (child.nodeName === 'BR') {
          lines.push([]);
        } else {
          const st = styleFrom(child, inherited);
          // A block-level wrapper (browsers sometimes inject <div>/<p>) starts a new visual line.
          const isBlock = child.nodeName === 'DIV' || child.nodeName === 'P';
          if (isBlock && (lines.length > 1 || lines[lines.length - 1].length)) lines.push([]);
          walk(child, st);
        }
      });
    };
    walk(root, base);
    let runs = lines.map(line => line.filter(r => r.text.length));
    while (runs.length && runs[0].length === 0) runs.shift();
    while (runs.length && runs[runs.length - 1].length === 0) runs.pop();
    const text = runs.map(line => line.map(r => r.text).join('')).join('\n');
    let maxSize = base.size;
    runs.forEach(line => line.forEach(r => { if (r.size > maxSize) maxSize = r.size; }));
    return { runs, text, maxSize };
  },
  /**
   * Queue an inserted item (added text or a typed signature) at a click point. The click
   * is treated as the top-left of the text, so the baseline sits ~one ascent below it.
   * It is drawn as a preview now and inserted for real by the backend on Save.
   */
  placeInsert(xPt, topPt, text, fontSize, style, opts = {}, pageNum = this.currentPage) {
    this.edits.push({
      pageIndex: pageNum,
      redact: false,            // nothing to remove — this is an insert, not a replace
      style: style,             // 'text' or 'signature'
      x: xPt,
      baseline: topPt + fontSize * 0.8,
      fontSize: fontSize,
      newText: text,
      fontFamily: opts.fontFamily || 'sans',  // 'sans' | 'serif' | 'mono'
      bold: !!opts.bold,
      italic: !!opts.italic
    });
    this.commitHistory();
    this.renderCurrentPage();
  },
  clearInsertOverlays() {
    const container = document.getElementById('canvasContainer');
    if (container) container.querySelectorAll('.insert-overlay').forEach(el => el.remove());
    this.insertOverlays = [];
  },
  /** Move / proportional-resize / rotate / delete for a drawn-signature image overlay.
   *  Uses POINTER events (not mouse) so dragging works with a finger on touch screens, and marks
   *  the box .sig-active on touch so its handles show (they otherwise only appear on :hover). */
  wireImageOverlay(box, del, handle, rotate, edit, unit) {
    const commit = () => {
      edit.x = parseFloat(box.style.left) / unit;
      edit.top = parseFloat(box.style.top) / unit;
      edit.width = parseFloat(box.style.width) / unit;
      edit.height = parseFloat(box.style.height) / unit;
      this.commitHistory();
    };
    // Show this box's handles (and hide others') — needed on touch, which has no :hover.
    const activate = () => {
      this.insertOverlays.forEach(el => el.classList && el.classList.remove('sig-active'));
      box.classList.add('sig-active');
      this.selectedInsert = edit;
    };
    // A reusable pointer-drag: capture the pointer on `target`, run onMove(dx,dy,ev) until release.
    const drag = (target, e, onMove, onUp) => {
      e.preventDefault(); e.stopPropagation(); activate();
      try { target.setPointerCapture(e.pointerId); } catch (_) {}
      const sx = e.clientX, sy = e.clientY;
      const move = (ev) => onMove(ev.clientX - sx, ev.clientY - sy, ev);
      const up = (ev) => {
        target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', up);
        try { target.releasePointerCapture(e.pointerId); } catch (_) {}
        if (onUp) onUp(ev);
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up);
      target.addEventListener('pointercancel', up);
    };
    // Rotate: drag the top handle around the box centre. Shift snaps to 15°.
    rotate.addEventListener('pointerdown', (e) => {
      const r = box.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;  // centre is invariant under rotation
      drag(rotate, e,
        (dx, dy, ev) => {
          let deg = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI + 90;
          if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
          deg = Math.round(deg);
          edit.rotation = deg;
          box.style.transform = `rotate(${deg}deg)`;
        },
        () => { this.commitHistory(); this.showStatus(`Rotated to ${edit.rotation || 0}°`, 'success'); });
    });
    // Move the whole box.
    box.addEventListener('pointerdown', (e) => {
      if (e.target === del || e.target === handle || e.target === rotate) return;
      const ox = parseFloat(box.style.left), oy = parseFloat(box.style.top);
      drag(box, e,
        (dx, dy) => { box.style.left = (ox + dx) + 'px'; box.style.top = (oy + dy) + 'px'; },
        commit);
    });
    // Proportional resize from the corner handle.
    handle.addEventListener('pointerdown', (e) => {
      const w0 = parseFloat(box.style.width), h0 = parseFloat(box.style.height);
      const ar = h0 / w0;
      drag(handle, e,
        (dx) => { const w = Math.max(24, w0 + dx); box.style.width = w + 'px'; box.style.height = (w * ar) + 'px'; },
        commit);
    });
    // Delete — keep on tap/click (no preventDefault so the tap still produces a click); stop it
    // from starting a box drag.
    del.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
    del.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      this.edits = this.edits.filter(x => x !== edit);
      if (this.selectedInsert === edit) this.selectedInsert = null;
      if (this._ttTarget && this._ttTarget.edit === edit) this.hideTextToolbar();
      this.commitHistory();
      const pv = this.pageViews.find(p => p.pageNum === edit.pageIndex) || this.pageViews[this.currentPage];
      this.refreshPageOverlays(pv);   // overlay-only, single page (fast)
    });
  },
  /**
   * Render each pending insert (added text / signature) as a draggable, resizable overlay
   * so the user can move it into place and size it. Dragging updates the edit's position;
   * the resize handle changes its font size; the × button deletes it. All changes are
   * undoable and are written into the PDF (at the same spot) on Save.
   */
  createInsertOverlays(pv) {
    const wrap = pv.wrapper;
    if (!wrap) return;
    const ds = (pv.canvas.clientWidth || pv.canvas.width) / pv.canvas.width;
    const unit = this.scale * ds;  // PDF points -> displayed CSS px
    const inserts = this.edits.filter(e =>
      e.redact === false && e.pageIndex === pv.pageNum && (e.newText || e.kind === 'image'));

    inserts.forEach(edit => {
      // Drawn-signature image overlay
      if (edit.kind === 'image' && edit.dataUrl) {
        const box = document.createElement('div');
        box.className = 'insert-overlay insert-image';
        box.__edit = edit;                 // lets _overlayElFor find it (scroll-into-view / activation)
        if (edit === this.selectedInsert) box.classList.add('sig-active');
        box.style.left = (edit.x * unit) + 'px';
        box.style.top = (edit.top * unit) + 'px';
        box.style.width = (edit.width * unit) + 'px';
        box.style.height = (edit.height * unit) + 'px';
        box.style.transform = `rotate(${edit.rotation || 0}deg)`;
        const img = document.createElement('img');
        img.src = edit.dataUrl;
        img.draggable = false;
        box.appendChild(img);
        const delI = document.createElement('div');
        delI.className = 'insert-del';
        delI.textContent = '×';
        const handleI = document.createElement('div');
        handleI.className = 'insert-handle';
        const rotateI = document.createElement('div');
        rotateI.className = 'insert-rotate';
        rotateI.title = 'Drag to rotate (hold Shift to snap to 15°)';
        box.appendChild(delI);
        box.appendChild(handleI);
        box.appendChild(rotateI);
        this.wireImageOverlay(box, delI, handleI, rotateI, edit, unit);
        wrap.appendChild(box);
        this.insertOverlays.push(box);
        return;
      }

      const fontPx = edit.fontSize * unit;
      const ascent = fontPx * 0.8;

      const div = document.createElement('div');
      div.className = 'insert-overlay';
      div.__edit = edit;                 // lets openInsertEditor find/hide this overlay on re-edit
      if (edit === this.selectedInsert) div.classList.add('selected');
      // Editor-only "linked" affordance (not exported) for a whole-box link or any per-run link.
      if (edit.link || (edit.runs && edit.runs.some(ln => ln.some(r => r.link)))) div.classList.add('tt-has-link');
      // Added text may carry per-run size / bold / italic / underline / colour / link — render each run.
      if (edit.style !== 'signature' && edit.runs && edit.runs.length) {
        const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        div.innerHTML = edit.runs.map(line =>
          line.map(r => {
            const css = `font-size:${r.size * unit}px;font-weight:${r.bold ? 'bold' : 'normal'};font-style:${r.italic ? 'italic' : 'normal'}`
              + (r.underline || r.link ? ';text-decoration:underline' : '') + (r.color ? `;color:${rgbCss(r.color)}` : '')
              + (r.fontFamily ? `;font-family:${this._familyCss(r.fontFamily).replace(/"/g, "'")}` : '');   // single quotes: inside style="…"
            return `<span style="${css}">${esc(r.text)}</span>`;
          }).join('')
        ).join('<br>');
      } else {
        div.textContent = edit.newText;
      }
      div.style.left = (edit.x * unit) + 'px';
      div.style.fontSize = fontPx + 'px';
      if (edit.style === 'signature') {
        div.style.top = (edit.baseline * unit - ascent) + 'px';
        div.style.lineHeight = fontPx + 'px';
        div.style.fontStyle = 'italic';
        div.style.fontWeight = 'normal';
        div.style.fontFamily = '"Snell Roundhand","Apple Chancery","Brush Script MT",cursive';
      } else {
        // Added text: render multi-line (line breaks preserved) and double-click to re-edit.
        div.style.top = (edit.baseline * unit - fontPx * 0.9) + 'px';
        // Unitless line-height lets each line follow its own tallest run (mixed sizes).
        div.style.lineHeight = (edit.runs && edit.runs.length) ? '1.2' : (fontPx * 1.2) + 'px';
        div.style.whiteSpace = 'pre-wrap';
        div.style.fontWeight = edit.bold ? 'bold' : 'normal';
        div.style.fontStyle = edit.italic ? 'italic' : 'normal';
        div.style.fontFamily = this._familyCss(edit.fontFamily);
        // Whole-box styles set via the floating toolbar (color / underline / opacity / alignment)
        // must survive the commit + static re-render, exactly as the live editor showed them.
        if (edit.color != null) div.style.color = rgbCss(edit.color);
        if (edit.underline) div.style.textDecoration = 'underline';
        if (edit.opacity != null) div.style.opacity = edit.opacity;
        if (edit.align) div.style.textAlign = edit.align;
        div.title = 'Click to edit (select part to style/link it) · drag to move · rotate with the top handle';
        div.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); this.openInsertEditor(edit, pv, false); });
        // Rotation pivots on the text origin (left edge at the baseline) so the saved PDF matches.
        if (edit.rotation) {
          div.style.transformOrigin = '0px ' + (fontPx * 0.9) + 'px';
          div.style.transform = `rotate(${edit.rotation}deg)`;
        }
      }

      const del = document.createElement('div');
      del.className = 'insert-del';
      del.textContent = '×';
      const handle = document.createElement('div');
      handle.className = 'insert-handle';
      div.appendChild(del);
      div.appendChild(handle);
      // Added text can be rotated to any angle (signatures use the image overlay's own handle).
      let rotate = null;
      if (edit.style !== 'signature') {
        rotate = document.createElement('div');
        rotate.className = 'insert-rotate';
        rotate.title = 'Drag to rotate (hold Shift to snap to 15°)';
        div.appendChild(rotate);
      }

      this.wireInsertOverlay(div, del, handle, rotate, edit, unit, pv);
      wrap.appendChild(div);
      this.insertOverlays.push(div);
    });
  },
  /** Select an added-text box (shows the selected outline; double-click it to edit/resize). */
  selectInsert(edit) {
    this.selectedInsert = edit;
    this.insertOverlays.forEach(o => o.classList.toggle('selected', !!edit && o.__edit === edit));
    if (edit) this._showTextToolbar({ kind: 'overlay', el: this._overlayElFor(edit), edit });
    else if (this._ttTarget && this._ttTarget.kind === 'overlay') this.hideTextToolbar();
  },
  /** Attach move / resize / rotate / delete behaviour to one insert overlay. */
  wireInsertOverlay(div, del, handle, rotate, edit, unit, pv) {
    const commitFromDiv = () => {
      const fontPx = parseFloat(div.style.fontSize);
      const topOffset = edit.style === 'signature' ? fontPx * 0.8 : fontPx * 0.9;
      // With mixed run sizes, the representative size is the largest run.
      edit.fontSize = (edit.runs && edit.runs.length)
        ? Math.max(...edit.runs.flat().map(r => r.size))
        : fontPx / unit;
      edit.x = parseFloat(div.style.left) / unit;
      edit.baseline = (parseFloat(div.style.top) + topOffset) / unit;
      this.commitHistory();
    };

    // A reusable pointer-drag (mouse + touch + pen): capture the pointer so move/up keep firing when
    // the finger slides off a small handle, and so `touch-action:none` on the overlay stops the page
    // from scrolling instead of dragging. Mirrors wireImageOverlay so text + signatures behave the same.
    const drag = (target, e, onMove, onUp) => {
      e.preventDefault(); e.stopPropagation();
      try { target.setPointerCapture(e.pointerId); } catch (_) {}
      const sx = e.clientX, sy = e.clientY;
      const move = (ev) => onMove(ev.clientX - sx, ev.clientY - sy, ev);
      const up = (ev) => {
        target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', up);
        try { target.releasePointerCapture(e.pointerId); } catch (_) {}
        if (onUp) onUp(ev);
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up);
      target.addEventListener('pointercancel', up);
    };

    // Rotate: drag the top handle around the text origin (left edge at the baseline). That pivot
    // is fixed by the transform-origin, so it stays put under rotation. Shift snaps to 15°.
    if (rotate) {
      rotate.addEventListener('pointerdown', (e) => {
        const parent = div.parentElement;
        if (!parent) return;        // overlay was just re-rendered (e.g. committing an open editor)
        const wrapRect = parent.getBoundingClientRect();
        const fontPx = parseFloat(div.style.fontSize);
        const pivotX = wrapRect.left + parseFloat(div.style.left);
        const pivotY = wrapRect.top + parseFloat(div.style.top) + fontPx * 0.9;
        div.style.transformOrigin = '0px ' + (fontPx * 0.9) + 'px';
        // Rotate by the change in pointer angle since grab (1:1 drag, no jump). The handle sits
        // away from the origin pivot, so an absolute angle would start offset; a delta doesn't.
        const startRot = edit.rotation || 0;
        const startAngle = Math.atan2(e.clientY - pivotY, e.clientX - pivotX);
        drag(rotate, e,
          (dx, dy, ev) => {
            let deg = startRot + (Math.atan2(ev.clientY - pivotY, ev.clientX - pivotX) - startAngle) * 180 / Math.PI;
            if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
            deg = Math.round(deg);
            edit.rotation = deg;
            div.style.transform = `rotate(${deg}deg)`;
          },
          () => { this.commitHistory(); this.showStatus(`Rotated to ${edit.rotation || 0}°`, 'success'); });
      });
    }

    // Move (drag the body)
    div.addEventListener('pointerdown', (e) => {
      if (e.target === del || e.target === handle || e.target === rotate) return;
      const isText = edit.style !== 'signature';
      if (isText) this.selectInsert(edit);   // tapping/clicking a text box selects it (shows its handles)
      const ox = parseFloat(div.style.left), oy = parseFloat(div.style.top);
      let dragged = false;
      drag(div, e,
        (dx, dy) => {
          if (!dragged && Math.abs(dx) + Math.abs(dy) < 4) return;   // ignore jitter
          dragged = true;
          div.style.left = (ox + dx) + 'px';
          div.style.top = (oy + dy) + 'px';
        },
        // A drag moves the box; a plain tap/click on a TEXT box opens its editor so the user can place a
        // caret and select PART of the text to style or hyperlink (mirrors Canva/Figma text boxes).
        () => { if (dragged) commitFromDiv(); else if (isText && pv) this.openInsertEditor(edit, pv, false); });
    });

    // Resize (drag the corner handle = scale the font size). For a mixed-size box every run
    // scales by the same factor so their relative sizes are preserved.
    handle.addEventListener('pointerdown', (e) => {
      const startFont = parseFloat(div.style.fontSize);
      const hasRuns = !!(edit.runs && edit.runs.length);
      const spans = hasRuns ? Array.from(div.querySelectorAll('span')) : [];
      const spanStart = spans.map(s => parseFloat(s.style.fontSize) || startFont);
      let factor = 1;
      drag(handle, e,
        (dx, dy) => {
          const f = Math.max(8, startFont + dy);
          factor = f / startFont;
          div.style.fontSize = f + 'px';
          div.style.lineHeight = hasRuns ? '1.2' : f + 'px';
          spans.forEach((s, i) => { s.style.fontSize = (spanStart[i] * factor) + 'px'; });
        },
        () => {
          if (hasRuns && factor !== 1) {
            edit.runs = edit.runs.map(line =>
              line.map(r => ({ text: r.text, size: Math.max(4, Math.round(r.size * factor)), bold: !!r.bold, italic: !!r.italic })));
          }
          commitFromDiv();
        });
    });

    // Delete — keep on tap/click; stop it from starting a box drag.
    del.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
    del.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      this.edits = this.edits.filter(x => x !== edit);
      if (this.selectedInsert === edit) this.selectedInsert = null;
      if (this._ttTarget && this._ttTarget.edit === edit) this.hideTextToolbar();
      this.commitHistory();
      this.renderCurrentPage();
    });
  },
};
