// Confirm dialog — pure DOM helper (uses the #confirmDialog modal, falls back to window.confirm).
// Extracted verbatim from PDFEditorApp (no this/state).

export function confirmDialog(message, opts = {}) {
  return new Promise((resolve) => {
    const back = document.getElementById('confirmDialog');
    const msg = document.getElementById('confirmMessage');
    const ok = document.getElementById('confirmOk');
    const cancel = document.getElementById('confirmCancel');
    const title = document.getElementById('confirmTitle');
    if (!back || !ok || !cancel) { resolve(window.confirm(message)); return; }
    if (title) title.textContent = opts.title || 'Discard your edits?';
    ok.textContent = opts.okText || 'Open new PDF';
    cancel.textContent = opts.cancelText || 'Cancel';
    ok.classList.toggle('confirm-danger', !!opts.danger);   // red confirm for destructive actions
    msg.textContent = message;
    back.classList.add('open');
    const finish = (val) => {
      back.classList.remove('open');
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      resolve(val);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
  });
}
