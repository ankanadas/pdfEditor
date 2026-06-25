import { PlatformAdapter } from '../interface.js';

/**
 * DesktopPlatform — the current behavior, treated as the desktop implementation. Mouse + hover +
 * HTML5 drag-and-drop. The hooks delegate to the app's existing methods, so behavior is unchanged.
 */
export class DesktopPlatform extends PlatformAdapter {
  get name() { return 'desktop'; }

  /** HTML5 drag-and-drop page reorder (the app's existing wireThumbDnD). */
  bindPageReorder(thumb) { this.app.wireThumbDnD(thumb); }
}
