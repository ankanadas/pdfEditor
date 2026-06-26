/**
 * PlatformAdapter — the contract both platform/desktop/ and platform/mobile/ satisfy.
 *
 * Shared render/ and features/ code calls these hooks; it never reads the device type
 * directly. Exactly one adapter is built at boot (platform/detect.js → buildPlatform) and
 * injected onto the app as `this.platform`. The two implementations are interchangeable.
 *
 * Most of the app's responsiveness is already CSS-driven (the @media (max-width:767px) block),
 * so several hooks have a safe shared default here; only genuinely device-specific *interaction*
 * (e.g. HTML5 drag vs. touch reorder) is overridden per platform.
 */
export class PlatformAdapter {
  constructor(app) { this.app = app; }

  /** 'desktop' | 'mobile' */
  get name() { return 'base'; }

  /**
   * Attach drag-to-reorder interaction to a page thumbnail in the pages panel.
   * Desktop: HTML5 drag-and-drop. Mobile: touch long-press + drag (MOBILE-TODO).
   */
  bindPageReorder(thumb) { throw new Error('PlatformAdapter.bindPageReorder not implemented'); }

  /**
   * Attach pointer/gesture input (start/move/end + tap/select) to a page-view's canvas.
   * Default: no extra binding — buildPages() already wires the shared click/erase handlers,
   * which work for mouse and touch. Mobile may override to add pinch/long-press (MOBILE-TODO).
   */
  bindPageInput(pv) { /* shared default: handlers wired in buildPages() */ }

  /**
   * Attach signature-pad drawing input to the pad canvas.
   * Default: the pad's own pointer handlers (work for mouse + touch). Mobile may tune
   * touch smoothing / palm rejection (MOBILE-TODO).
   */
  bindSignaturePad(canvas, handlers) { /* shared default: pad wires its own pointer handlers */ }

  /**
   * Presentation entry point for toolbar + side panels. Default: CSS @media handles layout,
   * nothing to do. Mobile may mount bottom-sheets here (MOBILE-TODO).
   */
  mountChrome() { /* shared default: CSS-driven layout */ }
}
