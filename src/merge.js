// Merge PDF, a fully client-side feature that combines several PDFs into one.
//
// Design notes:
//  - Everything runs in the browser (pdf-lib for merging, PDF.js for thumbnails); no
//    file ever leaves the device.
//  - It is decoupled from the editor: the merged document is handed to the existing
//    editor through the page's hidden #fileInput (the same path drag-drop uses), so no
//    existing app.js code had to change.
//  - copyPages() preserves page size, rotation, vector content and quality (no raster
//    re-encoding); first-document metadata is carried onto the result.
import { PDFDocument } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import { mergePdfBytes } from './mergeCore.js';
import { downloadBytes } from './util/download.js';
import {
  EDIT_LIMIT_BYTES, EDIT_LIMIT_PAGES, deviceCapBytes, deviceCapMb,
  isEditableOutput, withinDeviceCap, LARGE_FILE_WARNING, DEVICE_CAP_MESSAGE,
} from './core/limits.js';

// A single input file is only rejected when it can't even be held on this device. The merge
// *output* size no longer caps merging (it caps only whether the result opens in the editor or
// downloads) — see updateButtons()/doMerge(). deviceCapBytes() is device-, not viewport-, based.

// --- Analytics: GA-ready, but a safe no-op if no analytics is installed. ----------
function track(event, detail = {}) {
  try {
    if (Array.isArray(window.dataLayer)) window.dataLayer.push({ event, ...detail });
    if (typeof window.gtag === 'function') window.gtag('event', event, detail);
    window.dispatchEvent(new CustomEvent(event, { detail }));
    console.debug('[analytics]', event, detail);
  } catch (_) { /* analytics must never break the feature */ }
}

// --- Module state -----------------------------------------------------------------
let items = [];        // { id, name, size, bytes?:Uint8Array, pageCount?, thumb?, error?, loading? }
let merging = false;
let seq = 0;
let els = null;
let dragId = null;
let currentSig = null;          // signature of the open document currently synced into the list
let dismissedCurrentSig = null; // open-doc signature the user explicitly removed (don't re-add it)
let confirmAction = null;       // callback to run when the warning dialog is confirmed

export function initMerge() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup, { once: true });
  } else {
    setup();
  }
}

