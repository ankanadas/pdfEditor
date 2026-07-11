// Move lines — drag-and-drop (and arrow-key nudge) repositioning of existing text lines.
// Assembled onto PDFEditorApp.prototype (mixin); this = the app instance.
//
// Interaction model (NO extra handle — the line itself is the affordance):
//  - Hovering an UNFOCUSED line shows the `move` cursor (the four-direction arrow). Press and
//    DRAG right away moves the line; a plain CLICK (press–release under 3px) enters normal text
//    editing with the caret placed at the click point. Once a line is FOCUSED (being edited),
//    the cursor is the text beam and dragging selects text exactly as before — to move it again,
//    click elsewhere first (blur), then hover-drag.
//  - After a drag the line stays in a MOVING state (accent border): arrow keys nudge 1px,
//    Shift+Arrow 10px, Escape or clicking anywhere exits; clicking the line itself exits into
//    editing (click = edit, always).
//  - Bounds: the box is clamped inside the page canvas — it can never be dragged off-page.
//  - Snap: while dragging, the box's left/top snap (4px) to its own ORIGINAL position and other
//    boxes' edges, with purple guide lines. Hold Alt to bypass snapping.
//  - Commit: each completed gesture (drag end, or a burst of nudges going quiet) tracks ONE edit
//    carrying dx/dy in PDF points — one undo step (trackEdit -> commitHistory). The save engines
//    redact the line at its ORIGINAL rect and draw the new text at (x+dx, baseline+dy), so the
//    moved position lands physically in the output PDF (mupdf WASM and the pdf-lib fallback).
//  - Touch pointers keep the native behaviour (tap = edit, swipe = scroll); moving is mouse-only.
export const MoveLinesMethods = {
  /**
   * Wire move behaviour for one editable line box. Called by buildTextLayer after the box is in
   * the DOM. Snap guides are SIBLINGS of the box (cleaned with the text layer via the
   * `.qpe-snap-guide` selector in the layer-clear calls).
   */
  _initLineMove(div, line, pv, displayScale) {
    const app = this;
    const wrapper = pv.wrapper;

    // ---- drag machinery (drag = move; motionless release = the click-to-edit fallback) ----
    const beginDrag = (ev) => {
      ev.preventDefault();                       // hold off focus/caret until the intent is known
      const startX = ev.clientX, startY = ev.clientY;
      const baseLeft = parseFloat(div.style.left) || 0;
      const baseTop = parseFloat(div.style.top) || 0;
      const rect = div.getBoundingClientRect();
      const w = rect.width, h = rect.height;
      const maxLeft = Math.max(0, (wrapper.clientWidth || pv.canvas.clientWidth) - w);
      const maxTop = Math.max(0, (wrapper.clientHeight || pv.canvas.clientHeight) - h);
      // Snap candidates: own original position + other boxes' left/top edges on this page.
      const candX = [parseFloat(div.dataset.qpeLeft0)];
      const candY = [parseFloat(div.dataset.qpeTop0)];
      wrapper.querySelectorAll('.editable-text-box').forEach((o) => {
        if (o === div) return;
        candX.push(parseFloat(o.style.left) || 0);
        candY.push(parseFloat(o.style.top) || 0);
      });
      let moved = false;
      const target = ev.currentTarget;
      try { target.setPointerCapture(ev.pointerId); } catch (_) {}

      const onMove = (e) => {
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;   // click vs drag threshold
        if (!moved) {
          // The drag is real: commit/close any OTHER line still being edited (its blur handler
          // tracks the edit and hides the toolbar) so the page never shows caret + move at once.
          const ae = document.activeElement;
          if (ae && ae !== div && ae.classList && ae.classList.contains('editable-text-box')) ae.blur();
        }
        moved = true;
        let nl = Math.min(maxLeft, Math.max(0, baseLeft + dx));
        let nt = Math.min(maxTop, Math.max(0, baseTop + dy));
        let snapX = null, snapY = null;
        if (!e.altKey) {                                          // Alt bypasses snapping
          for (const c of candX) { if (isFinite(c) && Math.abs(nl - c) <= 4) { nl = c; snapX = c; break; } }
          for (const c of candY) { if (isFinite(c) && Math.abs(nt - c) <= 4) { nt = c; snapY = c; break; } }
          nl = Math.min(maxLeft, Math.max(0, nl));
          nt = Math.min(maxTop, Math.max(0, nt));
        }
        div.style.left = nl + 'px';
        div.style.top = nt + 'px';
        app._showSnapGuides(wrapper, snapX, snapY);
      };
      const onUp = (e) => {
        target.removeEventListener('pointermove', onMove);
        target.removeEventListener('pointerup', onUp);
        target.removeEventListener('pointercancel', onUp);
        app._clearSnapGuides(wrapper);
        if (moved) {
          app._commitLineMove(div, line, pv, displayScale);
          // An OCR overlay line is transparent (the scan shows the glyphs); once MOVED it must re-render
          // so the scan's original glyphs get COVERED at the old spot and the relocated text is drawn
          // VISIBLY at the new spot (buildTextLayer handles both). Plain text lines keep the in-place
          // nudge flow untouched.
          if (line.ocr && app.refresh) { app._exitMoveMode(); app.refresh({ only: pv.pageNum }); }
          else app._enterMoveState(div, line, pv, displayScale);   // arrows nudge right after a drag
        } else {
          // Plain click: ALWAYS falls through to editing — focus the box and put the caret where
          // the user actually clicked (preventDefault above suppressed the native caret).
          app._exitMoveMode();
          app._focusLineAtPoint(div, e);
        }
      };
      target.addEventListener('pointermove', onMove);
      target.addEventListener('pointerup', onUp);
      target.addEventListener('pointercancel', onUp);
    };

    div.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || ev.pointerType !== 'mouse') return;  // touch keeps tap-to-edit + scroll
      const editing = document.activeElement === div;
      const inMove = app._moveState && app._moveState.div === div;
      if (editing && !inMove) return;             // focused box: native caret + text selection
      beginDrag(ev);
    });

    // One-time discovery tip the first time a line is focused.
    div.addEventListener('focus', () => {
      if (!app._moveTipShown && app.showStatus) {
        app._moveTipShown = true;
        app.showStatus('Tip: hover a line and drag to move it (the cursor becomes the move arrow); click to edit. After a drag, arrow keys nudge — Esc finishes.', 'info');
      }
    });
  },

  /** Focus the line and place the caret at the pointer position (the click-to-edit fallback). */
  _focusLineAtPoint(div, ev) {
    div.focus();
    try {
      const r = document.caretRangeFromPoint
        ? document.caretRangeFromPoint(ev.clientX, ev.clientY)
        : null;
      if (r && div.contains(r.startContainer)) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      }
    } catch (_) { /* focus alone is fine — the caret lands at the box start */ }
  },

  /** MOVING state after a drag: accent border + arrow-key nudging until Escape / click-away. */
  _enterMoveState(div, line, pv, displayScale) {
    if (this._moveState && this._moveState.div === div) return;
    this._exitMoveMode();
    div.classList.add('qpe-moving');
    const onKey = (e) => this._onMoveKeydown(e);
    const onDocDown = (e) => {
      if (e.target === div || div.contains(e.target)) return;     // clicks on the line handle edit
      this._exitMoveMode();
    };
    this._moveState = { div, line, pv, displayScale, onKey, onDocDown, nudgeTimer: null };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDocDown, true);
  },

  _exitMoveMode() {
    const st = this._moveState;
    if (!st) return;
    if (st.nudgeTimer) { clearTimeout(st.nudgeTimer); this._commitLineMove(st.div, st.line, st.pv, st.displayScale); }
    st.div.classList.remove('qpe-moving');
    document.removeEventListener('keydown', st.onKey, true);
    document.removeEventListener('pointerdown', st.onDocDown, true);
    this._clearSnapGuides(st.pv.wrapper);
    this._moveState = null;
  },

  /** Arrow = 1px, Shift+Arrow = 10px; Escape exits. A quiet burst commits as ONE history step. */
  _onMoveKeydown(e) {
    const st = this._moveState;
    if (!st) return;
    if (e.key === 'Escape') { e.preventDefault(); this._exitMoveMode(); return; }
    const step = e.shiftKey ? 10 : 1;
    let dx = 0, dy = 0;
    if (e.key === 'ArrowLeft') dx = -step;
    else if (e.key === 'ArrowRight') dx = step;
    else if (e.key === 'ArrowUp') dy = -step;
    else if (e.key === 'ArrowDown') dy = step;
    else return;
    e.preventDefault(); e.stopPropagation();
    const { div, pv } = st;
    const rect = div.getBoundingClientRect();
    const maxLeft = Math.max(0, (pv.wrapper.clientWidth || pv.canvas.clientWidth) - rect.width);
    const maxTop = Math.max(0, (pv.wrapper.clientHeight || pv.canvas.clientHeight) - rect.height);
    div.style.left = Math.min(maxLeft, Math.max(0, (parseFloat(div.style.left) || 0) + dx)) + 'px';
    div.style.top = Math.min(maxTop, Math.max(0, (parseFloat(div.style.top) || 0) + dy)) + 'px';
    if (st.nudgeTimer) clearTimeout(st.nudgeTimer);
    st.nudgeTimer = setTimeout(() => {
      st.nudgeTimer = null;
      this._commitLineMove(st.div, st.line, st.pv, st.displayScale);
    }, 500);
  },

  /**
   * Commit the box's current CSS position as a tracked edit: dx/dy in PDF points relative to the
   * line's ORIGINAL geometry (dataset.qpeLeft0/Top0, stamped by buildTextLayer before any pending
   * shift). Reuses the pending edit when one exists so text/style survive; one undo step.
   */
  _commitLineMove(div, line, pv, displayScale) {
    const k = (displayScale || 1) * (this.scale || 1);            // CSS px per PDF pt
    const left0 = parseFloat(div.dataset.qpeLeft0), top0 = parseFloat(div.dataset.qpeTop0);
    if (!isFinite(left0) || !isFinite(top0) || !k) return;
    const dxPt = ((parseFloat(div.style.left) || 0) - left0) / k;
    const dyPt = ((parseFloat(div.style.top) || 0) - top0) / k;
    const pending = this.findLineEdit(line);
    if (Math.abs(dxPt) < 0.05 && Math.abs(dyPt) < 0.05 && !pending) return;   // no-op gesture
    const base = pending
      ? { ...pending }
      : this.lineToEdit(line, this.cleanEditableText(div.textContent), this._readLineRuns(div));
    base.dx = Math.round(dxPt * 100) / 100;
    base.dy = Math.round(dyPt * 100) / 100;
    this.trackEdit(base);
  },

  // ---- snap guide overlays (position:absolute inside the page wrapper) ----
  _showSnapGuides(wrapper, snapX, snapY) {
    this._clearSnapGuides(wrapper);
    if (snapX != null) {
      const g = document.createElement('div');
      g.className = 'qpe-snap-guide';
      g.style.cssText = `left:${snapX}px;top:0;width:1px;height:100%;`;
      wrapper.appendChild(g);
    }
    if (snapY != null) {
      const g = document.createElement('div');
      g.className = 'qpe-snap-guide';
      g.style.cssText = `left:0;top:${snapY}px;width:100%;height:1px;`;
      wrapper.appendChild(g);
    }
  },
  _clearSnapGuides(wrapper) {
    (wrapper || document).querySelectorAll('.qpe-snap-guide').forEach((g) => g.remove());
  },
};
