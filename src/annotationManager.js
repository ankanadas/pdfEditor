/**
 * AnnotationManager — Phase 3 Annotation Tool Suite
 *
 * Manages one Fabric.js interactive canvas layered over every PDF page.
 * Provides five sub-tools: freehand draw, shapes (line/rect/circle),
 * text highlight (snapping to PDF.js bounding boxes), freehand highlight,
 * and table insertion.
 *
 * Coordinate convention
 * ---------------------
 * All Fabric objects are stored in INTRINSIC canvas pixel coordinates
 * (i.e. the raw PDF.js render resolution, = PDF points × app.scale).
 *
 * The Fabric canvas backstore stays at intrinsic resolution.  On resize,
 * _syncScales() uses setDimensions({ cssOnly: true }) to CSS-shrink the
 * canvas elements to match the PDF canvas display size.  Fabric's
 * _getPointerImpl automatically applies cssScale = backstore / CSS-bounds,
 * so scenePoint is always in intrinsic pixels — no manual zoom needed.
 *
 * For save, intrinsic pixels → PDF points:
 *   pdfX = fabricX / app.scale
 *   pdfY = pageHeightPt - fabricY / app.scale
 *
 * where app.scale is the PDF.js render scale (typically 1.5).
 */

import {
  Canvas as FabricCanvas,
  PencilBrush,
  Rect,
  Ellipse,
  Line,
  Group,
  Path,
} from 'fabric';

export class AnnotationManager {
  /**
   * @param {object} app — reference to the PDFEditorApp instance (for scale, extractedTextItems, etc.)
   */
  constructor(app) {
    this.app = app;
    /** @type {Array<{pageIndex:number, fabricCanvas:fabric.Canvas, pv:object}>} */
    this.pages = [];
    this.activeTool = null;      // 'draw'|'line'|'rect'|'circle'|'highlight'|'freeHighlight'|'table'
    this.strokeColor = '#e53935'; // current pen/shape colour
    this.strokeWidth = 3;
    this.highlightColor = '#FFD600';
    this.highlightOpacity = 0.4;

    // Temporary shape being drawn (for mouse-drag shapes)
    this._shapeState = null;

    // Undo/redo history for the annotation layer ONLY (independent of the text-edit history).
    // Each entry is a snapshot: [{pageIndex, objects:[…fabric JSON…]}, …]. _histIdx points at the
    // current state. _restoring guards the object:* listeners while we re-load a snapshot.
    this._history = [];
    this._histIdx = -1;
    this._restoring = false;
    this.onHistoryChange = null;   // (canUndo, canRedo) => void — set by the app to toggle buttons
  }

