// Split PDF — a fully client-side feature that slices the OPEN document into a new PDF (by page
// range) or into one 1-page PDF per page packaged as a ZIP. Mirrors the Merge module's "open a box →
// produce bytes → download" shape and never leaves the device.
//
// Design notes:
//  - Operates on the document currently open in the editor. Any pending USER EDITS (replaced/added
//    text, font/style changes) and previewed rotations are baked in first via the app's shared
//    _produceEditedBytes() — the exact same pipeline Save uses — so the split carries them.
//  - Subsetting uses pdf-lib copyPages() (lossless: page size, rotation, annotations, vectors kept;
//    the new doc has no cross-page outline tree, keeping the output tiny).
//  - The editor is never reloaded or mutated: Split reads the doc, produces a file, downloads it.
import { downloadBytes } from './util/download.js';
import { parseRanges, splitPdfBytes, extractAllZipBytes } from './splitCore.js';

let els = null;
let selected = new Set();   // 0-based page indices currently selected
let anchor = null;          // last-clicked index, for shift-range selection
let busy = false;
let observer = null;        // lazy thumbnail IntersectionObserver

export function initSplit() {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup, { once: true });
  else setup();
}

function setup() {
  els = {
    openBtn: document.getElementById('splitBtn'),
    backdrop: document.getElementById('splitBackdrop'),
    closeBtn: document.getElementById('splitClose'),
    cancelBtn: document.getElementById('splitCancel'),
    grid: document.getElementById('splitGrid'),
    range: document.getElementById('splitRange'),
    count: document.getElementById('splitCount'),
    status: document.getElementById('splitStatus'),
    warn: document.getElementById('splitWarn'),
    go: document.getElementById('splitGo'),
    extractAll: document.getElementById('splitExtractAll'),
    selectAll: document.getElementById('splitSelectAll'),
    clear: document.getElementById('splitClear'),
    progress: document.getElementById('splitProgress'),
    progressBar: document.getElementById('splitProgressBar'),
  };
  if (!els.backdrop || !els.openBtn) return;   // Split UI not on this page

  els.openBtn.addEventListener('click', openDrawer);
  els.closeBtn && els.closeBtn.addEventListener('click', closeDrawer);
  els.cancelBtn && els.cancelBtn.addEventListener('click', closeDrawer);
  els.backdrop.addEventListener('click', (e) => { if (e.target === els.backdrop) closeDrawer(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.backdrop.classList.contains('open')) closeDrawer();
  });
  els.range && els.range.addEventListener('input', onRangeInput);
  els.go && els.go.addEventListener('click', doSplitRange);
  els.extractAll && els.extractAll.addEventListener('click', doExtractAll);
  els.selectAll && els.selectAll.addEventListener('click', () => { const n = pageCount(); selected = new Set(Array.from({ length: n }, (_, i) => i)); anchor = n ? n - 1 : null; syncFromSelection(); });
  els.clear && els.clear.addEventListener('click', () => { selected = new Set(); anchor = null; syncFromSelection(); });
}

// ---- the open document -----------------------------------------------------------
function app() { return window.pdfEditorApp || null; }
function pageCount() { const a = app(); return (a && a.pdfJsDoc && a.pdfJsDoc.numPages) || 0; }
function hasDoc() { return !!(app() && app().pdfJsDoc && document.body.classList.contains('has-pdf')); }

function openDrawer() {
  if (!hasDoc()) { return; }
  selected = new Set(); anchor = null;
  els.backdrop.classList.add('open');
  els.openBtn.classList.add('active');
  if (els.range) els.range.value = '';
  renderGrid();
  syncFromSelection();
  status('', '');
}
function closeDrawer() {
  els.backdrop.classList.remove('open');
  els.openBtn.classList.remove('active');
  if (observer) { observer.disconnect(); observer = null; }
}

// ---- thumbnail grid + selection --------------------------------------------------
function renderGrid() {
  if (!els.grid) return;
  els.grid.textContent = '';
  if (observer) { observer.disconnect(); observer = null; }
  const n = pageCount();
  // Lazy-render canvases for big docs so opening the panel stays instant.
  observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const c = en.target;
      observer.unobserve(c);
      if (!c.dataset.rendered) { c.dataset.rendered = '1'; renderThumb(c, Number(c.dataset.page)); }
    }
  }, { root: els.grid, rootMargin: '300px' });

  for (let i = 0; i < n; i++) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'split-thumb';
    tile.dataset.page = String(i);
    tile.title = `Page ${i + 1} — click to select (Shift = range, ⌘/Ctrl = toggle)`;
    const canvas = document.createElement('canvas');
    canvas.className = 'split-thumb-canvas';
    canvas.dataset.page = String(i);
    const num = document.createElement('span');
    num.className = 'split-thumb-num';
    num.textContent = String(i + 1);
    const check = document.createElement('span');
    check.className = 'split-thumb-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = '✓';
    tile.appendChild(canvas);
    tile.appendChild(num);
    tile.appendChild(check);
    tile.addEventListener('click', (e) => onThumbClick(i, e));
    els.grid.appendChild(tile);
    observer.observe(canvas);
  }
}

