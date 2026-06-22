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

    // Tear down previous mouse listeners
    fabricCanvas.off('mouse:down');
    fabricCanvas.off('mouse:move');
    fabricCanvas.off('mouse:up');
    fabricCanvas.isDrawingMode = false;

    const tool = this.activeTool;

    if (tool === 'draw') {
      fabricCanvas.isDrawingMode = true;
      const brush = new PencilBrush(fabricCanvas);
      brush.color = this.strokeColor;
      brush.width = this.strokeWidth;
      fabricCanvas.freeDrawingBrush = brush;

    } else if (tool === 'freeHighlight') {
      fabricCanvas.isDrawingMode = true;
      const brush = new PencilBrush(fabricCanvas);
      brush.color = this._hexToRgba(this.highlightColor, this.highlightOpacity);
      brush.width = 22;
      fabricCanvas.freeDrawingBrush = brush;
      // Make resulting path semi-transparent
      fabricCanvas.on('path:created', (e) => {
        e.path.set({ opacity: this.highlightOpacity, stroke: this.highlightColor });
        e.path.globalCompositeOperation = 'multiply';
        fabricCanvas.renderAll();
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
          left: p.x, top: p.y, width: 0, height: 0,
          stroke: color, strokeWidth: w, fill: 'transparent', selectable: false,
        });
      } else if (this.activeTool === 'circle') {
        tempShape = new Ellipse({
          left: p.x, top: p.y, rx: 0, ry: 0,
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
      if (tempShape) {
        tempShape.set({ selectable: true });
        fabricCanvas.setActiveObject(tempShape);
      }
      origin = null;
      tempShape = null;
      fabricCanvas.renderAll();
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
        width: hit.right - hit.left,
        height: hit.bottom - hit.top,
        fill: this._hexToRgba(this.highlightColor, this.highlightOpacity),
        stroke: 'transparent',
        selectable: true,
        hasControls: true,
        globalCompositeOperation: 'multiply',
      });
      hl._annotationType = 'highlight';
      fabricCanvas.add(hl);
      fabricCanvas.renderAll();
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
        // Freehand draw or freehand highlight — serialize as SVG path
        const path = obj.path ? obj.path.map(seg => seg.join(' ')).join(' ') : '';
        if (!path) continue;
        const m = obj.calcTransformMatrix();
        result.push({
          kind: 'ann-path',
          pageIndex,
          svgPath: path,
          matrix: m,
          stroke: obj.stroke,
          strokeWidth: toPdfLen(obj.strokeWidth || 2),
          opacity: obj.opacity ?? 1,
          isHighlight: !!(obj._annotationType === 'highlight' || obj.globalCompositeOperation === 'multiply'),
          pageH,
          // Pass the scale factors so the ann-path consumer can map SVG path
          // coordinates (which are in Fabric/display pixels) to PDF points.
          displayScale: ds,
          appScale,
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
