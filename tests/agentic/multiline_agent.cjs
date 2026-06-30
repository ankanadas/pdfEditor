// REAL-UI guard for "multi-line added text loses its FIRST line break → lines merge". Pressing Enter at
// the END of the first line left a bogus trailing <br> with no focusable node on the new line (insertNode
// split the text node and left an empty remainder), so the next char collapsed back into line 1 — the
// block saved/reopened with lines 1 and 2 merged onto one row ("the second line shows in a different
// place"). Now every Enter anchors a fresh line.
// Types a 3-line add-text (Enter between each), saves through the real app, and the verifier asserts the
// saved PDF has THREE distinct, vertically-stacked lines (not merged) — and the same after reopen.
//   node tests/agentic/multiline_agent.cjs   then   backend/venv/bin/python tests/agentic/multiline_verify.py
const { launchBrowser } = require('./_launch.cjs');
const fs = require('fs'), path = require('path');
const OUT = '/tmp/agent_out', SITE = path.join(__dirname, '..', 'site');
const sleep = (p, ms) => p.waitForTimeout(ms);
let passed = 0, failed = 0;
const check = (c, m, e = '') => { if (c) { passed++; console.log(`  [PASS] ${m}${e ? '  — ' + e : ''}`); } else { failed++; console.log(`  [FAIL] ${m}${e ? '  — ' + e : ''}`); } };
const LINES = ['LINEALPHA one', 'LINEBETA two', 'LINEGAMMA three'];

async function reopenLines(page, saved) {
  await page.goto('http://localhost:9000', { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.pdfEditorApp, null, { timeout: 20000 });
  await page.setInputFiles('#fileInput', saved);
  await page.waitForFunction(() => window.pdfEditorApp?.mode === 'auto' && document.querySelector('.editable-text-box'), null, { timeout: 60000 });
  await sleep(page, 900);
  return page.evaluate((tokens) => {
    const boxes = [...document.querySelectorAll('.editable-text-box')];
    return tokens.map(tok => { const el = boxes.find(b => (b.textContent || '').includes(tok)); return el ? { tok, top: Math.round(el.getBoundingClientRect().top) } : { tok, top: null }; });
  }, LINES.map(l => l.split(' ')[0]));
}

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const b = await launchBrowser({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 1600 }, acceptDownloads: true });
  await ctx.addInitScript(() => { try { localStorage.setItem('qpe_tour_v2', '1'); } catch (e) {} });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('PAGEERR', e.message));

  console.log('\n## add a 3-line text (Enter between lines), save, reopen');
  await page.goto('http://localhost:9000', { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.pdfEditorApp, null, { timeout: 20000 });
  await page.setInputFiles('#fileInput', path.join(SITE, '14_blank_page_for_add_text.pdf'));
  await page.waitForFunction(() => window.pdfEditorApp?.mode === 'auto' && window.pdfEditorApp.pageViews?.[0], null, { timeout: 60000 });
  await page.evaluate(() => { window.pdfEditorApp._restrictionConfirmed = true; }); await sleep(page, 500);
  const pt = await page.evaluate(() => { const pv = window.pdfEditorApp.pageViews[0], r = pv.canvas.getBoundingClientRect(); return { x: Math.round(r.left + r.width * 0.35), y: Math.round(r.top + r.height * 0.35) }; });
  await page.mouse.click(pt.x, pt.y); await page.waitForSelector('.insert-editor', { timeout: 5000 });
  for (let i = 0; i < LINES.length; i++) { if (i) await page.keyboard.press('Enter'); await page.keyboard.type(LINES[i], { delay: 16 }); await sleep(page, 120); }
  await sleep(page, 200);
  const html = await page.evaluate(() => document.querySelector('.insert-editor').innerHTML);
  // editor must hold 3 lines (2 <br>), not the merged "first<br>third"
  check((html.match(/<br>/g) || []).length === LINES.length - 1, `editor has ${LINES.length - 1} line breaks (first Enter not swallowed)`, `${(html.match(/<br>/g) || []).length} <br>`);
  await page.evaluate(() => { const a = document.activeElement; if (a && a.blur) a.blur(); document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); }); await sleep(page, 350);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.evaluate(() => window.pdfEditorApp.savePDF())]);
  const saved = path.join(OUT, 'multiline.pdf'); await dl.saveAs(saved);
  check(fs.existsSync(saved), 'produced a saved PDF');

  const re = await reopenLines(page, saved);
  console.log('   reopen tops:', JSON.stringify(re));
  const tops = re.map(r => r.top);
  check(tops.every(t => t != null), 'all 3 lines present as separate editable boxes after reopen', JSON.stringify(re.map(r => r.tok)));
  if (tops.every(t => t != null)) {
    const d1 = tops[1] - tops[0], d2 = tops[2] - tops[1];
    check(d1 > 8 && d2 > 8, 'the 3 reopened lines are vertically STACKED (not merged onto one row)', `gaps=${d1},${d2}px`);
  }
  fs.writeFileSync(path.join(OUT, 'multiline_meta.json'), JSON.stringify({ saved: 'multiline.pdf', tokens: LINES.map(l => l.split(' ')[0]) }, null, 2));
  await b.close();
  console.log(`\n=== SUMMARY (agent) ===\n  ${passed}/${passed + failed} checks passed  (deep checks: multiline_verify.py)`);
  process.exit(failed ? 1 : 0);
})();
