// Single source of truth for the size/page limits that gate EDITING, and for the per-device
// processing cap. Used by the editor open path (fileIO), Merge, and the Rotate/Reorder pages tool.
//
// Two independent thresholds:
//  - EDIT limit (byte size OR 1500 pages): above this a document can still be VIEWED, MERGED and
//    ROTATED/REORDERED (all client-side), it just can't be edited or opened back into the editor.
//    The BYTE limit is DEVICE-AWARE: 200 MB on desktop, 30 MB on mobile. Everything now runs in
//    the browser (mupdf-wasm, no upload), and a desktop comfortably edits+saves a 200 MB file
//    (measured: ~200 MB PDF opens editable in ~3s, saves in ~3s, JS heap ~640 MB). A phone can't
//    hold that, so mobile keeps the conservative 30 MB gate. The PAGE limit (1500 — raised from
//    500 once editing went fully client-side; no server round-trip to protect) is the same on
//    both. Whichever of the two hits first applies.
//  - DEVICE cap (500 MB desktop / 150 MB mobile): above this we can't safely hold/process the
//    file in this browser at all. Keyed to the ACTUAL device (touch + UA, plus navigator.deviceMemory
//    as a low-RAM signal), NOT the viewport width — a narrow desktop window still gets the 500 MB cap.

const MB = 1024 * 1024;

export const EDIT_LIMIT_DESKTOP_MB = 200;   // in-browser edit is fine at this size on a desktop
export const EDIT_LIMIT_MOBILE_MB = 30;     // a phone can't hold a 200 MB doc in memory
export const EDIT_LIMIT_PAGES = 1500;
// Above this page count an EDITABLE doc renders lazily (paint pages near the viewport, evict far
// ones) instead of eagerly. Eager canvases are ~4.4 MB each at scale 1.5 — a few hundred pages
// painted up front is already 1-2 GB of native canvas memory. Desktop tolerates that; a touch
// device (iPad/phone) does NOT — Safari kills the tab. So the threshold is DEVICE-AWARE: touch
// devices virtualize much sooner. Below the threshold, rendering is eager (unchanged).
export const LAZY_EDIT_PAGES = 500;
export function lazyRenderThreshold() {
  // Touch = iPad/phone: a 466-page book eager = ~2 GB of canvases = an instant OOM on iPad. 50 full
  // canvases (~220 MB) is a safe ceiling before virtualizing; desktop keeps the roomy 500.
  return isMobileDevice() ? 50 : LAZY_EDIT_PAGES;
}

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

// A PHONE specifically (small-screen handset) — NOT a tablet. Only phones get the conservative
// mobile edit limits; a TABLET (iPad, incl. iPadOS-as-desktop, or an Android tablet) is treated
// like a desktop for the edit LIMITS. Modern tablets have the RAM to edit large files in-browser,
// and the renderer already virtualizes pages to keep memory flat, so the 30 MB / small gate that
// suits a phone needlessly blocked iPads. Phones: iPhone/iPod, an Android UA carrying "Mobile"
// (Android tablets omit it), and the legacy handset UAs. iPad/tablet fall through to false.
export function isPhoneDevice() {
  try {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    const touch = (typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 0) > 0) ||
      (typeof window !== 'undefined' && 'ontouchstart' in window);
    if (!touch) return false;
    const iPhone = /iPhone|iPod/i.test(ua);
    const androidPhone = /Android/i.test(ua) && /Mobile/i.test(ua);
    const otherPhone = /Windows Phone|BlackBerry|Opera Mini|IEMobile/i.test(ua);
    return iPhone || androidPhone || otherPhone;
  } catch (_) { return false; }
}

// The edit byte limit for THIS device, resolved at call time (the same bundle serves desktop and
// mobile, so this can't be a load-time constant). Very low-RAM machines (deviceMemory ≤ 2 GB) get
// the mobile limit even on a desktop UA.
export function editLimitMb() {
  const mem = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 0;   // GB, Chromium-only
  // PHONES (and genuinely low-RAM machines) get the conservative gate; tablets/iPads = desktop.
  if (isPhoneDevice() || (mem && mem <= 2)) return EDIT_LIMIT_MOBILE_MB;
  return EDIT_LIMIT_DESKTOP_MB;
}
export function editLimitBytes() { return editLimitMb() * MB; }

// Bytes ceiling for what this device can process at all (merge/rotate output, or a file to open).
export function deviceCapBytes() {
  // Phones get the tight processing cap; iPads/tablets get the desktop cap (they have the RAM).
  let capMb = isPhoneDevice() ? MOBILE_CAP_MB : DESKTOP_CAP_MB;
  const mem = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 0;  // GB, Chromium-only
  if (mem && mem <= 2) capMb = Math.min(capMb, MOBILE_CAP_MB);                     // very low-RAM machine
  return capMb * MB;
}
export function deviceCapMb() { return Math.round(deviceCapBytes() / MB); }

// Editable == within BOTH the (device-aware) byte limit AND the page limit. pageCount may be
// omitted (byte-only check).
export function isEditableOutput(bytes, pageCount) {
  return bytes <= editLimitBytes() && (pageCount == null || pageCount <= EDIT_LIMIT_PAGES);
}
export function overEditLimit(bytes, pageCount) { return !isEditableOutput(bytes, pageCount); }
export function withinDeviceCap(bytes) { return bytes <= deviceCapBytes(); }

// The leading "editing is disabled…" sentence, naming the SPECIFIC limit the document/result
// crosses (with the device-aware MB figure). Used identically by the Merge and Rotate/Reorder
// banners (each appends its own action sentence).
export function largeFileReasonSentence(bytes, pageCount) {
  const mb = editLimitMb();
  const overSize = bytes > editLimitBytes();
  const overPages = pageCount != null && pageCount > EDIT_LIMIT_PAGES;
  if (overSize && overPages) return `Editing is disabled for files larger than ${mb} MB and having more than ${EDIT_LIMIT_PAGES} pages.`;
  if (overPages) return `Editing is disabled for files having more than ${EDIT_LIMIT_PAGES} pages.`;
  return `Editing is disabled for files larger than ${mb} MB.`;
}
export const DEVICE_CAP_MESSAGE = 'This file is too large to process on this device.';
