#!/usr/bin/env python3
# Verify the saved multi-line add has THREE distinct, vertically-stacked lines — not the merged
# "first line + second line on one row" the swallowed-first-Enter bug produced.
import json, os, sys, fitz

OUT = '/tmp/agent_out'
meta = json.load(open(os.path.join(OUT, 'multiline_meta.json')))
toks = meta['tokens']
doc = fitz.open(os.path.join(OUT, meta['saved']))
pg = doc[0]
passed = failed = 0
def check(c, label, extra=''):
    global passed, failed
    if c: passed += 1; print(f'  [PASS] {label}' + (f'  — {extra}' if extra else ''))
    else: failed += 1; print(f'  [FAIL] {label}' + (f'  — {extra}' if extra else ''))

# baseline y for each token's line
ys = {}
for b in pg.get_text('dict')['blocks']:
    for l in b.get('lines', []):
        t = ''.join(s['text'] for s in l['spans'])
        for tok in toks:
            if tok in t:
                ys.setdefault(tok, l['spans'][0].get('origin', [0, 0])[1])

print('=' * 64); print('MULTI-LINE ADD — three stacked lines, none merged'); print('=' * 64)
check(len(ys) == len(toks), 'all 3 line tokens found in the saved PDF', str({k: round(v, 1) for k, v in ys.items()}))
if len(ys) == len(toks):
    yv = [ys[t] for t in toks]
    # each line is on its OWN baseline (distinct), in order, ~lineHeight apart
    g1, g2 = yv[1] - yv[0], yv[2] - yv[1]
    check(g1 > 6 and g2 > 6, 'the 3 lines have distinct, increasing baselines (stacked, not merged)', f"baselines={[round(v,1) for v in yv]} gaps={g1:.1f},{g2:.1f}")
    # the bug merged line1+line2 onto ONE baseline → a single fitz line containing BOTH tokens
    merged = False
    for b in pg.get_text('dict')['blocks']:
        for l in b.get('lines', []):
            t = ''.join(s['text'] for s in l['spans'])
            if toks[0] in t and toks[1] in t: merged = True
    check(not merged, 'no two lines were merged onto a single row')

print('\n' + '=' * 64); print(f'  {passed}/{passed + failed} checks passed'); print('=' * 64)
sys.exit(0 if failed == 0 else 1)
