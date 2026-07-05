// Move lines — drag-and-drop (and arrow-key nudge) repositioning of existing text lines.
// Assembled onto PDFEditorApp.prototype (mixin); this = the app instance.
//
// Interaction model (kept OUT of the contentEditable so caret editing is untouched):
//  - Every editable line gets a small grip (⠿ dots) just left of its box, shown while the box is
//    hovered/focused. DRAGGING the grip drags the line. CLICKING the grip (no movement) toggles
//    MOVE MODE: the box shows an accent border + `move` cursor, dragging anywhere on the box moves
//    it, and the keyboard nudges it — Arrow = 1px, Shift+Arrow = 10px. Escape / clicking elsewhere
//    exits. While in move mode the box is NOT text-focused, so arrows never fight the caret.
//  - Bounds: the box is clamped inside the page canvas — it can never be dragged off-page.
//  - Snap: while dragging, the box's left/top snap (4px) to its own ORIGINAL position and to other
//    boxes' left/top edges on the page, with purple guide lines. Hold Alt to bypass snapping.
//  - Commit: each completed gesture (drag end, or a burst of nudges going quiet) tracks ONE edit
//    carrying dx/dy in PDF points — one undo step (trackEdit -> commitHistory). The save engines
//    redact the line at its ORIGINAL rect and draw the new text at (x+dx, baseline+dy), so the
//    moved position lands physically in the output PDF (mupdf WASM and the pdf-lib fallback).
export const MoveLinesMethods = {
  /**
   * Wire move affordances for one editable line box. Called by buildTextLayer after the box is in
   * the DOM. Grip + guides are SIBLINGS of the box (never inside the contentEditable), cleaned up
   * with the text layer (`.qpe-move-grip, .qpe-snap-guide` in the layer-clear selectors).
   */
  _initLineMove(div, line, pv, displayScale) {
    const app = this;
    const wrapper = pv.wrapper;
    const grip = document.createElement('div');
    grip.className = 'qpe-move-grip';
    grip.title = 'Move line — drag, or click then use arrow keys (Shift = 10px)';
    wrapper.appendChild(grip);
    div.__qpeGrip = grip;

    const placeGrip = () => {
      grip.style.left = (parseFloat(div.style.left) - 14) + 'px';
      grip.style.top = div.style.top;
      grip.style.height = div.style.height;
    };
    placeGrip();

    const show = () => grip.classList.add('show');
    const hide = () => { if (!app._moveState || app._moveState.div !== div) grip.classList.remove('show'); };
    div.addEventListener('mouseenter', show);
    div.addEventListener('mouseleave', (e) => { if (e.relatedTarget !== grip) hide(); });
    div.addEventListener('focus', show);
    div.addEventListener('blur', () => setTimeout(hide, 120));
    grip.addEventListener('mouseenter', show);
    grip.addEventListener('mouseleave', (e) => { if (e.relatedTarget !== div) hide(); });

    // ---- shared drag machinery (used by grip-drag and by box-drag while in move mode) ----
    const beginDrag = (ev) => {
      ev.preventDefault();
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
        placeGrip();
        app._showSnapGuides(wrapper, snapX, snapY);
      };
      const onUp = () => {
        target.removeEventListener('pointermove', onMove);
        target.removeEventListener('pointerup', onUp);
        target.removeEventListener('pointercancel', onUp);
        app._clearSnapGuides(wrapper);
        if (moved) app._commitLineMove(div, line, pv, displayScale);
        else if (target === grip) app._toggleMoveMode(div, line, pv, displayScale);  // plain click on grip
      };
      target.addEventListener('pointermove', onMove);
      target.addEventListener('pointerup', onUp);
      target.addEventListener('pointercancel', onUp);
    };

    grip.addEventListener('pointerdown', (ev) => {
      // Grip drag always moves the line; a motionless press-release toggles move mode (onUp above).
      if (document.activeElement === div) div.blur();             // commit any in-progress text edit
      beginDrag(ev);
    });
    // In MOVE MODE the whole box is a drag handle and never takes the caret.
    div.addEventListener('pointerdown', (ev) => {
      if (app._moveState && app._moveState.div === div) beginDrag(ev);
    });
  },

  /** Enter/exit move mode for a box (accent border, move cursor, arrow-key nudging). */
  _toggleMoveMode(div, line, pv, displayScale) {
    if (this._moveState && this._moveState.div === div) { this._exitMoveMode(); return; }
    this._exitMoveMode();
    if (document.activeElement === div) div.blur();               // keyboard belongs to the move, not the caret
    div.classList.add('qpe-moving');
    if (div.__qpeGrip) div.__qpeGrip.classList.add('show');
    const onKey = (e) => this._onMoveKeydown(e);
    const onDocDown = (e) => {
      if (e.target === div || div.contains(e.target) || e.target === div.__qpeGrip) return;
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
    if (st.div.__qpeGrip) st.div.__qpeGrip.classList.remove('show');
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
    if (div.__qpeGrip) { div.__qpeGrip.style.left = (parseFloat(div.style.left) - 14) + 'px'; div.__qpeGrip.style.top = div.style.top; }
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
