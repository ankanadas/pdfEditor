// Check tool — tap the page to place a ✓ / ✗ / ☑ / ● mark (e.g. to tick form boxes). Each mark is
// rasterised to a crisp transparent PNG and placed as a kind:'image' edit — the SAME pipeline
// signatures/stamps use — so it ALWAYS renders in the saved PDF (no font dependency, unlike a typed
// ✓ which the standard fonts drop), and it's movable / resizable / deletable like any placed image.
// Assembled onto PDFEditorApp.prototype (mixin); this = the app instance. Works on touch (tap-place).
import { trimCanvas } from '../util/canvas.js';

const MARK_ORDER = ['check', 'cross', 'box', 'dot'];
const MARK_GLYPH = { check: '✓', cross: '✗', box: '☑', dot: '●' };
const MARK_NAME = { check: 'Checkmark', cross: 'Cross', box: 'Checked box', dot: 'Dot' };

export const CheckmarkMethods = {
  /** Wire the Check tool button + the mark picker. Called once from the constructor. */
  initCheckTool() {
    if (!this.activeMark) this.activeMark = 'check';
    document.getElementById('checkModeBtn')?.addEventListener('click', () => this.setMode('check'));
    document.querySelectorAll('#checkPicker .check-mark-opt').forEach((opt) => {
      opt.addEventListener('click', () => this.selectCheckMark(opt.dataset.mark));
    });
    this._reflectCheckMark();
  },

  /** Pick which mark the next tap places; also (re)enters Check mode so tapping works immediately. */
  selectCheckMark(kind) {
    if (!MARK_ORDER.includes(kind)) return;
    this.activeMark = kind;
    this._reflectCheckMark();
    if (this.mode !== 'check') this.setMode('check');
    this.showStatus(`${MARK_GLYPH[kind]} ${MARK_NAME[kind]} — tap a box on the page to place it`, 'info');
  },

  /** Highlight the selected mark button in the picker. */
  _reflectCheckMark() {
    document.querySelectorAll('#checkPicker .check-mark-opt').forEach((o) =>
      o.classList.toggle('active', o.dataset.mark === (this.activeMark || 'check')));
  },

  /**
   * Rasterise one mark to a crisp trimmed transparent PNG. Drawn as thick round strokes so it
   * stays sharp at any placed size. Near-black by default (a hand-inked tick).
   */
  renderMark(kind, color = '#1a1a1a') {
    const S = 160;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const x = c.getContext('2d');
    x.strokeStyle = color; x.fillStyle = color;
    x.lineCap = 'round'; x.lineJoin = 'round';
    // A checkmark path inside the [inset, S-inset] square.
    const tick = (inset, lw) => {
      const a = inset, w = S - 2 * inset;
      x.lineWidth = lw;
      x.beginPath();
      x.moveTo(a + w * 0.06, a + w * 0.55);
      x.lineTo(a + w * 0.40, a + w * 0.82);
      x.lineTo(a + w * 0.96, a + w * 0.14);
      x.stroke();
    };
    if (kind === 'check') {
      tick(S * 0.12, S * 0.15);
    } else if (kind === 'cross') {
      const m = S * 0.18; x.lineWidth = S * 0.15;
      x.beginPath();
      x.moveTo(m, m); x.lineTo(S - m, S - m);
      x.moveTo(S - m, m); x.lineTo(m, S - m);
      x.stroke();
    } else if (kind === 'box') {
      const p = S * 0.10, r = S * 0.16;
      x.lineWidth = S * 0.09;
      x.beginPath();
      x.moveTo(p + r, p);
      x.arcTo(S - p, p, S - p, S - p, r);
      x.arcTo(S - p, S - p, p, S - p, r);
      x.arcTo(p, S - p, p, p, r);
      x.arcTo(p, p, S - p, p, r);
      x.closePath();
      x.stroke();
      tick(S * 0.26, S * 0.11);           // tick nested inside the box
    } else if (kind === 'dot') {
      x.beginPath();
      x.arc(S / 2, S / 2, S * 0.30, 0, Math.PI * 2);
      x.fill();
    }
    return trimCanvas(c) || { dataUrl: c.toDataURL('image/png'), w: S, h: S };
  },

  /** Place the active mark as a small image edit centred on the tapped point (checkbox-sized;
   *  the user can drag/resize the overlay afterwards). Reuses the image-overlay + save pipeline. */
  placeMark(xPt, topPt, pv) {
    const kind = this.activeMark || 'check';
    const out = this.renderMark(kind);
    const ratio = (out.h || 1) / (out.w || 1);
    // Fit the mark within a ~18 pt box regardless of the trimmed aspect (a tick is wider than tall).
    // `mark` tags it so the overlay lets it shrink much smaller than a signature/stamp (tiny boxes).
    const maxPt = 18;
    let wPt, hPt;
    if (ratio >= 1) { hPt = maxPt; wPt = maxPt / ratio; }
    else { wPt = maxPt; hPt = maxPt * ratio; }
    const pageWpt = pv.canvas.width / this.scale;
    this.edits.push({
      pageIndex: pv.pageNum,
      redact: false,
      kind: 'image',
      mark: kind,
      dataUrl: out.dataUrl,
      x: Math.max(0, Math.min(xPt - wPt / 2, pageWpt - wPt)),
      top: Math.max(0, topPt - hPt / 2),
      width: wPt,
      height: hPt,
    });
    this.commitHistory();
    this.refresh();
    this.showStatus(`${MARK_GLYPH[kind]} placed — drag to move, resize with the corner, delete with ✕`, 'success');
  },
};
