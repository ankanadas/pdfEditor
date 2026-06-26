import { DesktopPlatform } from '../desktop/input.js';

/**
 * MobilePlatform — same interface as desktop. The app is already responsive via the
 * @media (max-width:767px) CSS block and the shared pointer handlers (which work for touch),
 * so mobile currently INHERITS desktop behavior. Each hook that needs a genuine touch UX is
 * marked MOBILE-TODO; until specified it safely mirrors desktop (no invented gestures).
 */
export class MobilePlatform extends DesktopPlatform {
  get name() { return 'mobile'; }

  // MOBILE-TODO (awaiting spec): touch long-press + drag page reorder. For now inherit the
  // desktop HTML5 drag-and-drop (bindPageReorder) — touch devices that support DnD still work.
  // bindPageReorder(thumb) { /* touch reorder */ }

  // MOBILE-TODO (awaiting spec): pinch-zoom + long-press on the page canvas.
  // bindPageInput(pv) { /* touch gestures */ }

  // MOBILE-TODO (awaiting spec): touch smoothing / palm rejection on the signature pad.
  // bindSignaturePad(canvas, handlers) { /* touch drawing */ }

  // MOBILE-TODO (awaiting spec): bottom-sheet toolbar / panel presentation (today CSS @media
  // already restyles the layout for ≤767px).
  // mountChrome() { /* bottom sheets */ }
}
