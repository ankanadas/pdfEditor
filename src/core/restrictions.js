// Password + edit-restriction prompts (encrypted / permission-restricted PDFs).
// Assembled onto PDFEditorApp.prototype (mixin); verbatim from app.js (this = the app).
import * as pdfjsLib from 'pdfjs-dist';
import { confirmDialog } from '../util/dialog.js';

export const RestrictionMethods = {
  /** True if an error from PDF.js indicates the document is password-protected/encrypted. */
  _isPasswordError(err) {
    if (!err) return false;
    const name = err.name || '', msg = err.message || '';
    return name === 'PasswordException' || /password/i.test(msg) || /encrypt/i.test(msg);
  },
  /**
   * Show the password prompt for an encrypted PDF and resolve with the entered password, or
   * null if the user cancels. `incorrect` shows the "wrong password, try again" hint. The
   * password is used in-memory only (handed to PDF.js / the backend) — never stored or logged.
   */
  promptPassword(incorrect = false) {
    return new Promise((resolve) => {
      const backdrop = document.getElementById('pwBackdrop');
      const form = document.getElementById('pwForm');
      const input = document.getElementById('pwInput');
      const errEl = document.getElementById('pwError');
      const cancelBtn = document.getElementById('pwCancel');
      if (!backdrop || !form || !input || !cancelBtn) { resolve(null); return; }

      if (errEl) { errEl.hidden = !incorrect; errEl.textContent = 'Incorrect password. Please try again.'; }
      input.value = '';
      backdrop.hidden = false;
      setTimeout(() => input.focus(), 30);

      const cleanup = () => {
        backdrop.hidden = true;
        form.removeEventListener('submit', onSubmit);
        cancelBtn.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey);
      };
      const onSubmit = (e) => {
        e.preventDefault();
        const v = input.value;
        if (!v) { if (errEl) { errEl.hidden = false; errEl.textContent = 'Please enter a password.'; } return; }
        cleanup(); resolve(v);
      };
      const onCancel = () => { cleanup(); resolve(null); };
      const onKey = (e) => { if (e.key === 'Escape') onCancel(); };

      form.addEventListener('submit', onSubmit);
      cancelBtn.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey);
    });
  },
  /**
   * True if the loaded document carries owner-level editing restrictions — i.e. it is encrypted with
   * a permissions dictionary that does NOT grant "modify contents" (a permission-only / empty-user-
   * password PDF that opens without prompting). A real-password PDF the user unlocked is decrypted to
   * an unrestricted copy, so it returns false (they already proved authorisation).
   */
  async _detectEditRestriction() {
    try {
      const perms = await this.pdfJsDoc.getPermissions();
      if (!perms) return false;   // no permissions dictionary -> unrestricted
      const MODIFY = (pdfjsLib.PermissionFlag && pdfjsLib.PermissionFlag.MODIFY_CONTENTS) || 0x08;
      return !perms.includes(MODIFY);
    } catch (_) {
      return false;
    }
  },
  /**
   * Gate the first edit on a restricted document. Resolves true if editing may proceed: immediately
   * when the document isn't restricted or the user already confirmed; otherwise it shows a one-time
   * authorisation confirmation and resolves with the user's choice (remembered for the session).
   */
  async _confirmEditAllowed() {
    if (!this._editRestricted || this._restrictionConfirmed) return true;
    if (this._restrictionPromptOpen) return false;          // a prompt is already on screen
    this._restrictionPromptOpen = true;
    const ok = await confirmDialog(
      'This document contains editing restrictions. By continuing, you confirm that you are authorized to modify this document.',
      { title: 'Editing restrictions', okText: 'Continue', cancelText: 'Cancel' }
    );
    this._restrictionPromptOpen = false;
    if (ok) this._restrictionConfirmed = true;
    return ok;
  },
};
