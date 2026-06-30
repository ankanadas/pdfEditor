#!/usr/bin/env python3
# Verify the saved addflip.pdf: every added word on page 2 is UPRIGHT and placed in page space (top-down),
# NOT inheriting the page's residual flip/scale CTM (which would render it upside-down at 0.75x, mirrored
# to pageH - y). For each added word assert: it exists in the text layer, its writing direction is ~(1,0)
# (upright), and its top-y sits in the same vertical HALF of the page where it was placed (a vertical FLIP
# would mirror a top placement to the bottom).
import json, os, sys, fitz

OUT = '/tmp/agent_out'
meta = json.load(open(os.path.join(OUT, 'addflip_meta.json')))
doc = fitz.open(os.path.join(OUT, meta['saved']))
pg = doc[1]
H = pg.rect.height
passed = failed = 0
def check(c, label, extra=''):
    global passed, failed
    if c: passed += 1; print(f'  [PASS] {label}' + (f'  — {extra}' if extra else ''))
    else: failed += 1; print(f'  [FAIL] {label}' + (f'  — {extra}' if extra else ''))

def find_line(word):
    for b in pg.get_text('dict')['blocks']:
        for l in b.get('lines', []):
            t = ''.join(s['text'] for s in l['spans'])
            if word in t: return l
    return None

print('=' * 70); print('ADD-TEXT ORIENTATION on a residual-CTM page (Notice-LCA) — no flip/scale'); print('=' * 70)
for sp in meta['spots']:
    w = sp['w']
    l = find_line(w)
    if not l:
        check(False, f"{w}: present in saved page-2 text layer"); continue
    d = l['dir']; bb = l['bbox']
    topfrac = bb[1] / H
    # 1) upright: direction vector ~ (1, 0)  (a vertical flip would give dir ~ (1, 0) too in some readers,
    #    so we ALSO assert the y placement isn't mirrored below).
    check(abs(d[0] - 1.0) < 0.05 and abs(d[1]) < 0.05, f"{w}: upright (writing dir ≈ (1,0))", f"dir={d}")
    # 2) placed in the SAME vertical half it was clicked (top-down), not mirrored to pageH - y.
    placed_top = sp['fy'] < 0.5
    landed_top = topfrac < 0.5
    check(placed_top == landed_top,
          f"{w}: landed in the {'top' if placed_top else 'bottom'} half where it was placed (not flipped)",
          f"placed≈{sp['fy']:.2f} down, landed≈{topfrac:.2f} down")
    # 3) not shrunk by a residual 0.75 scale — the box should be a normal ~12pt height, not ~9.
    h = bb[3] - bb[1]
    check(h > 9.5, f"{w}: full-size (not scaled down by a residual CTM)", f"box height={h:.1f}pt")

print('\n' + '=' * 70); print(f'  {passed}/{passed + failed} checks passed'); print('=' * 70)
sys.exit(0 if failed == 0 else 1)