function setup() {
  els = {
    openBtn: document.getElementById('mergeBtn'),
    backdrop: document.getElementById('mergeBackdrop'),
    closeBtn: document.getElementById('mergeClose'),
    drop: document.getElementById('mergeDrop'),
    input: document.getElementById('mergeFileInput'),
    list: document.getElementById('mergeList'),
    status: document.getElementById('mergeStatus'),
    count: document.getElementById('mergeCount'),
    clear: document.getElementById('mergeClear'),
    progress: document.getElementById('mergeProgress'),
    progressBar: document.getElementById('mergeProgressBar'),
    go: document.getElementById('mergeGo'),
    warn: document.getElementById('mergeWarn'),
    note: document.getElementById('mergeNote'),
    cancelBtn: document.getElementById('mergeCancel'),
    confirm: document.getElementById('mergeConfirm'),
    confirmTitle: document.getElementById('mergeConfirmTitle'),
    confirmMsg: document.getElementById('mergeConfirmMsg'),
    confirmStay: document.getElementById('mergeConfirmStay'),
    confirmClose: document.getElementById('mergeConfirmClose'),
  };
  if (!els.backdrop || !els.openBtn) return; // merge UI not on this page

  els.openBtn.addEventListener('click', openDrawer);
  els.closeBtn.addEventListener('click', requestClose);
  els.cancelBtn.addEventListener('click', requestClose);
  els.backdrop.addEventListener('click', (e) => { if (e.target === els.backdrop) requestClose(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !els.backdrop.classList.contains('open')) return;
    if (els.confirm && !els.confirm.hidden) { hideConfirm(); return; } // first Esc dismisses warning
    requestClose();
  });
  els.confirmStay.addEventListener('click', hideConfirm);
  els.confirmClose.addEventListener('click', () => {
    const fn = confirmAction;
    hideConfirm();
    if (fn) fn();
  });

  els.input.addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = ''; // allow re-picking the same file
  });

  // Drag & drop PDF files onto the dropzone, ignore the internal card-reorder drags
  // (those carry 'text/plain', not 'Files').
  const isFileDrag = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  ['dragenter', 'dragover'].forEach((ev) =>
    els.drop.addEventListener(ev, (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault(); e.stopPropagation(); els.drop.classList.add('drag');
    }));
  els.drop.addEventListener('dragleave', () => els.drop.classList.remove('drag'));
  els.drop.addEventListener('drop', (e) => {
    els.drop.classList.remove('drag');
    if (!isFileDrag(e)) return;
    e.preventDefault(); e.stopPropagation();
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  els.clear.addEventListener('click', clearAll);
  els.go.addEventListener('click', doMerge);

  render();
}

function openDrawer() {
  hideConfirm();
  syncCurrentDoc();   // auto-include the PDF that's open in the editor (if any)
  els.backdrop.classList.add('open');
  els.openBtn.classList.add('active');
}

// --- Current open document --------------------------------------------------------
// The PDF currently loaded in the editor is exposed through the page's #fileInput (the
// same input every load path feeds). We read it directly so the merge feature stays
// decoupled from app.js.
function getOpenDocFile() {
  if (!document.body.classList.contains('has-pdf')) return null;
  const fi = document.getElementById('fileInput');
  const f = fi && fi.files && fi.files[0];
  return f && looksLikePdf(f) ? f : null;
}
function sigOf(file) {
  return file ? `${file.name}:${file.size}:${file.lastModified}` : null;
}

// Keep a single isCurrent item at the front of the list in sync with the open document.
function syncCurrentDoc() {
  const file = getOpenDocFile();
  const sig = sigOf(file);
  const existing = items.find((i) => i.isCurrent);

  if (!file) {                                   // nothing open, drop any stale current item
    if (existing) items = items.filter((i) => !i.isCurrent);
    currentSig = null;
    render();
    return;
  }
  if (existing && existing.sig === sig) return;  // already in sync

  if (existing) items = items.filter((i) => !i.isCurrent); // the open document changed
  currentSig = sig;

  if (dismissedCurrentSig === sig) { render(); return; }    // user removed this one, respect it

  const item = { id: ++seq, name: file.name, size: file.size, sig, isCurrent: true, loading: true };
  items.unshift(item);   // current document goes first by default; the user can drag it later
  render();
  processItem(item, file);
}
function closeDrawer() {
  hideConfirm();
  els.backdrop.classList.remove('open');
  els.openBtn.classList.remove('active');
}
// Close, but first warn if the user added files they haven't merged (those won't load
// into the editor unless they click Merge first).
function requestClose() {
  if (!merging && hasUnmergedAdded()) {
    const download = mergeMode() === 'download';   // large result -> the action is Download, not "open"
    showConfirmDialog({
      title: 'Discard these files?',
      message: download
        ? "You've added files but haven't downloaded the combined PDF yet. Closing will clear them. Close anyway?"
        : "You've added files but haven't combined them yet. Closing will clear them — click <b>Merge &amp; open</b> first to keep the result. Close anyway?",
      stayLabel: 'Back to merge',
      confirmLabel: 'Close anyway',
      onConfirm: () => { discardAll(); closeDrawer(); },
    });
  } else {
    closeDrawer();
  }
}
function hasUnmergedAdded() {
  return items.some((i) => !i.isCurrent && i.bytes && !i.error);
}
function discardAll() {
  items = [];
  currentSig = null;
  dismissedCurrentSig = null;
  status('', '');
  render();
}

// Reusable warning dialog inside the modal.
function showConfirmDialog({ title, message, stayLabel, confirmLabel, onConfirm }) {
  if (!els.confirm) return;
  els.confirmTitle.textContent = title;
  els.confirmMsg.innerHTML = message;          // trusted, static strings only
  els.confirmStay.textContent = stayLabel || 'Cancel';
  els.confirmClose.textContent = confirmLabel || 'Confirm';
  confirmAction = typeof onConfirm === 'function' ? onConfirm : null;
  els.confirm.hidden = false;
}
function hideConfirm() {
  if (!els.confirm) return;
  els.confirm.hidden = true;
  confirmAction = null;
}

// --- Adding / validating files ----------------------------------------------------
function looksLikePdf(file) {
  return !!file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''));
}
function hasPdfMagic(bytes) {
  // "%PDF-" at the start (some files have a few junk bytes first; check first 1KB).
  const head = bytes.subarray(0, 1024);
  const sig = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  for (let i = 0; i + sig.length <= head.length; i++) {
    let ok = true;
    for (let j = 0; j < sig.length; j++) { if (head[i + j] !== sig[j]) { ok = false; break; } }
    if (ok) return true;
  }
  return false;
}
function isEncryptedError(e) {
  const s = `${e && e.name} ${e && e.message}`.toLowerCase();
  return s.includes('encrypt');
}
// True if PDF.js can open the bytes with no password (i.e. the file is encrypted but
// has an empty user password / only permission restrictions). Returns false when a real
// password is required (PDF.js throws a PasswordException).
async function opensWithoutPassword(bytes) {
  try {
    const doc = await pdfjsLib.getDocument({
      data: bytes.slice(0), disableAutoFetch: true, disableStream: true,
    }).promise;
    doc.destroy && doc.destroy();
    return true;
  } catch (_) {
    return false;
  }
}

