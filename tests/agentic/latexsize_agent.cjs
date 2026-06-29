// REAL-UI guard for "edited LaTeX line is SMALLER than the unchanged lines". LaTeX/Type1 fonts (Computer
// Modern) are drawn at a Tf the mupdf JS structured-text TRUNCATES (reports 10 for a real 10.909), so the
// re-inserted line came out ~9% too small next to its neighbours. detectSpan now takes the EFFECTIVE size
// from the per-char walk (matches fitz / the Tf), so the edited line matches.
// Edits the first SUMMARY line of the LaTeX résumé with SHORT text (no overflow scaling to confound the
// size), saves through the real app, then the verifier asserts the edited line's saved font size equals
// the unchanged summary lines' size (not ~9% smaller).
//   node tests/agentic/latexsize_agent.cjs   then   backend/venv/bin/python tests/agentic/latexsize_verify.py
const { launchBrowser } = require('./_launch.cjs');
const fs = require('fs'), path = require('path');
const OUT = '/tmp/agent_out', SITE = path.join(__dirname, '..', 'site');
const PDF = 'Ankana_Resume_SE.pdf';
const sleep = (p, ms) => p.waitForTimeout(ms);
const NEW = 'Software Engineer Pro';   // short → no overflow scaling
let passed = 0, failed = 0;
const check = (c, m, e = '') => { if (c) { passed++; console.log(`  [PASS] ${m}${e ? '  — ' + e : ''}`); } else { failed++; console.log(`  [FAIL] ${m}${e ? '  — ' + e : ''}`); } };

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const b = await launchBrowser({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1900 }, acceptDownloads: true });
  await ctx.addInitScript(() => { try { localStorage.setItem('qpe_tour_v2', '1'); } catch (e) {} });
  const page = await ctx.newPage();
  page.on('console', m => { if (/declined|WASM save/.test(m.text())) console.log('   note:', m.text()); });
  page.on('pageerror', e => console.log('PAGEERR', e.message));

  console.log(`\n## edit a Computer-Modern summary line in ${PDF}, save, check size vs neighbours`);
  await page.goto('http://localhost:9000', { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.pdfEditorApp, null, { timeout: 20000 });
  await page.setInputFiles('#fileInput', path.join(SITE, PDF));
  await page.waitForFunction(() => window.pdfEditorApp?.mode === 'auto' && document.querySelector('.editable-text-box'), null, { timeout: 60000 });
  await page.evaluate(() => { window.pdfEditorApp._restrictionConfirmed = true; }); await sleep(page, 700);

  const line = page.locator('.editable-text-box', { hasText: 'Software Engineer with' }).first();
  check(await line.count() > 0, 'found the CM summary line');
  await line.click({ force: true }); await sleep(page, 150);
  await line.evaluate(el => { el.focus(); const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await page.keyboard.press('Backspace'); await page.keyboard.type(NEW, { delay: 16 }); await sleep(page, 200);
  await page.evaluate(() => { const a = document.activeElement; if (a && a.blur) a.blur(); }); await sleep(page, 300);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.evaluate(() => window.pdfEditorApp.savePDF())]);
  const saved = path.join(OUT, 'latexsize.pdf'); await dl.saveAs(saved);
  check(fs.existsSync(saved), 'produced a saved PDF');
  fs.writeFileSync(path.join(OUT, 'latexsize_meta.json'), JSON.stringify({ saved: 'latexsize.pdf', editedWord: 'Software Engineer Pro' }, null, 2));
  await b.close();
  console.log(`\n=== SUMMARY (agent) ===\n  ${passed}/${passed + failed} checks passed  (deep checks: latexsize_verify.py)`);
  process.exit(failed ? 1 : 0);
})();
