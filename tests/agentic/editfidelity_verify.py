#!/usr/bin/env python3
# Deep verifier for editfidelity_agent.cjs — proves the "edited line looks lighter in Chrome" fix.
# The save re-inserts text with one of three font paths, ALL of which must now embed a SIMPLE font (so
# Chrome/PDFium rasterises the edited line like the original, NOT the faint Type0/CIDFontType2 shift):
#   • reused embedded TrueType  → simple WinAnsi TrueType   (refname RS*)
#   • bundled clone .ttf/.otf    → simple WinAnsi Type1/TT   (refname WS*)   ← the LaTeX/non-reusable fix
#   • non-embedded Base-14       → simple WinAnsi Type1      (refname WF*, name-only)
# Per saved PDF this asserts:
#   0) ENGINE GUARD — the save actually went through the WASM tier (my RS/RF/WF/WS resource names are
#      present and the Python BACKEND's names (orig*/ed_*/lx_*) are ABSENT). Without this the whole suite
#      could silently pass on backend output (it did once — edit-fonts 404'd → WASM declined → backend).
#   1) every re-inserted font (RS/RF/WF/WS) on the edited page is SIMPLE (Subtype != Type0) — the fix;
#   2) text + any non-ASCII (smart quote) preserved, no stray '?' (encoding corruption);
#   3) every char the edited line draws is WinAnsi (cp1252) encodable;
#   4) (voe_ascii) the edited line's ink in Chrome matches the original line (no faint shift).
import json, os, re, sys, fitz

OUT = '/tmp/agent_out'
meta = json.load(open(os.path.join(OUT, 'editfidelity_meta.json')))
MARK = meta['mark']
passed = failed = 0
def check(c, label, extra=''):
    global passed, failed
    if c: passed += 1; print(f'  [PASS] {label}' + (f'  — {extra}' if extra else ''))
    else: failed += 1; print(f'  [FAIL] {label}' + (f'  — {extra}' if extra else ''))

WASM_PREFIX = ('RS', 'RF', 'WF', 'WS')          # my re-inserted font resource names
BACKEND_PREFIX = ('orig', 'ed_', 'lx_')         # PyMuPDF backend font resource names
def winansi_ok(ch):
    try: ch.encode('cp1252'); return True
    except Exception: return False
def edited_page(doc):
    for pg in doc:
        if MARK in pg.get_text(): return pg
    return doc[0]
def edited_spans(pg):
    for b in pg.get_text('dict')['blocks']:
        for l in b.get('lines', []):
            if MARK in ''.join(s['text'] for s in l.get('spans', [])): return l['spans']
    return None

print('=' * 74); print('EDIT-SAVE FONT FIDELITY — WASM simple-embed across every font path (no Type0)'); print('=' * 74)
for c in meta['cases']:
    print(f"\n## {c['id']} ({c['cat']})")
    if c.get('error'): check(False, f"{c['id']}: agent ran", c['error']); continue
    doc = fitz.open(os.path.join(OUT, c['saved']))
    pg = edited_page(doc)
    fonts = pg.get_fonts(full=True)                              # (xref,ext,type,basefont,refname,enc,...)
    mine = [f for f in fonts if (f[4] or '')[:2] in ('RS', 'RF', 'WF', 'WS')]
    backend = [f for f in fonts if any((f[4] or '').startswith(b) for b in BACKEND_PREFIX)]

    # 0) ENGINE GUARD — must be WASM output, never the backend fallback.
    check(not backend, f"{c['id']}: save went through the WASM tier (no backend orig*/ed_*/lx_ fonts)",
          'backend=' + ','.join(f[4] for f in backend) if backend else '')
    check(bool(mine), f"{c['id']}: edited page carries WASM re-inserted fonts (RS/RF/WF/WS)",
          ','.join(f"{f[4]}:{f[2]}" for f in mine))

    # 1) every re-inserted font is SIMPLE (not Type0) — these test lines are all WinAnsi-encodable.
    type0 = [f for f in mine if f[2] == 'Type0']
    check(not type0, f"{c['id']}: every re-inserted font is SIMPLE (not Type0) — the fix",
          ('Type0=' + ','.join(f"{f[4]}({f[3]})" for f in type0)) if type0 else ','.join(f"{f[4]}={f[2]}" for f in mine))

    # 2) text + non-ASCII preservation, no corruption.
    spans = edited_spans(pg)
    if not spans: check(False, f"{c['id']}: edited line (with marker) found"); continue
    txt = ''.join(s['text'] for s in spans)
    check(MARK in txt, f"{c['id']}: marker survived the save", repr(txt[:64]))
    check(c['word'] in txt, f"{c['id']}: original word '{c['word']}' preserved")
    if c.get('keep'):
        check(c['keep'] in txt, f"{c['id']}: non-ASCII '{c['keep']}' (U+{ord(c['keep']):04X}) preserved through the simple font")
    check('?' not in txt, f"{c['id']}: no stray '?' (no encoding corruption)", repr(txt))

    # 3) every char the edited line draws is WinAnsi-encodable (so simple WinAnsi is valid for it).
    bad = sorted({ch for ch in txt if not winansi_ok(ch)})
    check(not bad, f"{c['id']}: every char on the edited line is WinAnsi-encodable", f"bad={[hex(ord(x)) for x in bad]}")

    # 4) Chrome ink: the edited line must render with the same ink as the original (no faint Type0 shift).
    if c.get('chromeClip'):
        try:
            from PIL import Image
            def ink(p):
                im = Image.open(p).convert('L'); h = im.histogram(); return 100 * sum(h[:128]) / sum(h)
            o = ink(os.path.join(OUT, f"ef_{c['id']}_orig.png")); e = ink(os.path.join(OUT, f"ef_{c['id']}_edit.png"))
            check(abs(e - o) < 0.6, f"{c['id']}: Chrome ink of edited line matches original (no 'lighter')", f"orig={o:.2f}% edit={e:.2f}% Δ={e-o:+.2f}%")
        except Exception as ex:
            check(False, f"{c['id']}: Chrome ink compare ran", str(ex))

print('\n' + '=' * 74); print(f'  {passed}/{passed + failed} checks passed'); print('=' * 74)
sys.exit(0 if failed == 0 else 1)