async function addFiles(fileList) {
  const incoming = Array.from(fileList || []);
  if (!incoming.length) return;
  status('', '');

  for (const file of incoming) {
    const id = ++seq;
    if (!looksLikePdf(file)) {
      items.push({ id, name: file.name || 'file', size: file.size, error: 'Not a PDF file' });
      continue;
    }
    if (file.size > deviceCapBytes()) {
      items.push({ id, name: file.name, size: file.size, error: `Too large to process on this device (over ${deviceCapMb()} MB)` });
      continue;
    }
    const item = { id, name: file.name, size: file.size, loading: true };
    items.push(item);
    render();
    await processItem(item, file);
  }
  render();
}

// Read a file's bytes, validate it, capture page count, and kick off a thumbnail.
// Shared by added files and the auto-included current document.
async function processItem(item, file) {
  try {
    let bytes = new Uint8Array(await file.arrayBuffer());
    if (!hasPdfMagic(bytes)) { item.error = 'Not a valid PDF'; return; }

    let res = await pdflibLoad(bytes);

    if (res.encrypted) {
      // pdf-lib can't decrypt. If the file genuinely needs a password, reject it; if it's
      // only restricted (empty password, opens in the editor), auto-unlock it via the
      // backend (PyMuPDF, in memory) and then merge the unlocked copy.
      if (!(await opensWithoutPassword(bytes))) {
        item.error = 'Password-protected, open it with its password first';
        return;
      }
      item.unlocking = true;
      render();
      const decrypted = await backendDecrypt(bytes);
      item.unlocking = false;
      if (!decrypted) {
        item.error = 'Encrypted, couldn’t auto-unlock. Open it here & Save, then re-add';
        return;
      }
      bytes = decrypted;
      res = await pdflibLoad(bytes);
      if (!res.doc) { item.error = 'Couldn’t unlock this PDF'; return; }
      item.unlocked = true;
    }

    if (res.corrupted) { item.error = 'Couldn’t read this PDF (it may be corrupted)'; return; }

    item.bytes = bytes;
    item.pageCount = res.doc.getPageCount();
    makeThumb(bytes).then((url) => { item.thumb = url; render(); }).catch(() => {});
  } catch (err) {
    item.error = 'Couldn’t read this file';
  } finally {
    item.loading = false;
    render();
  }
}

// Load with pdf-lib, classifying the failure so callers can react.
async function pdflibLoad(bytes) {
  try {
    return { doc: await PDFDocument.load(bytes) };
  } catch (err) {
    return isEncryptedError(err) ? { encrypted: true } : { corrupted: true };
  }
}

