// REAL-UI regression guard for "added text is upside-down / shrunk on save+reopen" — a PDF whose page
// content opens with a residual CTM (e.g. `0.75 0 0 -0.75 0 792 cm` — scale + vertical FLIP, never q/Q'd).
// Our appended text used to inherit that transform, so added text saved upside-down at 0.75× and the wrong
// place (Notice-LCA). The WASM tier now wraps the original content in a balanced q/Q, so added text lands
// in page space, upright and full-size — exactly like the PyMuPDF backend.
// Adds text on PAGE 2 in two table rows + one spot OUTSIDE the table, saves through the real app, then the
// verifier checks the saved PDF: every added word is upright (dir≈(1,0)) AND near where it was placed
// (top-down y, un-scaled x) — NOT mirrored to (pageH - y) or scaled to 0.75x.
//   node tests/agentic/addflip_agent.cjs   then   backend/venv/bin/python tests/agentic/addflip_verify.py
const { launchBrowser } = require('./_launch.cjs');
const fs = require('fs'), path = require('path');
const OUT = '/tmp/agent_out', SITE = path.join(__dirname, '..', 'site');
const PDF = 'Notice(LCA-14152)(2026.05).pdf';
const sleep = (p, ms) => p.waitForTimeout(ms);
let passed = 0, failed = 0;
const check = (c, m, e = '') => { if (c) { passed++; console.log(`  [PASS] ${m}${e ? '  — ' + e : ''}`); } else { failed++; console.log(`  [FAIL] ${m}${e ? '  — ' + e : ''}`); } };

// word, and the fraction down page-2 to click (top-down). Two in the table band, one below it.
// All three land on BLANK areas of page 2 (empty right table cells ≈0.40 down; the lower half is blank) so
// the dynamic click model opens ADD (not EDIT). Well separated so a later add can't hit an earlier box.
const SPOTS = [
  { w: 'FLIPROW1', fx: 0.70, fy: 0.40 },   // empty table cell
  { w: 'FLIPROW2', fx: 0.40, fy: 0.62 },   // blank below the table
  { w: 'FLIPOUT',  fx: 0.65, fy: 0.80 },   // blank lower
];

async function openInsertAt(page, fx, fy) {
  await page.evaluate(() => window.pdfEditorApp.pageViews[1].canvas.scrollIntoView({ block: 'center' }));
  await sleep(page, 250);
  const pt = await page.evaluate((f) => {
    const pv = window.pdfEditorApp.pageViews[1];           // PAGE 2
    const r = pv.canvas.getBoundingClientRect();
    return { x: Math.round(r.left + r.width * f.fx), y: Math.round(r.top + r.height * f.fy) };
  }, { fx, fy });
  await page.mouse.click(pt.x, pt.y);
  try { await page.waitForSelector('.insert-editor', { timeout: 3500 }); return true; } catch (_) { return false; }
}
async function addTextAt(page, w, fx, fy) {
  // The dynamic click model opens ADD only on a BLANK spot; if a spot happens to hit text (→ EDIT) or
  // races a re-render, nudge to a nearby blank spot and retry. Real placement, just robust.
  let ok = await openInsertAt(page, fx, fy);
  for (let i = 0; !ok && i < 3; i++) { await page.keyboard.press('Escape').catch(() => {}); await sleep(page, 200); ok = await openInsertAt(page, fx + 0.04 * (i + 1), fy + 0.02 * (i + 1)); }
  if (!ok) throw new Error('insert editor never opened near ' + fx + ',' + fy);
  await page.keyboard.type(w, { delay: 16 });
  await sleep(page, 150);
  // commit + ensure the editor is fully gone before the next add (else the next click edits THIS box)
  await page.evaluate(() => { const a = document.activeElement; if (a && a.blur) a.blur(); document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
  try { await page.waitForSelector('.insert-editor', { state: 'detached', timeout: 4000 }); } catch (_) {}
  await sleep(page, 350);
}

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const b = await launchBrowser({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1900 }, acceptDownloads: true });
  await ctx.addInitScript(() => { try { localStorage.setItem('qpe_tour_v2', '1'); } catch (e) {} });
  const page = await ctx.newPage();
  page.on('console', m => { if (/declined|WASM save/.test(m.text())) console.log('   note:', m.text()); });
  page.on('pageerror', e => console.log('PAGEERR', e.message));

  console.log(`\n## add text on PAGE 2 of ${PDF} (residual flip-CTM page), save, reopen`);
  await page.goto('http://localhost:9000', { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.pdfEditorApp, null, { timeout: 20000 });
  await page.setInputFiles('#fileInput', path.join(SITE, PDF));
  await page.waitForFunction(() => window.pdfEditorApp?.mode === 'auto' && window.pdfEditorApp.pageViews?.[1], null, { timeout: 60000 });
  await page.evaluate(() => { window.pdfEditorApp._restrictionConfirmed = true; }); await sleep(page, 600);
  // scroll page 2 into view so its canvas is interactable
  await page.evaluate(() => window.pdfEditorApp.pageViews[1].canvas.scrollIntoView({ block: 'center' })); await sleep(page, 400);

  const ph = await page.evaluate(() => { const pv = window.pdfEditorApp.pageViews[1]; return pv.viewport ? pv.viewport.height / (pv.viewport.scale || 1) : 792; });
  for (const s of SPOTS) {
    try { await addTextAt(page, s.w, s.fx, s.fy); check(true, `added "${s.w}" at ~${Math.round(s.fy * 100)}% down page 2`); }
    catch (e) { check(false, `added "${s.w}"`, e.message); }
  }
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.evaluate(() => window.pdfEditorApp.savePDF())]);
  const saved = path.join(OUT, 'addflip.pdf'); await dl.saveAs(saved);
  check(fs.existsSync(saved), 'produced a saved PDF');
  fs.writeFileSync(path.join(OUT, 'addflip_meta.json'), JSON.stringify({ saved: 'addflip.pdf', pageHeight: ph, spots: SPOTS }, null, 2));
  await b.close();
  console.log(`\n=== SUMMARY (agent) ===\n  ${passed}/${passed + failed} checks passed  (deep checks: addflip_verify.py)`);
  process.exit(failed ? 1 : 0);
})();
