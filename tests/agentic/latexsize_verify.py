#!/usr/bin/env python3
# Verify the edited Computer-Modern line is re-inserted at the SAME size as the unchanged summary lines
# (not ~9% smaller). The unchanged neighbours render at fitz size ≈ 10.909 (the real Tf); the edited line
# must match within a tight tolerance.
import json, os, sys, fitz

OUT = '/tmp/agent_out'
meta = json.load(open(os.path.join(OUT, 'latexsize_meta.json')))
doc = fitz.open(os.path.join(OUT, meta['saved']))
pg = doc[0]
passed = failed = 0
def check(c, label, extra=''):
    global passed, failed
    if c: passed += 1; print(f'  [PASS] {label}' + (f'  — {extra}' if extra else ''))
    else: failed += 1; print(f'  [FAIL] {label}' + (f'  — {extra}' if extra else ''))

def line_size(sub):
    for b in pg.get_text('dict')['blocks']:
        for l in b.get('lines', []):
            t = ''.join(s['text'] for s in l['spans'])
            if sub in t: return max(s['size'] for s in l['spans']), t.strip()
    return None, None

print('=' * 66); print('LaTeX/CM edited-line SIZE vs unchanged neighbours'); print('=' * 66)
edited, et = line_size(meta['editedWord'])
n1, t1 = line_size('Strong background')
n2, t2 = line_size('cloud-native')
check(edited is not None, 'edited line present in saved PDF')
check(n1 is not None and n2 is not None, 'unchanged neighbour lines present')
if edited and n1 and n2:
    nb = (n1 + n2) / 2
    print(f"   edited='{et[:40]}' size={edited:.3f}")
    print(f"   neighbour size ≈ {nb:.3f}  ({n1:.3f}, {n2:.3f})")
    check(abs(edited - nb) <= 0.3, 'edited line size matches the unchanged summary lines (not ~9% smaller)',
          f"edited={edited:.3f} vs neighbour={nb:.3f}  Δ={edited-nb:+.3f}")
    # it must NOT be the truncated 10.0 the bug produced
    check(edited > 10.4, 'edited line is the EFFECTIVE size (≈10.9), not the truncated 10.0', f"size={edited:.3f}")

print('\n' + '=' * 66); print(f'  {passed}/{passed + failed} checks passed'); print('=' * 66)
sys.exit(0 if failed == 0 else 1)