// Ask the backend (PyMuPDF) for an unencrypted copy. Returns Uint8Array, or null if the
// backend is unreachable / declines (caller then shows the manual workaround). The file
// is processed in memory and not stored.
async function backendDecrypt(bytes) {
  const base = (typeof window !== 'undefined' && window.PDF_BACKEND_URL) || '';
  if (!base) return null;
  try {
    const res = await fetch(`${base}/decrypt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdfBase64: bytesToBase64(bytes) }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.success || !data.pdfBase64) return null; // incl. needsPassword case
    return base64ToBytes(data.pdfBase64);
  } catch (_) {
    return null;
  }
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}
function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function makeThumb(bytes) {
  // PDF.js may transfer (detach) its input buffer, so hand it a copy and keep `bytes`
  // intact for the merge step.
  const task = pdfjsLib.getDocument({ data: bytes.slice(0), disableAutoFetch: true, disableStream: true });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2, 88 / base.width);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(vp.width));
    canvas.height = Math.max(1, Math.ceil(vp.height));
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    return canvas.toDataURL('image/png');
  } finally {
    doc.destroy && doc.destroy();
  }
}

function removeItem(id) {
  const it = items.find((i) => i.id === id);
  if (!it) return;
  if (it.isCurrent) {
    // The current document is the PDF open in the editor, removing it also closes it
    // from the main page, so warn first.
    showConfirmDialog({
      title: 'Remove the current document?',
      message: 'This is the PDF open in the editor. Removing it here will also <b>close it from the editor</b>.',
      stayLabel: 'Cancel',
      confirmLabel: 'Remove',
      onConfirm: () => doRemove(id),
    });
    return;
  }
  doRemove(id);
}

function doRemove(id) {
  const it = items.find((i) => i.id === id);
  if (!it) return;
  if (it.isCurrent) {
    dismissedCurrentSig = it.sig;   // don't silently re-add it on reopen
    closeEditorDocument();          // also clear it from the main editor page
  }
  items = items.filter((i) => i.id !== id);
  if (!items.length) status('', '');
  render();
}

// Ask the editor (exposed as window.pdfEditorApp) to clear the open document.
function closeEditorDocument() {
  try {
    const app = window.pdfEditorApp;
    if (app && typeof app.closeDocument === 'function') app.closeDocument();
  } catch (_) { /* editor not present / older build, ignore */ }
}
function clearAll() {
  items = [];
  currentSig = null;
  dismissedCurrentSig = null;
  status('', '');
  syncCurrentDoc();   // bring the current document back if one is open
}

// --- Reordering (HTML5 drag & drop on the cards) ----------------------------------
function reorder(fromId, toId, after) {
  if (fromId === toId) return;
  const from = items.findIndex((i) => i.id === fromId);
  if (from < 0) return;
  const [moved] = items.splice(from, 1);
  let to = items.findIndex((i) => i.id === toId);
  if (to < 0) to = items.length;
  else if (after) to += 1;
  items.splice(to, 0, moved);
  render();
}

// --- Merge ------------------------------------------------------------------------
function validItems() {
  return items.filter((i) => i.bytes && !i.error);
}

// Estimate the merged OUTPUT without actually merging (cheap, runs on every add/remove for the
// dynamic button morph). Page count is exact (sum of inputs); byte size is the sum of input sizes
// — a safe upper bound (pdf-lib's merge is usually a touch smaller), so we err toward "Download".
function mergeOutputEstimate() {
  const valid = validItems();
  return {
    bytes: valid.reduce((n, i) => n + (i.size || 0), 0),
    pages: valid.reduce((n, i) => n + (i.pageCount || 0), 0),
    count: valid.length,
  };
}
// 'open'  -> editable result, "Merge & open" hands off to the editor.
// 'download' -> over the 30 MB / 500-page edit limit (but within the device cap): "Download" only.
// 'overcap'  -> beyond what this device can process: disabled.
function mergeMode() {
  const { bytes, pages } = mergeOutputEstimate();
  if (!withinDeviceCap(bytes)) return 'overcap';
  return isEditableOutput(bytes, pages) ? 'open' : 'download';
}

async function doMerge() {
  const valid = validItems();
  if (merging || valid.length < 1) return;
  const mode = mergeMode();
  if (mode === 'overcap') { status(DEVICE_CAP_MESSAGE, 'err'); return; }

  merging = true;
  updateButtons();
  showProgress(2);
  status('Merging…', 'info');

  const totalPages = valid.reduce((n, i) => n + (i.pageCount || 0), 0);
  track('merge_started', { fileCount: valid.length, pageCount: totalPages });

  try {
    const bytes = await mergePdfBytes(valid.map((i) => i.bytes), {
      onProgress: (done, total) => showProgress(Math.round((done / total) * 88) + 2),
    });
    showProgress(100);
    // OOM-safety: a result that somehow ballooned past the device cap downloads/aborts rather
    // than try to stream a too-big file into the editor.
    if (!withinDeviceCap(bytes.length)) {
      track('merge_failed', { error: 'over_device_cap', bytes: bytes.length });
      status(DEVICE_CAP_MESSAGE, 'err');
      return;
    }
    track('merge_completed', { fileCount: valid.length, pageCount: totalPages, bytes: bytes.length });

    if (mode === 'download') {
      // Large result: download the merged PDF directly, never hand off to the editor / backend.
      downloadBytes(bytes, 'merged.pdf');
      status('Merged. Editing is disabled for large files — downloaded the combined PDF instead.', 'ok');
      // Keep the list so the user can adjust the selection and download again.
    } else {
      status(`Merged ${valid.length} file${valid.length === 1 ? '' : 's'}. Opening in the editor…`, 'ok');
      loadIntoEditor(bytes);
      // The merged document becomes the open document, so reset the list, reopening the
      // panel then shows only it (auto-included as "Current document"), not the old sources.
      items = [];
      currentSig = null;
      dismissedCurrentSig = null;
      setTimeout(closeDrawer, 700);
    }
  } catch (err) {
    const msg = String((err && err.message) || err);
    const oom = /allocation|out of memory|invalid array length|maximum call|range/i.test(msg);
    track('merge_failed', { error: msg });
    status(oom ? DEVICE_CAP_MESSAGE
               : 'Sorry, merging failed. One of the files may be corrupted; remove it and try again.', 'err');
  } finally {
    merging = false;
    updateButtons();
    setTimeout(() => { if (!merging) hideProgress(); }, 900);
  }
}

// Hand the merged bytes to the editor through the existing file pipeline (no app.js
// changes).
function loadIntoEditor(bytes) {
  const input = document.getElementById('fileInput');
  if (!input) return;
  const file = new File([bytes], 'merged.pdf', { type: 'application/pdf' });
  try {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (_) {
    status('Merged! Use Download to save the combined PDF.', 'ok');
  }
}

// --- Rendering --------------------------------------------------------------------
function render() {
  if (!els) return;
  els.list.textContent = '';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'merge-empty';
    empty.style.cursor = 'pointer';
    empty.title = 'Choose PDF files';
    empty.innerHTML =
      '<span class="art" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6"/><path d="M12 18v-6"/><path d="m9 15 3-3 3 3"/></svg></span>' +
      '<span class="big">Drag PDFs here or choose files</span>' +
      '<span>Combine multiple PDFs into one, at least two needed</span>';
    empty.addEventListener('click', () => els.input.click());
    els.list.appendChild(empty);
  }

  for (const it of items) {
    const card = document.createElement('div');
    card.className = 'merge-card' + (it.error ? ' is-error' : '') + (it.isCurrent ? ' is-current' : '');
    card.dataset.id = String(it.id);

    if (!it.error) {
      card.draggable = true;
      card.addEventListener('dragstart', onDragStart);
      card.addEventListener('dragover', onDragOver);
      card.addEventListener('dragleave', onDragLeave);
      card.addEventListener('drop', onDrop);
      card.addEventListener('dragend', onDragEnd);
      const handle = document.createElement('span');
      handle.className = 'merge-handle';
      handle.setAttribute('aria-hidden', 'true');
      handle.title = 'Drag to reorder';
      handle.textContent = '⠿';
      card.appendChild(handle);
    }

    const thumb = document.createElement('div');
    thumb.className = 'merge-thumb-wrap';
    if (it.loading) {
      const sp = document.createElement('div');
      sp.className = 'merge-spin';
      thumb.appendChild(sp);
    } else if (it.thumb) {
      const img = document.createElement('img');
      img.src = it.thumb;
      img.alt = '';
      thumb.appendChild(img);
    } else {
      const ph = document.createElement('span');
      ph.className = 'ph';
      ph.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6"/></svg>';
      thumb.appendChild(ph);
    }
    card.appendChild(thumb);

    const meta = document.createElement('div');
    meta.className = 'merge-meta';
    const name = document.createElement('div');
    name.className = 'merge-name';
    name.textContent = it.name;        // textContent = filename never interpreted as HTML
    name.title = it.name;
    meta.appendChild(name);

    if (it.isCurrent) {
      const badge = document.createElement('span');
      badge.className = 'merge-badge';
      badge.textContent = 'Current document';
      badge.title = 'This PDF is the one open in the editor';
      meta.appendChild(badge);
    }

    const sub = document.createElement('div');
    sub.className = 'merge-sub' + (it.error ? ' err' : '');
    if (it.error) sub.textContent = it.error;
    else if (it.loading) sub.textContent = 'Reading…';
    else sub.textContent = `${it.pageCount} ${it.pageCount === 1 ? 'page' : 'pages'} · ${humanSize(it.size)}`;
    meta.appendChild(sub);
    card.appendChild(meta);

    const del = document.createElement('button');
    del.className = 'merge-card-del';
    del.type = 'button';
    del.title = 'Remove from merge';
    del.setAttribute('aria-label', `Remove ${it.name} from merge`);
    del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    del.addEventListener('click', () => removeItem(it.id));
    card.appendChild(del);

    els.list.appendChild(card);
  }

  if (items.length) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'merge-add-tile';
    add.title = 'Add more PDFs';
    add.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg> Add file';
    add.addEventListener('click', () => els.input.click());
    els.list.appendChild(add);
  }

  updateTotals();
  updateButtons();
  updateIdleHint();
}

// Clears a stale idle hint. (A single PDF is now mergeable, so there's no "add one more"
// nudge.) Leaves ok/err messages alone.
function updateIdleHint() {
  if (merging) return;
  if (els.status.classList.contains('info')) status('', '');
}

function onDragStart(e) {
  dragId = Number(e.currentTarget.dataset.id);
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', String(dragId)); } catch (_) {}
}
function onDragOver(e) {
  e.preventDefault();
  const card = e.currentTarget;
  const r = card.getBoundingClientRect();
  const after = (e.clientY - r.top) > r.height / 2;
  card.classList.toggle('drop-after', after);
  card.classList.toggle('drop-before', !after);
}
function onDragLeave(e) {
  e.currentTarget.classList.remove('drop-before', 'drop-after');
}
function onDrop(e) {
  e.preventDefault();
  const card = e.currentTarget;
  const after = card.classList.contains('drop-after');
  card.classList.remove('drop-before', 'drop-after');
  if (dragId != null) reorder(dragId, Number(card.dataset.id), after);
}
function onDragEnd() {
  dragId = null;
  els.list.querySelectorAll('.merge-card').forEach((c) =>
    c.classList.remove('dragging', 'drop-before', 'drop-after'));
}

function updateTotals() {
  const valid = validItems();
  const pages = valid.reduce((n, i) => n + (i.pageCount || 0), 0);
  const errors = items.length - valid.length;
  els.clear.hidden = items.length === 0;
  if (!items.length) {
    els.count.textContent = 'No files added yet';
  } else {
    let txt = `${valid.length} file${valid.length === 1 ? '' : 's'} · ${pages} page${pages === 1 ? '' : 's'}`;
    if (errors > 0) txt += ` · ${errors} skipped`;
    els.count.textContent = txt;
  }
}

// Icons kept as inline SVG (no new image assets).
const MERGE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M12 8v8"/><path d="M8 12h8"/></svg>';
const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>';

function updateButtons() {
  const ready = validItems().length >= 1;   // enabled for one file too; disabled only when empty
  const mode = ready ? mergeMode() : 'open'; // 'open' | 'download' | 'overcap'
  const over = mode === 'overcap';
  els.go.disabled = merging || !ready || over;
  updateMergeWarn(ready ? mode : 'open');

  if (merging) {
    els.go.innerHTML = '<span class="merge-spin" style="border-top-color:#fff;border-color:rgba(255,255,255,.5)"></span> Merging…';
    els.go.title = 'Merging…';
    return;
  }
  // Same single button morphs between "Merge & open" (editable) and "Download" (large result).
  if (mode === 'download') {
    els.go.innerHTML = `${DOWNLOAD_ICON} Download`;
    els.go.title = 'Download the merged PDF (too large to open in the editor)';
  } else {
    els.go.innerHTML = `${MERGE_ICON} Merge &amp; open`;
    els.go.title = over ? DEVICE_CAP_MESSAGE
      : (ready ? 'Merge the PDFs in order and open the result' : 'Add a PDF to get started');
  }
}

// In-drawer banner that mirrors the button mode. Only ONE message shows at a time: the neutral
// "not combined yet" note for an editable result, OR the amber large-file warning for a download.
function updateMergeWarn(mode) {
  const big = mode === 'download' || mode === 'overcap';
  if (els.note) els.note.hidden = big || !items.length;   // hide the blue note when the amber one shows
  if (!els.warn) return;
  if (mode === 'download') {
    els.warn.textContent = LARGE_FILE_WARNING;
    els.warn.className = 'merge-warn';
    els.warn.hidden = false;
  } else if (mode === 'overcap') {
    els.warn.textContent = DEVICE_CAP_MESSAGE;
    els.warn.className = 'merge-warn err';
    els.warn.hidden = false;
  } else {
    els.warn.hidden = true;
  }
}

// --- Small helpers ----------------------------------------------------------------
function showProgress(pct) {
  els.progress.hidden = false;
  els.progressBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}
function hideProgress() {
  els.progress.hidden = true;
  els.progressBar.style.width = '0%';
}
function status(text, kind) {
  els.status.className = 'merge-status' + (kind ? ` ${kind}` : '');
  els.status.textContent = text || '';
}
function humanSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