  // Props beyond Fabric's defaults that must survive a toObject/loadFromJSON round-trip.
  static get HISTORY_PROPS() {
    return ['_annotationType', '_rows', '_cols', 'globalCompositeOperation', 'selectable', 'hasControls'];
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Create (or recreate) the Fabric canvas overlay for a page view.
   * Called from buildPages() after each .page-wrap is added to the DOM.
   */
  mountPage(pv) {
    // Remove any previous canvas for this page (e.g. re-load)
    this._unmountPage(pv.pageNum);

    const wrapper = pv.wrapper;
    const w = pv.canvas.width;   // intrinsic canvas pixels
    const h = pv.canvas.height;

    // Container sits exactly over the PDF canvas (same top/left inside wrapper).
    // It is sized to the CSS display dimensions and keeps transform:none because
    // Fabric's own zoom handles the visual scaling of all objects.
    const container = document.createElement('div');
    container.className = 'fabric-layer-container';
    container.style.cssText =
      `position:absolute;top:0;left:0;width:${w}px;height:${h}px;` +
      `transform:none;z-index:200;pointer-events:none;`;
    wrapper.appendChild(container);

    // Fabric canvas element — starts at intrinsic size; _syncScales resizes it
    // to the CSS display size and sets the zoom factor accordingly.
    const canvasEl = document.createElement('canvas');
    canvasEl.width  = w;
    canvasEl.height = h;
    container.appendChild(canvasEl);

    const fc = new FabricCanvas(canvasEl, {
      selection: true,
      isDrawingMode: false,
      enableRetinaScaling: false,
      renderOnAddRemove: true,
    });

    // Prevent accidental stage-pan when the mouse wheel fires over the layer.
    fc.on('mouse:wheel', (opt) => opt.e.stopPropagation());
    // Record an undo step when an existing object is moved/resized (creation is committed by each tool).
    fc.on('object:modified', () => this._commit());

    const entry = { pageIndex: pv.pageNum, fabricCanvas: fc, pv, container };
    this.pages.push(entry);

    // Apply the current tool to this newly-mounted page
    if (this.activeTool) this._applyToolToPage(entry);

    // _syncScales fires immediately after first browser layout (clientWidth > 0)
    // and again on every subsequent viewport resize.
    const obs = new ResizeObserver(() => this._syncScales());
    obs.observe(pv.canvas);
    entry._resizeObs = obs;
  }

  /** Destroy & remove the Fabric canvas for one page (by pageIndex). */
  _unmountPage(pageIndex) {
    const i = this.pages.findIndex(p => p.pageIndex === pageIndex);
    if (i === -1) return;
    const { fabricCanvas, container, _resizeObs } = this.pages[i];
    try { if (_resizeObs) _resizeObs.disconnect(); } catch (_) {}
    try { fabricCanvas.dispose(); } catch (_) {}
    container.remove();
    this.pages.splice(i, 1);
  }

  /** Destroy all Fabric canvases (called when a new PDF is loaded). */
  unmountAll() {
    if (this._resizeObs) { this._resizeObs.disconnect(); this._resizeObs = null; }
    for (const { fabricCanvas, container, _resizeObs } of this.pages) {
      try { if (_resizeObs) _resizeObs.disconnect(); } catch (_) {}
      try { fabricCanvas.dispose(); } catch (_) {}
      container.remove();
    }
    this.pages = [];
    this._shapeState = null;
    this._history = [];
    this._histIdx = -1;
    this._fireHistory();
  }

  // ─── Undo / redo history (annotation layer only) ──────────────────────────────

  /** Capture the current annotation state across all pages. */
  _snapshot() {
    return this.pages.map(({ pageIndex, fabricCanvas }) => ({
      pageIndex,
      objects: fabricCanvas.toObject(AnnotationManager.HISTORY_PROPS).objects || [],
    }));
  }

  /** Push a new undo step after a committed mutation (add / move / delete). No-op while restoring. */
  _commit() {
    if (this._restoring) return;
    if (this._history.length === 0) {
      // Seed an empty baseline so the very first action can be undone back to "no annotations".
      this._history = [this.pages.map(({ pageIndex }) => ({ pageIndex, objects: [] }))];
      this._histIdx = 0;
    }
    this._history = this._history.slice(0, this._histIdx + 1);
    this._history.push(this._snapshot());
    if (this._history.length > 60) this._history.shift();   // cap memory
    this._histIdx = this._history.length - 1;
    this._fireHistory();
  }

  undo() { if (this._histIdx > 0) { this._histIdx--; this._restore(this._history[this._histIdx]); } }
  redo() { if (this._histIdx < this._history.length - 1) { this._histIdx++; this._restore(this._history[this._histIdx]); } }
  canUndo() { return this._histIdx > 0; }
  canRedo() { return this._histIdx >= 0 && this._histIdx < this._history.length - 1; }

  /** Re-load a snapshot onto every page's canvas (guarded so it doesn't record itself). */
  _restore(snap) {
    this._restoring = true;
    let pending = this.pages.length;
    const done = () => { if (--pending <= 0) { this._restoring = false; this._fireHistory(); } };
    if (!this.pages.length) { this._restoring = false; this._fireHistory(); return; }
    for (const { pageIndex, fabricCanvas } of this.pages) {
      const entry = (snap || []).find(s => s.pageIndex === pageIndex);
      const objects = entry ? entry.objects : [];
      fabricCanvas.discardActiveObject();
      Promise.resolve(fabricCanvas.loadFromJSON({ version: fabricCanvas.version, objects }))
        .then(() => {
          fabricCanvas.getObjects().forEach(o => { if (o.globalCompositeOperation === 'multiply') o._annotationType = o._annotationType || 'highlight'; });
          fabricCanvas.requestRenderAll();
          done();
        })
        .catch(done);
    }
  }

  _fireHistory() {
    if (typeof this.onHistoryChange === 'function') {
      this.onHistoryChange(this._histIdx > 0, this._histIdx >= 0 && this._histIdx < this._history.length - 1);
    }
  }

  /** Delete the selected object(s) on every page and record an undo step. */
  deleteSelected() {
    let removed = false;
    for (const { fabricCanvas } of this.pages) {
      const active = fabricCanvas.getActiveObjects();
      if (active.length) {
        active.forEach(o => fabricCanvas.remove(o));
        fabricCanvas.discardActiveObject();
        fabricCanvas.requestRenderAll();
        removed = true;
      }
    }
    if (removed) this._commit();
  }

  // ─── Tool Switching ───────────────────────────────────────────────────────────

  /**
   * Activate a sub-tool on all mounted pages.
   * @param {string} tool — one of: 'draw', 'line', 'rect', 'circle', 'highlight', 'freeHighlight', 'table'
   * @param {object} [opts] — { strokeColor, strokeWidth, highlightColor, highlightOpacity }
   */
  setTool(tool, opts = {}) {
    this.activeTool = tool;
    if (opts.strokeColor !== undefined) this.strokeColor = opts.strokeColor;
    if (opts.strokeWidth !== undefined) this.strokeWidth = opts.strokeWidth;
    if (opts.highlightColor !== undefined) this.highlightColor = opts.highlightColor;
    if (opts.highlightOpacity !== undefined) this.highlightOpacity = opts.highlightOpacity;

    for (const entry of this.pages) {
      this._applyToolToPage(entry);
    }
  }

  /** Enable / disable pointer-events on all Fabric layers (used when switching app modes). */
  setActive(active) {
    for (const { container } of this.pages) {
      container.style.pointerEvents = active ? 'all' : 'none';
    }
    if (!active) {
      // Leave drawing mode off and clear transient state
      for (const { fabricCanvas } of this.pages) {
        fabricCanvas.isDrawingMode = false;
        fabricCanvas.defaultCursor = 'default';
      }
    }
  }

  // ─── Per-page tool wiring ─────────────────────────────────────────────────────

  _applyToolToPage(entry) {
    const { fabricCanvas, pageIndex, pv } = entry;

    // Tear down previous tool listeners (keep object:modified — that's the history hook, not a tool).
    fabricCanvas.off('mouse:down');
    fabricCanvas.off('mouse:move');
    fabricCanvas.off('mouse:up');
    fabricCanvas.off('path:created');
    fabricCanvas.isDrawingMode = false;

    const tool = this.activeTool;

    if (tool === 'freeHighlight') {
      // Freehand highlighter (marker). The freehand DRAW tool was removed; this is the only brush tool.
      fabricCanvas.isDrawingMode = true;
      const brush = new PencilBrush(fabricCanvas);
      brush.color = this._hexToRgba(this.highlightColor, this.highlightOpacity);
      brush.width = Math.max(10, this.strokeWidth * 4);   // marker-width, scales with the thickness slider
      fabricCanvas.freeDrawingBrush = brush;
      // Tag + style the resulting path as a translucent highlight stroke.
      fabricCanvas.on('path:created', (e) => {
        e.path.set({ opacity: this.highlightOpacity, stroke: this.highlightColor, fill: null });
        e.path.globalCompositeOperation = 'multiply';
        e.path._annotationType = 'highlight';
        fabricCanvas.renderAll();
        this._commit();
      });

    } else if (tool === 'line' || tool === 'rect' || tool === 'circle') {
      fabricCanvas.defaultCursor = 'crosshair';
      fabricCanvas.selection = false;
      this._wireShapeDraw(entry);

    } else if (tool === 'highlight') {
      fabricCanvas.defaultCursor = 'text';
      fabricCanvas.selection = false;
      this._wireTextHighlight(entry);

    } else if (tool === 'table') {
      fabricCanvas.defaultCursor = 'cell';
      fabricCanvas.selection = false;
      this._wireTableInsert(entry);

    } else {
      // Selection / pointer mode (no tool active)
      fabricCanvas.selection = true;
      fabricCanvas.defaultCursor = 'default';
    }
  }

  // ─── Shape drawing (line, rect, circle) ──────────────────────────────────────

  _wireShapeDraw(entry) {
    const { fabricCanvas } = entry;
    let origin = null;
    let tempShape = null;

    fabricCanvas.on('mouse:down', (opt) => {
      // If the click landed on an existing object, let Fabric handle selection/move
      // and do NOT start drawing a new shape.
      if (opt.target) return;

      const p = opt.scenePoint ?? opt.absolutePointer;
      origin = { x: p.x, y: p.y };
      const color = this.strokeColor;
      const w = this.strokeWidth;

      if (this.activeTool === 'line') {
        tempShape = new Line([p.x, p.y, p.x, p.y], {
          stroke: color, strokeWidth: w, selectable: false, fill: '',
        });
      } else if (this.activeTool === 'rect') {
        tempShape = new Rect({
          left: p.x, top: p.y, width: 0, height: 0, originX: 'left', originY: 'top',
          stroke: color, strokeWidth: w, fill: 'transparent', selectable: false,
        });
      } else if (this.activeTool === 'circle') {
        tempShape = new Ellipse({
          left: p.x, top: p.y, rx: 0, ry: 0, originX: 'left', originY: 'top',
          stroke: color, strokeWidth: w, fill: 'transparent', selectable: false,
        });
      }
      if (tempShape) fabricCanvas.add(tempShape);
    });

    fabricCanvas.on('mouse:move', (opt) => {
      if (!origin || !tempShape) return;
      const p = opt.scenePoint ?? opt.absolutePointer;
      const dx = p.x - origin.x;
      const dy = p.y - origin.y;

      if (this.activeTool === 'line') {
        tempShape.set({ x2: p.x, y2: p.y });
      } else if (this.activeTool === 'rect') {
        tempShape.set({
          left: Math.min(origin.x, p.x),
          top: Math.min(origin.y, p.y),
          width: Math.abs(dx),
          height: Math.abs(dy),
        });
      } else if (this.activeTool === 'circle') {
        const rx = Math.abs(dx) / 2;
        const ry = Math.abs(dy) / 2;
        tempShape.set({
          left: Math.min(origin.x, p.x),
          top: Math.min(origin.y, p.y),
          rx, ry,
        });
      }
      fabricCanvas.renderAll();
    });

    fabricCanvas.on('mouse:up', () => {
      const finished = tempShape;
      if (finished) {
        finished.set({ selectable: true });
        fabricCanvas.setActiveObject(finished);
      }
      origin = null;
      tempShape = null;
      fabricCanvas.renderAll();
      // Discard a zero-size shape (a click with no drag); otherwise record an undo step.
      if (finished) {
        const w = finished.width || finished.rx * 2 || 0, h = finished.height || finished.ry * 2 || 0;
        const isLine = finished.type === 'line';
        if (!isLine && w < 2 && h < 2) { fabricCanvas.remove(finished); fabricCanvas.requestRenderAll(); }
        else this._commit();
      }
    });
  }

  // ─── Text highlight (snapping to PDF.js bounding boxes) ──────────────────────

  _wireTextHighlight(entry) {
    const { fabricCanvas, pageIndex, pv } = entry;

    fabricCanvas.on('mouse:down', (opt) => {
      if (opt.target) return;

      // scenePoint is in the Fabric scene plane.  Because we keep the
      // backstore at the intrinsic PDF canvas resolution and only CSS-
      // scale the element down, Fabric's cssScale factor inside
      // _getPointerImpl maps the mouse position back to intrinsic
      // pixels automatically.  No manual zoom or displayScale math
      // is needed — scenePoint already matches extractedTextItems.
      const canvasX = opt.scenePoint.x;
      const canvasY = opt.scenePoint.y;

      const items = this.app.extractedTextItems.filter(i => i.pageIndex === pageIndex);
      let hit = null;
      for (const item of items) {
        if (canvasX >= item.left && canvasX <= item.right &&
            canvasY >= item.top && canvasY <= item.bottom) {
          hit = item;
          break;
        }
      }
      if (!hit) return;

      const hl = new Rect({
        left: hit.left,
        top: hit.top,
        // Fabric v6+ defaults originX/originY to 'center'; left/top here are the word's
        // TOP-LEFT corner, so pin the origin or the highlight is drawn shifted up-left by
        // half its size (the "highlight in the wrong place" bug).
        originX: 'left',
        originY: 'top',
        width: hit.right - hit.left,
        height: hit.bottom - hit.top,
        // Translucency lives on the OBJECT's opacity (not the fill alpha) so it serializes to the saved
        // /Highlight annotation's opacity — otherwise the picked opacity is lost on save. The fill is the
        // solid colour; opacity tints it. (Mirrors the freehand highlighter, which sets path.opacity.)
        fill: this._hexToRgba(this.highlightColor, 1),
        opacity: this.highlightOpacity,
        stroke: 'transparent',
        selectable: true,
        hasControls: true,
        globalCompositeOperation: 'multiply',
      });
      hl._annotationType = 'highlight';
      fabricCanvas.add(hl);
      fabricCanvas.renderAll();
      this._commit();
    });
  }

  // ─── Table insertion ──────────────────────────────────────────────────────────

  _wireTableInsert(entry) {
    const { fabricCanvas } = entry;

    fabricCanvas.on('mouse:down', (opt) => {
      // If the click landed on an existing object (moving a table), skip
      if (opt.target) return;

      // Remove the one-shot listener immediately so the dialog only shows once per click
      fabricCanvas.off('mouse:down');

      const p = opt.scenePoint ?? opt.absolutePointer;
      this._promptTableSize((rows, cols) => {
        if (!rows || !cols) {
          // Re-wire for next click
          this._wireTableInsert(entry);
          return;
        }
        const cellW = 80, cellH = 28;
        const tableW = cellW * cols;
        const tableH = cellH * rows;
        const ox = p.x, oy = p.y;
        const objects = [];
        const lc = '#2d3a5c';
        const lw = 1.5;

        // Horizontal lines
        for (let r = 0; r <= rows; r++) {
          objects.push(new Line(
            [ox, oy + r * cellH, ox + tableW, oy + r * cellH],
            { stroke: lc, strokeWidth: lw, selectable: false }
          ));
        }
        // Vertical lines
        for (let c = 0; c <= cols; c++) {
          objects.push(new Line(
            [ox + c * cellW, oy, ox + c * cellW, oy + tableH],
            { stroke: lc, strokeWidth: lw, selectable: false }
          ));
        }

        const group = new Group(objects, { selectable: true });
        group._annotationType = 'table';
        group._rows = rows;
        group._cols = cols;
        fabricCanvas.add(group);
        fabricCanvas.renderAll();
        this._commit();

        // Re-wire for the next table click
        this._wireTableInsert(entry);
      });
    });
  }

  /** Show a small modal asking for rows × cols. Resolves via callback. */
  _promptTableSize(cb) {
    // Reuse or build a lightweight inline dialog
    let dlg = document.getElementById('ann-table-dlg');
    if (!dlg) {
      dlg = document.createElement('div');
      dlg.id = 'ann-table-dlg';
      dlg.innerHTML = `
        <div class="ann-dlg-box">
          <div class="ann-dlg-title">Insert Table</div>
          <div class="ann-dlg-row">
            <label>Rows<input id="ann-tbl-rows" type="number" min="1" max="30" value="3" class="ann-dlg-num"></label>
            <label>Cols<input id="ann-tbl-cols" type="number" min="1" max="20" value="3" class="ann-dlg-num"></label>
          </div>
          <div class="ann-dlg-actions">
            <button id="ann-tbl-cancel" class="ann-dlg-btn">Cancel</button>
            <button id="ann-tbl-ok" class="ann-dlg-btn ann-dlg-btn-primary">Insert</button>
          </div>
        </div>`;
      document.body.appendChild(dlg);
    }
    dlg.style.display = 'flex';
    const ok = () => {
      const r = parseInt(document.getElementById('ann-tbl-rows').value, 10) || 3;
      const c = parseInt(document.getElementById('ann-tbl-cols').value, 10) || 3;
      dlg.style.display = 'none';
      cleanup();
      cb(r, c);
    };
    const cancel = () => { dlg.style.display = 'none'; cleanup(); cb(0, 0); };
    const cleanup = () => {
      document.getElementById('ann-tbl-ok').removeEventListener('click', ok);
      document.getElementById('ann-tbl-cancel').removeEventListener('click', cancel);
    };
    document.getElementById('ann-tbl-ok').addEventListener('click', ok);
    document.getElementById('ann-tbl-cancel').addEventListener('click', cancel);
    document.getElementById('ann-tbl-rows').focus();
  }

  // ─── Serialization (for pdf-lib save pipeline) ────────────────────────────────

  /**
   * Return all annotations across all pages as an array of descriptors
   * ready to be consumed by the pdf-lib save path.
   *
   * Each descriptor shape:
   * ```
   * {
   *   kind:      'ann-path'|'ann-line'|'ann-rect'|'ann-ellipse'|'ann-highlight'|'ann-table',
   *   pageIndex: number,
   *   // coords in PDF points, bottom-left origin
   *   ...
   * }
   * ```
   */
  serialize() {
    const result = [];
    for (const entry of this.pages) {
      result.push(...this._serializePage(entry));
    }
    return result;
  }

  _serializePage(entry) {
    const { fabricCanvas, pageIndex, pv } = entry;
    const pageH = pv.page.view[3];          // page height in PDF points (for y-flip)
    // Fabric objects are stored in INTRINSIC canvas pixel coordinates.
    // The backstore is never resized (cssOnly:true), so obj.left/top
    // and getBoundingRect(true) return intrinsic pixel values directly.
    //
    // Intrinsic pixel → PDF point:
    //   pdfPt = intrinsicPx / app.scale
    //
    // (app.scale = PDF.js render scale, e.g. 1.5)
    const appScale = this.app.scale;
    const toPdfX   = (x) => x / appScale;
    const toPdfY   = (y) => pageH - y / appScale;   // flip to bottom-left origin
    const toPdfLen = (v) => v / appScale;
    // ds is kept for the ann-path descriptor so the path consumer can replicate
    // the coordinate mapping when it rebuilds the SVG path in PDF-point space.
    const ds = pv.canvas.width
      ? (pv.canvas.clientWidth || pv.canvas.width) / pv.canvas.width
      : 1;

    const result = [];

    for (const obj of fabricCanvas.getObjects()) {
      if (obj.type === 'path') {
        // Freehand highlighter stroke. Flatten the Fabric path (M/L/Q/C) to a polyline of PDF-point
        // vertices: take each command's on-curve point, transform by the object's matrix (minus its
        // pathOffset) into intrinsic scene px, then to PDF points. The backend draws this as a polyline
        // — faithful and far simpler/safer than re-parsing an SVG string + matrix on the server.
        const cmds = obj.path || [];
        if (!cmds.length) continue;
        const m = obj.calcTransformMatrix();
        const off = obj.pathOffset || { x: 0, y: 0 };
        const toScene = (lx, ly) => ({ x: m[0] * (lx - off.x) + m[2] * (ly - off.y) + m[4],
                                       y: m[1] * (lx - off.x) + m[3] * (ly - off.y) + m[5] });
        const qAt = (p0, cp, p1, t) => { const u = 1 - t; return { x: u * u * p0.x + 2 * u * t * cp.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * cp.y + t * t * p1.y }; };
        const pts = [];
        const push = (lx, ly) => { const p = toScene(lx, ly); pts.push([toPdfX(p.x), toPdfY(p.y)]); };
        let cur = null;
        for (const seg of cmds) {
          const c = seg[0];
          if (c === 'M' || c === 'L') { cur = { x: seg[1], y: seg[2] }; push(cur.x, cur.y); }
          else if (c === 'Q') { const cp = { x: seg[1], y: seg[2] }, end = { x: seg[3], y: seg[4] }, p0 = cur || end; const mid = qAt(p0, cp, end, 0.5); push(mid.x, mid.y); push(end.x, end.y); cur = end; }
          else if (c === 'C') { const end = { x: seg[5], y: seg[6] }; push(end.x, end.y); cur = end; }
        }
        if (pts.length < 2) continue;
        result.push({
          kind: 'ann-path',
          pageIndex,
          points: pts,                                   // [[x,y]…] PDF points, bottom-left origin
          stroke: obj.stroke,
          strokeWidth: toPdfLen((obj.strokeWidth || 2) * (obj.scaleX || 1)),
          opacity: obj.opacity ?? 1,
          isHighlight: !!(obj._annotationType === 'highlight' || obj.globalCompositeOperation === 'multiply'),
        });

      } else if (obj.type === 'line') {
        result.push({
          kind: 'ann-line',
          pageIndex,
          x1: toPdfX(obj.left + Math.min(obj.x1, obj.x2) + obj.strokeWidth),
          y1: toPdfY(obj.top + Math.min(obj.y1, obj.y2) + obj.strokeWidth),
          x2: toPdfX(obj.left + Math.max(obj.x1, obj.x2) + obj.strokeWidth),
          y2: toPdfY(obj.top + Math.max(obj.y1, obj.y2) + obj.strokeWidth),
          stroke: obj.stroke,
          strokeWidth: toPdfLen(obj.strokeWidth || 2),
        });

      } else if (obj.type === 'rect') {
        const bndg = obj.getBoundingRect(true);
        const isHl = obj._annotationType === 'highlight';
        result.push({
          kind: isHl ? 'ann-highlight' : 'ann-rect',
          pageIndex,
          x: toPdfX(bndg.left),
          y: toPdfY(bndg.top + bndg.height),
          width:  toPdfLen(bndg.width),
          height: toPdfLen(bndg.height),
          stroke: obj.stroke,
          strokeWidth: isHl ? 0 : toPdfLen(obj.strokeWidth || 2),
          fill: obj.fill,
          opacity: obj.opacity ?? 1,
        });

      } else if (obj.type === 'ellipse') {
        const bndg = obj.getBoundingRect(true);
        result.push({
          kind: 'ann-ellipse',
          pageIndex,
          x: toPdfX(bndg.left + bndg.width / 2),
          y: toPdfY(bndg.top + bndg.height / 2),
          rx: toPdfLen(bndg.width  / 2),
          ry: toPdfLen(bndg.height / 2),
          stroke: obj.stroke,
          strokeWidth: toPdfLen(obj.strokeWidth || 2),
        });

      } else if (obj.type === 'group' && obj._annotationType === 'table') {
        // Table: serialize the bounding rect + grid info for pdf-lib to draw lines
        const bndg = obj.getBoundingRect(true);
        result.push({
          kind: 'ann-table',
          pageIndex,
          x: toPdfX(bndg.left),
          y: toPdfY(bndg.top + bndg.height),
          width:  toPdfLen(bndg.width),
          height: toPdfLen(bndg.height),
          rows: obj._rows || 3,
          cols: obj._cols || 3,
          stroke: '#2d3a5c',
          strokeWidth: 1,
        });
      }
    }

    return result;
  }

  // ─── Utilities ────────────────────────────────────────────────────────────────

  /**
   * Synchronise every Fabric canvas to the current CSS display size of its
   * PDF page canvas.  Called by each page's ResizeObserver so it fires both
   * on first layout and on every subsequent viewport / DevTools resize.
   *
   * Strategy
   * --------
   * • The Fabric canvas backstore stays at INTRINSIC resolution (set once
   *   in mountPage).  All Fabric objects are stored in intrinsic pixels.
   * • We CSS-scale the Fabric <canvas> elements (and container) to the
   *   current CSS display size of the PDF canvas using cssOnly: true.
   *   Fabric's _getPointerImpl applies a cssScale factor =
   *   (backstore width / CSS bounding-rect width) to map the mouse
   *   position back to intrinsic pixels, so scenePoint is automatically
   *   in the same space as extractedTextItems.
   * • No setZoom is needed — there is no viewport transform.  Objects
   *   render 1:1 into the backstore and the browser downscales the
   *   canvas element via CSS, exactly like the PDF page canvas.
   */
  _syncScales() {
    for (const { fabricCanvas, pv, container } of this.pages) {
      const currentClientW = pv.canvas.clientWidth;
      const currentClientH = pv.canvas.clientHeight;
      if (!currentClientW || !currentClientH) continue;   // not laid out yet

      // Position the container precisely over the PDF canvas (handles centring
      // offsets inside the page-wrap).
      const offL = pv.canvas.offsetLeft || 0;
      const offT = pv.canvas.offsetTop  || 0;
      container.style.left      = `${offL}px`;
      container.style.top       = `${offT}px`;
      container.style.width     = `${currentClientW}px`;
      container.style.height    = `${currentClientH}px`;
      container.style.transform = 'none';

      // CSS-only resize: changes the CSS width/height of the lower canvas,
      // upper canvas, and Fabric's own wrapper div — but does NOT touch the
      // backstore resolution.  Fabric's pointer math divides by the
      // CSS→backstore ratio automatically.
      fabricCanvas.setDimensions(
        { width: currentClientW, height: currentClientH },
        { cssOnly: true }
      );
      fabricCanvas.calcOffset();       // re-measure element position
      fabricCanvas.requestRenderAll();
    }
  }

  /** '#rrggbb' + opacity → 'rgba(r,g,b,a)' */
  _hexToRgba(hex, alpha = 1) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
}
