// Stamp tool — preset/custom chip selection, placement, and preset rasterisation.
// Assembled onto PDFEditorApp.prototype (mixin); verbatim from app.js (this = the app).
import { imageRatio } from '../util/image.js';
import { roundRectPath, trimCanvas } from '../util/canvas.js';

export const StampMethods = {
  /** Mark a stamp chip (preset or custom) as the selected stamp. */
  selectStampChip(chip, stamp) {
    this.activeStamp = stamp;
    document.querySelectorAll('.stamp-chip').forEach(c => c.classList.toggle('active', c === chip));
    const name = stamp.label || 'Custom';
    this.showStatus(`${name} stamp selected — click on the page to place it`, 'success');
  },

  /** Read an uploaded image, add it as a selectable thumbnail chip, and select it. */
  onCustomStampUpload(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';   // allow re-uploading the same file later
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result;
      const ratio = await imageRatio(dataUrl);
      const chips = document.getElementById('stampChips');
      if (!chips) return;

      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'stamp-chip custom';
      const img = document.createElement('img');
      img.src = dataUrl; img.alt = 'Custom stamp'; img.draggable = false;
      chip.appendChild(img);
      const del = document.createElement('span');
      del.className = 'stamp-chip-x'; del.textContent = '×'; del.title = 'Remove this stamp';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.activeStamp && this.activeStamp.dataUrl === dataUrl) this.activeStamp = null;
        chip.remove();
      });
      chip.appendChild(del);

      const stamp = { label: 'Custom', dataUrl, ratio };
      chip.addEventListener('click', () => this.selectStampChip(chip, stamp));
      chips.appendChild(chip);
      this.selectStampChip(chip, stamp);
    };
    reader.readAsDataURL(file);
  },

  /** Drop the currently-selected stamp (preset or uploaded) centred on the clicked point. */
  placeStamp(xPt, topPt, pv) {
    const s = this.activeStamp;
    let dataUrl, ratio;
    if (s.dataUrl) {                       // uploaded custom stamp — use the image as-is
      dataUrl = s.dataUrl;
      ratio = s.ratio || 0.4;
    } else {                               // preset stamp — rasterise it
      const out = this.renderStamp(s.label, s.color);
      dataUrl = out.dataUrl;
      ratio = out.h / out.w;
    }
    const pageWpt = pv.canvas.width / this.scale;
    const wPt = Math.min(150, pageWpt - 40);
    const hPt = wPt * ratio;

    this.edits.push({
      pageIndex: pv.pageNum,
      redact: false,
      kind: 'image',
      dataUrl,
      x: Math.max(0, Math.min(xPt - wPt / 2, pageWpt - wPt)),
      top: Math.max(0, topPt - hPt / 2),
      width: wPt,
      height: hPt,
    });
    this.commitHistory();
    this.refresh();
    this.showStatus(`${s.label || 'Custom'} stamp added — drag to reposition, resize with the corner`, 'success');
  },

  /**
   * Rasterise a preset stamp (double-ruled rounded box + bold uppercase label, slightly
   * tilted like a rubber stamp) to a trimmed transparent PNG, reusing the image-overlay
   * save pipeline used by signatures.
   */
  renderStamp(label, color) {
    const text = (label || '').toUpperCase();
    const fontPx = 56, padX = 26, padY = 14, outerLW = 5, innerLW = 2.5, radius = 12;
    const angle = -7 * Math.PI / 180;

    const meas = document.createElement('canvas').getContext('2d');
    meas.font = `800 ${fontPx}px Arial, "Helvetica Neue", sans-serif`;
    const boxW = Math.ceil(meas.measureText(text).width) + padX * 2;
    const boxH = fontPx + padY * 2;

    // Square canvas large enough to hold the tilted box plus stroke/margin.
    const size = Math.ceil(Math.hypot(boxW, boxH)) + 40;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const cx = c.getContext('2d');
    cx.translate(size / 2, size / 2);
    cx.rotate(angle);
    cx.strokeStyle = color;
    cx.fillStyle = color;
    roundRectPath(cx, -boxW / 2, -boxH / 2, boxW, boxH, radius);
    cx.lineWidth = outerLW; cx.stroke();
    roundRectPath(cx, -boxW / 2 + 6, -boxH / 2 + 6, boxW - 12, boxH - 12, Math.max(4, radius - 5));
    cx.lineWidth = innerLW; cx.stroke();
    cx.font = `800 ${fontPx}px Arial, "Helvetica Neue", sans-serif`;
    cx.textAlign = 'center'; cx.textBaseline = 'middle';
    cx.fillText(text, 0, 2);

    return trimCanvas(c) || { dataUrl: c.toDataURL('image/png'), w: size, h: size };
  },
};
