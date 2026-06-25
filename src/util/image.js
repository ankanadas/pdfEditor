// Image helpers — pure, DOM-only (no app state). Extracted verbatim from PDFEditorApp.

/** Load a data-URL (or any src) into an HTMLImageElement (used by the flatten fallback). */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = src;
  });
}

/** Aspect ratio (naturalHeight / naturalWidth) of an image src; 0.4 fallback on error. */
export function imageRatio(src) {
  return loadImage(src).then(im => (im.naturalHeight / im.naturalWidth) || 0.4).catch(() => 0.4);
}
