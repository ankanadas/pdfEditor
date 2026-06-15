# Test fixtures — local only, NOT committed

The edit-fidelity regression tests in `../test_edit_pdf.py` use two real PDFs that
contain personal data, so the PDFs are **gitignored** (`backend/tests/fixtures/*.pdf`)
and must be supplied locally. Drop them in this folder with these exact names:

- **`voe_letter.pdf`** — an employment-verification letter whose embedded subset fonts
  keep a *full* character map but strip the actual glyph outlines. This reproduces the
  "typed `J` disappears" bug (the document contains no `J` anywhere).
- **`resume.pdf`** — a résumé set in Calibri / Calibri-Bold with `SymbolMT` bullets.
  Exercises document-font reuse and weight handling (a bold span must not force a whole
  edited line bold).

If a fixture is missing, the tests that need it **skip automatically** — the synthetic
tests (background preservation, erase, stray-character cleanup) always run.

Run the suite directly:

```
backend/venv/bin/python -m unittest discover -s backend/tests -p 'test_*.py'
```

It also runs automatically before `npm run build` (the build aborts if any test fails).
