// EDIT-SAVE FONT FIDELITY across the font-embedding categories that drive the save's font path (which is
// what "Word / Google Docs / LaTeX / Adobe" reduce to):
//   • embedded TrueType (Word/Google Docs)  → reuse re-embedded as a SIMPLE WinAnsi TrueType (the fix), so
//     Chrome/PDFium rasterises the edited line IDENTICALLY to the original (no faint "lighter" Type0 shift);
//   • Type1 / Computer-Modern (LaTeX, many Adobe) → not reusable → bundled clone (unchanged by the fix);
//   • non-embedded Base-14 (Helvetica/…)   → already a simple WinAnsi font (unchanged).
// This agent edits a real line in each (append a marker), saves, and renders the VOE line in Chromium for
// an ink-coverage check. Deep font-subtype / WinAnsi / text-preservation checks are in editfidelity_verify.py.
//   node tests/agentic/editfidelity_agent.cjs   then   backend/venv/bin/python tests/agentic/editfidelity_verify.py
const { launchBrowser } = require('./_launch.cjs');
const fs = require('fs'), path = require('path');
const OUT = '/tmp/agent_out', SITE = path.join(__dirname, '..', 'site');
const sleep = (p, ms) => p.waitForTimeout(ms);
let passed = 0, failed = 0;
const check = (c, m, e = '') => { if (c) { passed++; console.log(`  [PASS] ${m}${e ? '  — ' + e : ''}`); } else { failed++; console.log(`  [FAIL] ${m}${e ? '  — ' + e : ''}`); } };

const MARK = ' EDITZZ9';
const CASES = [
  { id: 'voe_ascii', pdf: 'VOE_Letter_SS.pdf', needle: 'Please reach out', cat: 'truetype', word: 'Please', chromeClip: { x: 120, y: 786, width: 760, height: 46 } },
  { id: 'voe_quote', pdf: 'VOE_Letter_SS.pdf', needle: 'annual salary', cat: 'truetype', word: 'since', keep: '’' },
  { id: 'resume_tt', pdf: 'resume.pdf', needle: 'North Carolina State', cat: 'truetype', word: 'North' },
  { id: 'latex_cm', pdf: 'Ankana_Resume_SE.pdf', needle: 'Software Engineer with', cat: 'bundled', word: 'Software' },
  { id: 'base14', pdf: 'Test.pdf', needle: 'Prepared for', cat: 'base14', word: 'Prepared' },
];

async function editAndSave(page, c) {
  await page.goto('http://localhost:9000', { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.pdfEditorApp, null, { timeout: 20000 });
  await page.setInputFiles('#fileInput', path.join(SITE, c.pdf));
  await page.waitForFunction(() => window.pdfEditorApp?.mode === 'auto' && document.querySelector('.editable-text-box'), null, { timeout: 60000 });
  await page.evaluate(() => { window.pdfEditorApp._restrictionConfirmed = true; }); await sleep(page, 700);
  const line = page.locator('.editable-text-box', { hasText: c.needle }).first();
  await line.click({ force: true }); await sleep(page, 150);
  await line.evaluate(el => { el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await page.keyboard.type(MARK, { delay: 16 }); await sleep(page, 200);
  await page.evaluate(() => { const a = document.activeElement; if (a && a.blur) a.blur(); }); await sleep(page, 300);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.evaluate(() => window.pdfEditorApp.savePDF())]);
  const f = path.join(OUT, `ef_${c.id}.pdf`); await dl.saveAs(f); return f;
}
async function shotPdfLine(b, file, clip, outPng) {
  const ctx = await b.newContext({ viewport: { width: 1000, height: 1400 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto('file://' + file + '#zoom=150', { waitUntil: 'load' }); await page.waitForTimeout(3500);
  await page.screenshot({ path: outPng, clip });
  await ctx.close();
}

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const b = await launchBrowser({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1800 }, acceptDownloads: true });
  await ctx.addInitScript(() => { try { localStorage.setItem('qpe_tour_v2', '1'); } catch (e) {} });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('PAGEERR', e.message));
  const meta = [];
  for (const c of CASES) {
    console.log(`\n## ${c.id} (${c.cat}): edit "${c.needle}" in ${c.pdf}`);
    let saved;
    try { saved = await editAndSave(page, c); } catch (e) { check(false, `${c.id}: edit+save ran`, e.message); meta.push({ ...c, error: e.message }); continue; }
    check(fs.existsSync(saved), `${c.id}: produced a saved PDF`, '');
    meta.push({ ...c, saved: `ef_${c.id}.pdf` });
    // Chrome ink-coverage check for the primary TrueType case: edited line must match the original line.
    if (c.chromeClip) {
      await shotPdfLine(b, path.join(SITE, c.pdf), c.chromeClip, path.join(OUT, `ef_${c.id}_orig.png`));
      await shotPdfLine(b, saved, c.chromeClip, path.join(OUT, `ef_${c.id}_edit.png`));
      console.log(`   rendered Chrome crops for ${c.id} (ink compared in verifier)`);
    }
  }
  await b.close();
  fs.writeFileSync(path.join(OUT, 'editfidelity_meta.json'), JSON.stringify({ mark: MARK.trim(), cases: meta }, null, 2));
  console.log(`\n=== SUMMARY (agent) ===\n  ${passed}/${passed + failed} checks passed  (deep checks: editfidelity_verify.py)`);
  process.exit(failed ? 1 : 0);
})();
