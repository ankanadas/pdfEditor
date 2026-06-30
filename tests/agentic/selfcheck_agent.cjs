// SELF-CHECK harness — the page is its own oracle. For EVERY PDF under tests/site/ it applies the WHOLE
// editing feature surface (whole + PARTIAL edits: text / bold / italic / underline / size / colour / font;
// and adds: single-line, whole-styled, partial multi-run styled, MULTI-LINE), saves through the real app,
// reopens, and writes everything the verifier needs to judge INVARIANTS that need NO reference engine:
//   • unchanged lines stay byte+geometry identical          (bleed / scatter / placement / CTM flip)
//   • edited/added text re-embeds as a SIMPLE font          (the Chrome "lighter" Type0 shift)
//   • edited line keeps its size vs the original            (the LaTeX "smaller" shrink)
//   • added text is upright + lands where it was placed     (the residual-CTM upside-down flip)
//   • a multi-line add stays N lines on save+reopen         (the swallowed-first-Enter merge)
//   • a partial-styled run keeps its own colour+font        (partial-style collapse on reopen)
//   • the save went through WASM, not the backend           (the silent wrong-engine green)
// REPORT ONLY — never edits app source. Per-PDF and per-op are guarded so one bad PDF can't abort the run.
// Env: SELFCHECK_ONLY="VOE,Ankana" restricts to matching PDFs (used by the canary red/green proofs).
//   node tests/agentic/selfcheck_agent.cjs   then   backend/venv/bin/python tests/agentic/selfcheck_verify.py
const { launchBrowser } = require('./_launch.cjs');
const fs = require('fs'), path = require('path');
const OUT = '/tmp/agent_out/selfcheck', SITE = path.join(__dirname, '..', 'site');
const sleep = (p, ms) => p.waitForTimeout(ms);
const ONLY = (process.env.SELFCHECK_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
const EDIT_LIMIT = 30 * 1024 * 1024;

// ---- selection + style helpers (drive the real toolbar) ----
const selectAll = (page, sel) => page.evaluate((sel) => { const el = [...document.querySelectorAll(sel)].pop(); if (!el) return false; el.focus(); const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return true; }, sel);
const selectWord = (page, sel, word) => page.evaluate(([sel, word]) => { const el = [...document.querySelectorAll(sel)].find(e => (e.textContent || '').includes(word)) || [...document.querySelectorAll(sel)].pop(); if (!el) return false; el.focus(); const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n; while ((n = tw.nextNode())) { const i = n.textContent.indexOf(word); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + word.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return true; } } return false; }, [sel, word]);
const clickIf = async (page, id) => { try { if (await page.locator(id).count()) { await page.click(id, { timeout: 1500 }); await sleep(page, 120); } } catch (_) {} };
const setColor = async (page, hex) => { await clickIf(page, '#tt-color-btn'); await page.evaluate((h) => { const c = document.getElementById('tt-color-custom') || document.querySelector('#tt-color-pop input[type=color]'); if (c) { c.value = h; c.dispatchEvent(new Event('input', { bubbles: true })); } }, hex); await sleep(page, 200); };
const setFont = async (page, key) => { await clickIf(page, '#tt-font-btn'); try { await page.click(`#tt-font-pop .tt-font-opt[data-key="${key}"]`, { timeout: 1500 }); } catch (_) {} await sleep(page, 200); };
const setSize = async (page, n) => { try { for (let i = 0; i < 2; i++) { await page.fill('#tt-size', String(n)); await page.locator('#tt-size').dispatchEvent('input'); await page.locator('#tt-size').dispatchEvent('change'); await sleep(page, 250); } } catch (_) {} };

async function applyStyle(page, sel, picker, spec) {
  // picker: () => reselect (so a 2nd op after an innerHTML rebuild still has a selection)
  if (spec.bold) { await picker(); await clickIf(page, '#tt-bold'); }
  if (spec.italic) { await picker(); await clickIf(page, '#tt-italic'); }
  if (spec.underline) { await picker(); await clickIf(page, '#tt-underline'); }
  if (spec.color) { await picker(); await setColor(page, spec.color); }
  if (spec.font) { await picker(); await setFont(page, spec.font); }
  if (spec.size) { await picker(); await setSize(page, spec.size); }
}