async function renderThumb(canvas, pageIndex) {
  try {
    const doc = app().pdfJsDoc;
    const page = await doc.getPage(pageIndex + 1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(1.5, 150 / base.width);
    const vp = page.getViewport({ scale });
    canvas.width = Math.max(1, Math.ceil(vp.width));
    canvas.height = Math.max(1, Math.ceil(vp.height));
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  } catch (_) { /* a thumbnail failing to paint must not break selection */ }
}

function onThumbClick(i, e) {
  if (e.shiftKey && anchor != null) {
    const [a, b] = anchor <= i ? [anchor, i] : [i, anchor];
    for (let p = a; p <= b; p++) selected.add(p);
  } else if (e.metaKey || e.ctrlKey) {
    if (selected.has(i)) selected.delete(i); else selected.add(i);
    anchor = i;
  } else {
    selected = new Set([i]);
    anchor = i;
  }
  syncFromSelection();
}

// Reflect the current selection into the range field + thumbnail highlights + button state.
function syncFromSelection() {
  if (els.range) els.range.value = selectionToRange(selected);
  reflectThumbs();
  updateCount();
  updateButtons();
}
// Typing in the range field is the source of truth too — parse it back into the selection.
function onRangeInput() {
  const { indices } = parseRanges(els.range.value, pageCount());
  selected = new Set(indices);
  reflectThumbs();
  updateCount();
  updateButtons();
}
function reflectThumbs() {
  if (!els.grid) return;
  els.grid.querySelectorAll('.split-thumb').forEach((t) => {
    t.classList.toggle('selected', selected.has(Number(t.dataset.page)));
  });
}

// Compress a set of 0-based indices to a 1-based print-style range string ("1-3, 7, 9-10").
function selectionToRange(set) {
  const arr = [...set].sort((a, b) => a - b);
  const parts = [];
  let i = 0;
  while (i < arr.length) {
    let j = i;
    while (j + 1 < arr.length && arr[j + 1] === arr[j] + 1) j++;
    parts.push(arr[i] === arr[j] ? `${arr[i] + 1}` : `${arr[i] + 1}-${arr[j] + 1}`);
    i = j + 1;
  }
  return parts.join(', ');
}

function updateCount() {
  if (!els.count) return;
  const n = pageCount();
  const k = selected.size;
  els.count.textContent = k ? `${k} of ${n} page${n === 1 ? '' : 's'} selected` : `${n} page${n === 1 ? '' : 's'} — pick a range`;
}
function updateButtons() {
  const ready = selected.size > 0 && !busy;
  if (els.go) els.go.disabled = !ready;
  if (els.extractAll) els.extractAll.disabled = busy || pageCount() < 1;
}

// ---- execution -------------------------------------------------------------------
// Bake the user's edits (+ previewed rotation) into the bytes we split, using the SAME producer Save
// uses. When there's nothing pending, use the pristine bytes directly (fast, no re-encode).
async function sourceBytes() {
  const a = app();
  if (!a) return null;
  const pendingRot = a._pendingRot && Object.keys(a._pendingRot).length;
  const annots = a.annotationManager && a.annotationManager.serialize ? a.annotationManager.serialize().length : 0;
  const dirty = (a.edits && a.edits.length) || pendingRot || annots;
  if (dirty && a._produceEditedBytes) {
    try { const { bytes } = await a._produceEditedBytes(); if (bytes) return bytes; }
    catch (e) { console.warn('Split: could not bake edits, using original bytes:', e); }
  }
  return a.originalFileData || null;
}

async function doSplitRange() {
  if (busy) return;
  const { indices, bad } = parseRanges(els.range ? els.range.value : '', pageCount());
  if (!indices.length) { status('Enter a page range like 1-3, 7, 9-10.', 'err'); return; }
  setBusy(true, 'Splitting…');
  try {
    const bytes = await sourceBytes();
    if (!bytes) { status('Couldn’t read the open document.', 'err'); return; }
    const out = await splitPdfBytes(bytes, indices);
    downloadBytes(out, 'split.pdf');
    const skip = bad.length ? ` (ignored: ${bad.join(', ')})` : '';
    status(`Downloaded ${indices.length} page${indices.length === 1 ? '' : 's'}.${skip}`, 'ok');
  } catch (e) {
    console.error('Split failed:', e);
    status('Sorry, splitting failed. The document may be protected — open it here and Save first.', 'err');
  } finally {
    setBusy(false);
  }
}

async function doExtractAll() {
  if (busy) return;
  const n = pageCount();
  if (n < 1) return;
  setBusy(true, 'Extracting…');
  showProgress(2);
  try {
    const bytes = await sourceBytes();
    if (!bytes) { status('Couldn’t read the open document.', 'err'); return; }
    const base = (fileBaseName() || 'document');
    const { zip, count } = await extractAllZipBytes(bytes, base, {
      onProgress: (done, total) => showProgress(Math.round((done / total) * 96) + 2),
    });
    showProgress(100);
    downloadBytes(zip, `${base}-pages.zip`, 'application/zip');
    status(`Downloaded ${count} single-page PDFs (zip).`, 'ok');
  } catch (e) {
    console.error('Extract-all failed:', e);
    status('Sorry, extracting failed. The document may be protected — open it here and Save first.', 'err');
  } finally {
    setBusy(false);
    setTimeout(() => { if (!busy) hideProgress(); }, 800);
  }
}

// ---- small helpers ---------------------------------------------------------------
function fileBaseName() {
  try {
    const fi = document.getElementById('fileInput');
    const nm = fi && fi.files && fi.files[0] && fi.files[0].name;
    return nm ? nm.replace(/\.pdf$/i, '').slice(0, 40) : '';
  } catch (_) { return ''; }
}
function setBusy(on, label) {
  busy = on;
  updateButtons();
  if (els.go && on && label) { els.go.dataset.label = els.go.textContent; }
  if (on && label) status(label, 'info');
}
function showProgress(pct) {
  if (!els.progress) return;
  els.progress.hidden = false;
  els.progressBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}
function hideProgress() {
  if (!els.progress) return;
  els.progress.hidden = true;
  els.progressBar.style.width = '0%';
}
function status(text, kind) {
  if (!els.status) return;
  els.status.className = 'split-status' + (kind ? ` ${kind}` : '');
  els.status.textContent = text || '';
}
