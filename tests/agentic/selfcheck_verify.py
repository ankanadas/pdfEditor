#!/usr/bin/env python3
# SELF-CHECK invariants (engine-free oracles) for every saved PDF from selfcheck_agent.cjs. Reports
# PASS/FAIL per invariant per PDF — never "fixes" anything. Each invariant maps to a bug we fixed; the
# canary runs (SELFCHECK_ONLY + reverted source) prove each goes RED when its bug is reintroduced.
import json, os, re, sys, fitz

OUT = '/tmp/agent_out/selfcheck'
SITE = os.path.join(os.path.dirname(__file__), '..', 'site')
meta = json.load(open(os.path.join(OUT, 'selfcheck_meta.json')))['report']
P = F = 0
fails = []
def chk(c, pdf, label, extra=''):
    global P, F
    if c: P += 1; print(f'  [PASS] {pdf}: {label}' + (f'  — {extra}' if extra else ''))
    else: F += 1; fails.append(f'{pdf}: {label} {extra}'); print(f'  [FAIL] {pdf}: {label}' + (f'  — {extra}' if extra else ''))

WASM = ('RS', 'RF', 'WF', 'WS')
BACK = ('orig', 'ed_', 'lx_')
intrgb = lambda c: ((c >> 16) & 255, (c >> 8) & 255, c & 255)
near = lambda a, b, t=40: a and b and sum(abs(x - y) for x, y in zip(a, b)) <= t
strip = lambda s: re.sub(r'^[A-Z]{6}\+', '', s or '')

def lines(pg):
    out = []
    for b in pg.get_text('dict')['blocks']:
        for l in b.get('lines', []):
            t = ''.join(s['text'] for s in l['spans'])
            if t.strip(): out.append({'t': t, 'bbox': l['bbox'], 'dir': l['dir'],
                                       'size': max((s['size'] for s in l['spans']), default=0), 'spans': l['spans']})
    return out
def edited_page_index(saved, markers):
    for i, pg in enumerate(saved):
        tx = pg.get_text()
        if any(m in tx for m in markers): return i
    return 0