async function load(page, file) {
  await page.goto('http://localhost:9000', { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.pdfEditorApp, null, { timeout: 25000 });
  await page.setInputFiles('#fileInput', file);
  // editable when a line box OR a pageView exists; large/view-only never gets editable boxes
  await page.waitForFunction(() => window.pdfEditorApp && (document.querySelector('.editable-text-box') || window.pdfEditorApp.pageViews?.[0]), null, { timeout: 90000 }).catch(() => {});
  await page.evaluate(() => { try { window.pdfEditorApp._restrictionConfirmed = true; } catch (_) {} });
  await sleep(page, 900);
}
// Find a screen point near (fx,fy) NOT covered by any existing line box, so the dynamic click model opens
// ADD (blank) rather than EDIT (existing text). Returns {x,y,fy} or null on a too-dense page.
// `clearFrac` = vertical clearance needed below the point (so a MULTI-line add doesn't overlap an existing
// line on its 2nd/3rd row → reopen would group them with that text and re-sample its colour). This keeps
// the invariants testing the feature, not the place-on-top-of-text edge case.
const findBlank = (page, fx, fy, clearFrac) => page.evaluate(([fx, fy, clearFrac]) => {
  const cr = window.pdfEditorApp.pageViews[0].canvas.getBoundingClientRect();
  const boxes = [...document.querySelectorAll('.editable-text-box')].map(b => b.getBoundingClientRect());
  const covered = (x, y) => boxes.some(r => x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4);
  // The whole intended text ROW must be clear (not just the click point): added text drawn from x extends
  // right, so if ANY existing box sits on that baseline it would share a line on reopen. Check the row at
  // y and every clearance row below across [x, x+0.45w].
  const rowBusy = (x, y) => boxes.some(r => y >= r.top - 4 && y <= r.bottom + 4 && r.right >= x - 4 && r.left <= x + cr.width * 0.45);
  const clear = (x, y) => { for (let t = 0; t <= clearFrac + 1e-9; t += 0.012) if (rowBusy(x, y + cr.height * t)) return false; return true; };
  const clamp = (v) => Math.min(0.92, Math.max(0.06, v));
  for (const dy of [0, .05, -.05, .1, -.1, .16, -.16, .22, -.22, .3, -.3, .38, -.38, .45, -.45]) {
    for (const dx of [0, .12, -.12, .25, -.25, .36, -.36, -.46, .46]) {
      const x = cr.left + cr.width * clamp(fx + dx), y = cr.top + cr.height * clamp(fy + dy);
      if (x >= cr.left && x <= cr.right && y >= cr.top && y <= cr.bottom && !covered(x, y) && clear(x, y)) return { x: Math.round(x), y: Math.round(y), fy: (y - cr.top) / cr.height };
    }
  }
  return null;
}, [fx, fy, clearFrac]);

// Returns the actual fy placed at, or null if no blank spot / the editor never opened (skip, don't error).
async function addText(page, fx, fy, lines, style, clearFrac = 0.02) {
  await page.evaluate(() => window.pdfEditorApp.pageViews[0].canvas.scrollIntoView({ block: 'center' })); await sleep(page, 250);
  const pt = await findBlank(page, fx, fy, clearFrac);
  if (!pt) return null;
  await page.mouse.click(pt.x, pt.y);
  try { await page.waitForSelector('.insert-editor', { timeout: 3500 }); } catch (_) { return null; }
  for (let i = 0; i < lines.length; i++) { if (i) await page.keyboard.press('Enter'); await page.keyboard.type(lines[i], { delay: 14 }); await sleep(page, 80); }
  await sleep(page, 150);
  if (style) await style();
  await page.evaluate(() => { const a = document.activeElement; if (a && a.blur) a.blur(); document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
  try { await page.waitForSelector('.insert-editor', { state: 'detached', timeout: 4000 }); } catch (_) {}
  await sleep(page, 300);
  return pt.fy;
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
  let pdfs = fs.readdirSync(SITE).filter(f => f.toLowerCase().endsWith('.pdf'));
  if (ONLY.length) pdfs = pdfs.filter(f => ONLY.some(o => f.includes(o)));
  const b = await launchBrowser({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1900 }, acceptDownloads: true });
  await ctx.addInitScript(() => { try { localStorage.setItem('qpe_tour_v2', '1'); } catch (e) {} });
  const page = await ctx.newPage();
  page.on('console', m => { if (/WASM save unavailable|declined/.test(m.text())) console.log('   ⚠', m.text()); });
  page.on('pageerror', e => console.log('   PAGEERR', e.message));
  const report = [];

  for (const pdf of pdfs) {
    const id = pdf.replace(/[^A-Za-z0-9]+/g, '_');
    const size = fs.statSync(path.join(SITE, pdf)).size;
    const rec = { pdf, id, ops: [], status: 'ok' };
    console.log(`\n## ${pdf}  (${(size / 1024 / 1024).toFixed(1)} MB)`);
    try {
      await load(page, path.join(SITE, pdf));
      const editable = await page.evaluate(() => [...document.querySelectorAll('.editable-text-box')].map(e => (e.textContent || '').trim()).filter(t => t.length >= 6));
      const viewOnly = size > EDIT_LIMIT || !(await page.evaluate(() => !!window.pdfEditorApp.pageViews?.[0]));
      rec.viewOnly = viewOnly; rec.nEditable = editable.length;

      // ---------- EDITS (need existing text) ----------
      if (editable.length >= 1) {
        // E1: whole-line replace + BOLD + size 17 + red  (whole style + size override)
        const oldA = editable[0];
        const newA = 'SCWHOLE bold red sized';
        const lA = page.locator('.editable-text-box', { hasText: oldA.slice(0, Math.min(12, oldA.length)) }).first();
        await lA.click({ force: true }); await sleep(page, 150);
        await selectAll(page, '.editable-text-box');
        await page.keyboard.press('Backspace'); await page.keyboard.type(newA, { delay: 14 }); await sleep(page, 150);
        // size override DOWN to 8 — small text never triggers overflow auto-scaling, so the saved size is
        // an unambiguous test of the override (an upward override is confounded by overflow scaling).
        await applyStyle(page, '.editable-text-box', () => selectAll(page, '.editable-text-box'), { bold: true, size: 8, color: '#cc0000' });
        await page.evaluate(() => { const a = document.activeElement; if (a && a.blur) a.blur(); }); await sleep(page, 250);
        rec.ops.push({ kind: 'edit-whole', oldText: oldA, newText: newA, marker: 'SCWHOLE', expect: { bold: true, size: 8, color: [204, 0, 0] } });
      }
      // Prefer a genuinely MULTI-word line so the "partial" edit styles only PART of it (a single-word line
      // would degenerate to a whole-line restyle).
      const multi = editable.find(t => t.trim().split(/\s+/).filter(w => w.length >= 3).length >= 2);
      if (multi) {
        // E2: partial — keep the text, restyle ONE word (italic+underline+blue). The edit must keep the size
        // the EDITOR shows for the line (its box size) — comparing to fitz's effective size is wrong, since
        // pdf.js may extract a transform-scaled line at a different nominal size than fitz reports.
        const oldB = multi;
        const w1 = oldB.trim().split(/\s+/).find(w => w.length >= 3);
        const lB = page.locator('.editable-text-box', { hasText: oldB.slice(0, Math.min(12, oldB.length)) }).first();
        await lB.click({ force: true }); await sleep(page, 150);
        const boxSizePt = await lB.evaluate((el, sc) => parseFloat(getComputedStyle(el).fontSize) / sc, await page.evaluate(() => window.pdfEditorApp.scale || 1));
        if (await selectWord(page, '.editable-text-box', w1)) {
          await applyStyle(page, '.editable-text-box', () => selectWord(page, '.editable-text-box', w1), { italic: true, underline: true, color: '#1144dd' });
        }
        await page.evaluate(() => { const a = document.activeElement; if (a && a.blur) a.blur(); }); await sleep(page, 250);
        rec.ops.push({ kind: 'edit-partial', oldText: oldB, keepText: true, styledWord: w1, boxSizePt, expect: { italic: true, color: [17, 68, 221] } });
      }

      // ---------- ADDS (work on blank/image/most PDFs; skip an op if the page is too dense to find blank) ----------
      if (!viewOnly) {
        // A1: single-line whole-styled (font montserrat + size 18 + bold + green)
        let fyA = await addText(page, 0.18, 0.16, ['SCADD whole styled'], async () => { await selectAll(page, '.insert-editor'); await applyStyle(page, '.insert-editor', () => selectAll(page, '.insert-editor'), { bold: true, size: 18, color: '#118822', font: 'montserrat' }); });
        if (fyA != null) rec.ops.push({ kind: 'add-whole', marker: 'SCADD', fy: fyA, expect: { bold: true, color: [17, 136, 34] } });

        // A2: partial multi-run — three words, each a DISTINCT colour + font
        let fyB = await addText(page, 0.18, 0.5, ['SCRED SCBLU SCGRN'], async () => {
          for (const [w, hex, fk] of [['SCRED', '#dd2222', 'times'], ['SCBLU', '#2233dd', 'comicsans'], ['SCGRN', '#119911', 'montserrat']]) {
            if (await selectWord(page, '.insert-editor', w)) { await setColor(page, hex); await selectWord(page, '.insert-editor', w); await setFont(page, fk); }
          }
        }, 0.03);
        if (fyB != null) rec.ops.push({ kind: 'add-partial', words: [['SCRED', [221, 34, 34]], ['SCBLU', [34, 51, 221]], ['SCGRN', [17, 153, 17]]], fy: fyB });

        // A3: MULTI-LINE add (3 lines) — needs vertical clearance so rows 2-3 don't land on existing text
        let fyC = await addText(page, 0.18, 0.78, ['SCLINE alpha', 'SCLINE beta', 'SCLINE gamma'], null, 0.07);
        if (fyC != null) rec.ops.push({ kind: 'add-multiline', tokens: ['SCLINE alpha', 'SCLINE beta', 'SCLINE gamma'], fy: fyC, lines: 3 });
      }

      if (!rec.ops.length) { rec.status = viewOnly ? 'view-only (no edit/add applicable)' : 'no editable text + add unavailable'; console.log('   (skipped:', rec.status, ')'); report.push(rec); continue; }

      // save
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 45000 }), page.evaluate(() => window.pdfEditorApp.savePDF())]);
      const saved = path.join(OUT, `${id}.pdf`); await dl.saveAs(saved); rec.saved = `${id}.pdf`;

      // reopen and capture the rebuilt editable boxes (text + screen rect) for round-trip invariants
      await load(page, saved);
      rec.reopen = await page.evaluate(() => [...document.querySelectorAll('.editable-text-box')].map(e => { const r = e.getBoundingClientRect(); return { t: (e.textContent || '').trim().slice(0, 60), top: Math.round(r.top), left: Math.round(r.left), color: getComputedStyle(e).color }; }));
      // per-word colour/font of the reopened partial-add line (distinct-style survival)
      rec.reopenPartial = await page.evaluate(() => { const box = [...document.querySelectorAll('.editable-text-box')].find(d => /SCRED/.test(d.textContent || '')); if (!box) return null; return ['SCRED', 'SCBLU', 'SCGRN'].map(w => { let el = null; box.querySelectorAll('*').forEach(e => { if ((e.textContent || '').trim() === w) el = e; }); const cs = el ? getComputedStyle(el) : getComputedStyle(box); return { w, color: cs.color, fam: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim() }; }); });
      console.log(`   saved + reopened (${rec.ops.length} ops, ${rec.reopen.length} boxes)`);
    } catch (e) { rec.status = 'ERROR: ' + e.message; console.log('   ERROR', e.message); }
    report.push(rec);
  }

  await b.close();
  fs.writeFileSync(path.join(OUT, 'selfcheck_meta.json'), JSON.stringify({ report }, null, 2));
  const done = report.filter(r => r.saved).length;
  console.log(`\n=== SUMMARY (agent) ===\n  ${pdfs.length} PDFs attempted, ${done} produced saved output (deep invariants: selfcheck_verify.py)`);
})();
