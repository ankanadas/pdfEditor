// Single source of truth for the size/page limits that gate EDITING, and for the per-device
// processing cap. Used by the editor open path (fileIO), Merge, and the Rotate/Reorder pages tool.
//
// Two independent thresholds:
//  - EDIT limit (30 MB OR 500 pages): above this a document can still be VIEWED, MERGED and
//    ROTATED/REORDERED (all client-side), it just can't be edited (server-bound) or opened back
//    into the editor. Whichever of the two hits first applies.
//  - DEVICE cap (500 MB desktop / 150 MB mobile): above this we can't safely hold/process the
//    file in this browser at all. Keyed to the ACTUAL device (touch + UA, plus navigator.deviceMemory
//    as a low-RAM signal), NOT the viewport width — a narrow desktop window still gets the 500 MB cap.

export const EDIT_LIMIT_MB = 30;
export const EDIT_LIMIT_BYTES = EDIT_LIMIT_MB * 1024 * 1024;
export const EDIT_LIMIT_PAGES = 500;

const DESKTOP_CAP_MB = 500;
const MOBILE_CAP_MB = 150;

// A real phone/tablet — touch pointer AND a mobile user-agent (or iPadOS, which reports as a
// touch-capable Mac). Deliberately NOT a viewport-width check: shrinking a desktop window must
// not change the device cap.
export function isMobileDevice() {
  try {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    const touch = (typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 0) > 0) ||
      (typeof window !== 'undefined' && 'ontouchstart' in window);
    const uaMobile = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|BlackBerry|Opera Mini|IEMobile/i.test(ua);
    const iPadOS = /Macintosh/i.test(ua) && touch;   // iPadOS 13+ masquerades as desktop Safari
    return !!touch && (uaMobile || iPadOS);
  } catch (_) { return false; }
}

// Bytes ceiling for what this device can process at all (merge/rotate output, or a file to open).
export function deviceCapBytes() {
  let capMb = isMobileDevice() ? MOBILE_CAP_MB : DESKTOP_CAP_MB;
  const mem = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 0;  // GB, Chromium-only
  if (mem && mem <= 2) capMb = Math.min(capMb, MOBILE_CAP_MB);                     // very low-RAM machine
  return capMb * 1024 * 1024;
}
export function deviceCapMb() { return Math.round(deviceCapBytes() / (1024 * 1024)); }

// Editable == within BOTH the byte limit AND the page limit. pageCount may be omitted (byte-only check).
export function isEditableOutput(bytes, pageCount) {
  return bytes <= EDIT_LIMIT_BYTES && (pageCount == null || pageCount <= EDIT_LIMIT_PAGES);
}
export function overEditLimit(bytes, pageCount) { return !isEditableOutput(bytes, pageCount); }
export function withinDeviceCap(bytes) { return bytes <= deviceCapBytes(); }

// The leading "editing is disabled…" sentence, naming the SPECIFIC limit the document/result crosses.
// Used identically by the Merge and Rotate/Reorder banners (each appends its own action sentence).
export function largeFileReasonSentence(bytes, pageCount) {
  const overSize = bytes > EDIT_LIMIT_BYTES;
  const overPages = pageCount != null && pageCount > EDIT_LIMIT_PAGES;
  if (overSize && overPages) return 'Editing is disabled for files larger than 30 MB and having more than 500 pages.';
  if (overPages) return 'Editing is disabled for files having more than 500 pages.';
  return 'Editing is disabled for files larger than 30 MB.';
}
export const DEVICE_CAP_MESSAGE = 'This file is too large to process on this device.';
