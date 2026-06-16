# Test fixtures — local only, NOT committed

The edit-fidelity regression tests in `../test_edit_pdf.py` use a real PDF that
contains personal data, so PDFs here are **gitignored** (`backend/tests/fixtures/*.pdf`)
and must be supplied locally. Drop it in this folder with this exact name:

- **`resume.pdf`** — a résumé set in Calibri / Calibri-Bold with `SymbolMT` bullets.
  Exercises document-font reuse and weight handling (a bold span must not force a whole
  edited line bold), and that no characters are dropped.

If the fixture is missing, the tests that need it **skip automatically** — the synthetic
tests (background preservation, erase, stray-character cleanup, mixed per-run size/bold/
italic) always run.

Run the suite directly:

```
backend/venv/bin/python -m unittest discover -s backend/tests -p 'test_*.py'
```

It also runs automatically before `npm run build` (the build aborts if any test fails).