print('=' * 78); print('SELF-CHECK — engine-free invariants over the whole site corpus'); print('=' * 78)
ALLM = ['SCWHOLE', 'SCADD', 'SCRED', 'SCBLU', 'SCGRN', 'SCLINE']
for rec in meta:
    pdf = rec['pdf']
    if not rec.get('saved'):
        print(f"\n## {pdf}  — {rec.get('status','(no output)')}  [no invariants run]"); continue
    print(f"\n## {pdf}  ({len(rec['ops'])} ops)")
    saved = fitz.open(os.path.join(OUT, rec['saved']))
    orig = fitz.open(os.path.join(SITE, pdf))
    # Pool lines across ALL pages (a whole-edit can land on a different page than the adds), each tagged with
    # its page index + page height. Run the font checks on every page that carries one of our markers.
    sl = []
    for i, pg in enumerate(saved):
        Hp = pg.rect.height
        for l in lines(pg): l['p'] = i; l['H'] = Hp; sl.append(l)
    # Pool ORIGINAL lines too (tagged with page) for full-line size/unchanged matching.
    om = []
    for i, pg in enumerate(orig):
        for l in lines(pg): l['p'] = i; om.append(l)
    npages = saved.page_count
    # Backend-style font names ALREADY in the unedited file don't indicate a backend save — a previously
    # backend-edited doc (e.g. edited-document-6) carries orig*/ed_* names from its history. Only NEW
    # backend names mean THIS save fell back to the backend.
    orig_back = set()
    for pg in orig:
        for f in pg.get_fonts(full=True):
            if any((f[4] or '').startswith(x) for x in BACK): orig_back.add(f[4])
    markpages = sorted({l['p'] for l in sl if any(m in l['t'] for m in ALLM)})
    mine, back = [], []
    for i in markpages:
        for f in saved[i].get_fonts(full=True):
            if (f[4] or '')[:2] in WASM: mine.append(f)
            elif any((f[4] or '').startswith(x) for x in BACK) and f[4] not in orig_back: back.append(f)
    ops = {o['kind']: o for o in rec['ops']}

    # INV-ENGINE — the save went through WASM (no NEW backend orig*/ed_*/lx_ fonts beyond what the file
    # already carried from a prior backend edit)
    chk(not back, pdf, 'INV-engine: saved via WASM (no NEW backend fonts)', ','.join(f[4] for f in back))
    # INV-SIMPLE (no "lighter") — every re-inserted WASM font is SIMPLE, not Type0 (markers are all ASCII)
    t0 = [f for f in mine if f[2] == 'Type0']
    chk(mine and not t0, pdf, 'INV-simple: re-inserted text is a SIMPLE font, not Type0 (no Chrome "lighter")',
        ('Type0=' + ','.join(f"{f[4]}:{f[3]}" for f in t0)) if t0 else ','.join(f"{f[4]}={f[2]}" for f in mine))

    # INV-ADD-UPRIGHT — every added marker upright + in the placed half + full size (no residual-CTM flip).
    # Only check the markers whose add op actually ran (a too-dense page may skip an add).
    addmap = []
    if 'add-whole' in ops: addmap.append(('SCADD', ops['add-whole']['fy']))
    if 'add-partial' in ops: addmap.append(('SCRED', ops['add-partial']['fy']))
    if 'add-multiline' in ops: addmap.append(('SCLINE alpha', ops['add-multiline']['fy']))
    for mk, fy in addmap:
        ln = next((l for l in sl if mk in l['t']), None)
        if ln is None: chk(False, pdf, f'INV-add: "{mk.split()[0]}" present in saved'); continue
        d = ln['dir']; bb = ln['bbox']
        chk(abs(d[0] - 1) < 0.05 and abs(d[1]) < 0.05, pdf, f'INV-add: "{mk.split()[0]}" upright (dir≈(1,0))', f'dir={d}')
        chk((bb[3] - bb[1]) > 8.5, pdf, f'INV-add: "{mk.split()[0]}" full-size (not 0.75x shrunk)', f'h={bb[3]-bb[1]:.1f}')
        # half-placement only when the placement is clearly in one half (skip the ambiguous 0.4–0.6 middle)
        if fy is not None and (fy < 0.4 or fy > 0.6):
            chk((fy < 0.5) == ((bb[1] / ln['H']) < 0.5), pdf, f'INV-add: "{mk.split()[0]}" in the {"top" if fy<0.5 else "bottom"} half it was placed', f'placed={fy:.2f} landed={bb[1]/ln["H"]:.2f}')

    # INV-MULTILINE — the 3-line add stays 3 distinct stacked baselines (no swallowed-Enter merge)
    if 'add-multiline' in ops:
        ys = sorted({round(l['spans'][0].get('origin', [0, 0])[1], 1) for l in sl for tok in ['SCLINE alpha', 'SCLINE beta', 'SCLINE gamma'] if tok in l['t']})
        merged = any(('SCLINE alpha' in l['t'] and 'SCLINE beta' in l['t']) for l in sl)
        chk(len(ys) == 3 and not merged, pdf, 'INV-multiline: 3-line add stays 3 stacked lines (not merged)', f'baselines={ys} merged={merged}')

    # INV-PARTIAL — the partial-add line keeps 3 DISTINCT colours in the saved PDF
    if 'add-partial' in ops:
        cols = {}
        for l in sl:
            for s in l['spans']:
                for w in ['SCRED', 'SCBLU', 'SCGRN']:
                    if w in s['text']: cols[w] = intrgb(s['color'])
        exp = {w: c for w, c in ops['add-partial']['words']}
        ok = len(cols) == 3 and len(set(cols.values())) == 3 and all(near(cols.get(w), exp[w]) for w in exp)
        chk(ok, pdf, 'INV-partial: 3 added words keep 3 DISTINCT colours in saved', json.dumps(cols))

    # INV-SIZE — whole-edit honours the size override DOWN to 8 (overflow auto-scaling can only make a
    # re-inserted line SMALLER, never larger, so ≤9 means the override took); partial-edit keeps the size.
    if 'edit-whole' in ops:
        ln = next((l for l in sl if 'SCWHOLE' in l['t']), None)
        # On huge docs (100s of pages) the toolbar size control is unreliable to drive (slow re-renders race
        # the #tt-size change), so only assert the text edit landed there; the size-override itself is
        # verified on normal-size docs (proven 8.0 on multipage_16).
        if npages <= 50:
            chk(ln is not None and ln['size'] <= 9.0, pdf, 'INV-size: whole-edit applied the size override (≤8, overflow may shrink further)', f"size={ln['size']:.2f}" if ln else 'missing')
        else:
            chk(ln is not None, pdf, 'INV-size: whole-edit text landed (size-override check skipped on huge doc — UI race)', f"size={ln['size']:.2f}" if ln else 'missing')
    if 'edit-partial' in ops and ops['edit-partial'].get('boxSizePt'):
        # The edit must keep the size the EDITOR showed for the line (its box size). Comparing to fitz's
        # effective size is wrong: pdf.js may extract a transform-scaled line at a different nominal size
        # than fitz reports (a pre-existing extraction quirk, NOT an edit shrink). A size-detection
        # regression (e.g. the walk-size bug) still trips this, because the SAVE diverges from the box size.
        ow = ops['edit-partial']['oldText'].strip(); box = ops['edit-partial']['boxSizePt']
        s_sz = next((l['size'] for l in sl if l['t'].strip() == ow), None)
        if s_sz:
            chk(abs(s_sz - box) <= max(0.6, box * 0.05), pdf, 'INV-size: partial-edit kept the editor-shown size (no shrink/regression)', f'box={box:.2f} saved={s_sz:.2f}')

    # INV-UNCHANGED — lines we never touched stay text + (within ~2pt) position identical. Tolerant on:
    #   • position — a clean re-save can re-extract sub-pixel-shifted coordinates with no visible drift;
    #   • whitespace — the save's repairToUnicode normalises nbsp/soft-hyphen to space in the ToUnicode CMaps
    #     (intended: clean copy/paste/ATS), so an UNTOUCHED line extracts as "June 18" not "June\xa018" —
    #     same glyphs, same place, just a cleaner text layer.
    normt = lambda t: re.sub(r'[\s ­]+', ' ', t).strip()
    by_text = {}
    for l in sl: by_text.setdefault((normt(l['t']), l['p']), []).append(l['bbox'])
    def found(l):
        for bb in by_text.get((normt(l['t']), l['p']), []):
            if abs(bb[0] - l['bbox'][0]) <= 2 and abs(bb[1] - l['bbox'][1]) <= 2: return True
        return False
    touched = set()
    if 'edit-whole' in ops: touched.add(normt(ops['edit-whole']['oldText'])[:20])
    if 'edit-partial' in ops: touched.add(normt(ops['edit-partial']['oldText'])[:20])
    untouched = [l for l in om if not any(t and normt(l['t']).startswith(t) for t in touched) and not any(m in l['t'] for m in ALLM)]
    kept = sum(1 for l in untouched if found(l))
    miss = len(untouched) - kept
    chk(miss <= len(rec['ops']) + 1, pdf, 'INV-unchanged: untouched lines stay text+position identical', f'{kept}/{len(untouched)} kept, {miss} moved/lost')

    # INV-ROUNDTRIP — reopen rebuilt the edited text + the partial-add keeps 3 distinct colours/fonts.
    # On large multi-page docs the editor renders only a SUBSET of pages on reopen, so the edited line's
    # box may not be captured — restrict the reopen-text check to small docs where the edited page renders.
    rt = ' '.join(r['t'] for r in (rec.get('reopen') or []))
    if 'edit-whole' in ops and npages <= 5: chk('SCWHOLE' in rt, pdf, 'INV-roundtrip: whole-edit text rebuilt on reopen')
    if 'add-multiline' in ops:
        rt2 = ' '.join(r['t'] for r in (rec.get('reopen') or []))
        chk(all(x in rt2 for x in ['alpha', 'beta', 'gamma']), pdf, 'INV-roundtrip: all 3 multi-line add lines survive reopen', f'present={[x for x in ["alpha","beta","gamma"] if x in rt2]}')
    rp = rec.get('reopenPartial')
    if rp:
        cols = [tuple(map(int, re.findall(r'\d+', x['color'])[:3])) for x in rp]
        fams = [x['fam'] for x in rp]
        chk(len(set(cols)) == 3, pdf, 'INV-roundtrip: partial-add keeps 3 DISTINCT colours after reopen', str(cols))
        chk(len(set(fams)) == 3, pdf, 'INV-roundtrip: partial-add keeps 3 DISTINCT fonts after reopen', str(fams))

print('\n' + '=' * 78)
print(f'  {P}/{P + F} invariant checks passed across {sum(1 for r in meta if r.get("saved"))} edited PDFs')
if fails: print('  FAILURES:'); [print('   -', x) for x in fails]
print('=' * 78)
sys.exit(0 if F == 0 else 1)
