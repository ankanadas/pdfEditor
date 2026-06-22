// Colour helpers — pure value transforms (hex <-> rgb array <-> css). Extracted verbatim
// from PDFEditorApp (was _hexToRgb / _rgbCss / _rgbToHex; no this/state).

export function hexToRgb(h) {
  h = (h || '').replace('#', '');
  return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0];
}

export function rgbCss(c) {
  return Array.isArray(c) ? `rgb(${c[0]},${c[1]},${c[2]})` : (c || '#000');
}

export function rgbToHex(c) {
  return Array.isArray(c)
    ? '#' + c.map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')
    : '#000000';
}
