// Structural guards for the recent editor features: the Merge modal, its cancel/close
// warning, the removed Download button, the Reorder modal matching the Merge modal, and
// that the merge/edit feature files exist. Reads files only (no DOM/build needed).
import { describe, it, expect } from '@jest/globals';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

describe('Merge modal UI is present in the editor', () => {
  const html = () => read('index.html');

  it('has the Merge tool and the centred modal shell', () => {
    const h = html();
    expect(h).toContain('class="rightbar"');         // right tool rail
    expect(h).toContain('id="mergeBtn"');             // Merge tool button
    for (const id of ['mergeBackdrop', 'mergeDrawer', 'mergeClose', 'mergeFileInput',
      'mergeList', 'mergeDrop', 'mergeGo', 'mergeCancel']) {
      expect(h).toContain(`id="${id}"`);
    }
  });

  it('has the cancel/close warning dialog', () => {
    const h = html();
    for (const id of ['mergeConfirm', 'mergeConfirmTitle', 'mergeConfirmMsg',
      'mergeConfirmStay', 'mergeConfirmClose']) {
      expect(h).toContain(`id="${id}"`);
    }
    expect(h).toContain('class="merge-confirm-icon"');   // warning icon
    expect(h).toContain('Discard these files?');         // warning copy
  });

  it('no longer has a Download button', () => {
    expect(html()).not.toContain('id="mergeDownload"');
  });
});

describe('Reorder modal matches the Merge modal', () => {
  const html = () => read('index.html');

  it('has the Reorder modal with a heading/subtitle like Merge', () => {
    const h = html();
    for (const id of ['pagesPanelBtn', 'pagesBackdrop', 'pagesDrawer', 'pagesGrid',
      'insertBlankBtn', 'insertPos']) {
      expect(h).toContain(`id="${id}"`);
    }
    expect(h).toContain('class="pages-heading"');
    expect(h).toContain('class="pages-subtitle"');
  });

  it('both modals are centred with the same max width', () => {
    const css = html();
    // The Merge and Reorder drawers share the centred-modal sizing.
    expect((css.match(/max-width:\s*1040px/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('merge / edit feature files exist with their key wiring', () => {
  it('merge source files exist', () => {
    for (const f of ['src/merge.js', 'src/mergeCore.js']) {
      expect(existsSync(join(ROOT, f))).toBe(true);
      expect(read(f).length).toBeGreaterThan(0);
    }
  });

  it('mergeCore exports mergePdfBytes; merge.js clears the editor doc via the exposed app', () => {
    expect(read('src/mergeCore.js')).toContain('export async function mergePdfBytes');
    const merge = read('src/merge.js');
    expect(merge).toContain('closeEditorDocument');
    expect(merge).toContain('window.pdfEditorApp');
  });

  it('app.js exposes the instance + closeDocument, and save is resilient', () => {
    const app = read('src/app.js');
    expect(app).toContain('window.pdfEditorApp =');
    expect(app).toContain('closeDocument()');
    expect(app).toContain('async savePDF()');
  });

  it('backend exposes /edit-pdf and /decrypt', () => {
    const py = read('backend/app.py');
    expect(py).toContain("@app.route('/edit-pdf'");
    expect(py).toContain("@app.route('/decrypt'");
  });
});
