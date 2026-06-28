import { DesktopPlatform } from '../desktop/input.js';
import { bindHandleReorder } from '../../util/touchReorder.js';

/**
 * MobilePlatform — same interface as desktop. The app is already responsive via the
 * @media (max-width:767px) CSS block and the shared pointer handlers (which work for touch),
 * so mobile currently INHERITS desktop behavior. Each hook that needs a genuine touch UX is
 * marked MOBILE-TODO; until specified it safely mirrors desktop (no invented gestures).
 */
export class MobilePlatform extends DesktopPlatform {
  get name() { return 'mobile'; }

  /**
   * Touch page reorder: HTML5 drag-and-drop doesn't fire for touch, so drag from the per-tile grip
   * handle via pointer events instead. movePage(from, insertBefore) is the same engine-agnostic
   * reorder the desktop DnD calls — only the gesture differs.
   */
  bindPageReorder(thumb) {
    thumb.draggable = false;                          // touch: don't let the browser start a native drag
    const grip = thumb.querySelector('.thumb-grip');
    const grid = document.getElementById('pagesGrid');
    if (!grip || !grid) return;
    bindHandleReorder(grip, {
      item: thumb, container: grid, itemSelector: '.page-thumb', axis: 'x',
      onDrop: (from, to, after) => {
        const f = Number(from.dataset.index), j = Number(to.dataset.index);
        if (Number.isNaN(f) || Number.isNaN(j)) return;
        this.app.movePage(f, after ? j + 1 : j);
      },
    });
  }

  // MOBILE-TODO (awaiting spec): pinch-zoom + long-press on the page canvas.
  // bindPageInput(pv) { /* touch gestures */ }

  // MOBILE-TODO (awaiting spec): touch smoothing / palm rejection on the signature pad.
  // bindSignaturePad(canvas, handlers) { /* touch drawing */ }

  // MOBILE-TODO (awaiting spec): bottom-sheet toolbar / panel presentation (today CSS @media
  // already restyles the layout for ≤767px).
  // mountChrome() { /* bottom sheets */ }
}
