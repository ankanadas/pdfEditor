# Architecture

A **browser-based PDF editor**. You open a PDF, edit/annotate it entirely in the
browser, and download the result. The core editor is **100% client-side** — no
server is required to run it. A small Python backend exists but is legacy/optional
(see below).

## High-level flow

```
            ┌─────────────────────────────────────────────┐
 Open PDF → │  PDF.js  renders each page to a <canvas>     │  ← what you SEE
            │  PDF.js  extracts text + positions per page  │  ← enables inline edit
            └─────────────────────────────────────────────┘
                              │  user edits (text / signature / erase)
                              ▼
            ┌─────────────────────────────────────────────┐
 Save PDF ← │  pdf-lib  re-writes the original PDF,        │  ← what you DOWNLOAD
            │  overlaying text/signatures + white-out rects│
            └─────────────────────────────────────────────┘
```

Two libraries do the heavy lifting:

- **PDF.js** (`pdfjs-dist`) — renders the real PDF visually and extracts text
  items with coordinates (so existing lines can be edited in place).
- **pdf-lib** — loads the original bytes and produces the edited PDF on save.

## Build & run

- **Bundler:** Webpack ([webpack.config.cjs](webpack.config.cjs)).
  - Entry: [src/app.js](src/app.js) → `dist/bundle.js`.
  - `HtmlWebpackPlugin` uses [index.html](index.html) as the template → `dist/index.html`.
  - PDF.js worker is emitted as a separate hashed `.js` asset.
- **Output:** `dist/` is **gitignored** — it is built locally, not committed.
  `npm run build` runs webpack (production) **and** copies `robots.txt` + `sitemap.xml`
  into `dist/`.
- **Dev:** `npm run dev` → webpack-dev-server on **port 9000**.
- **Deploy:** static hosting (Netlify). Upload the **contents of `dist/`**;
  publish directory = `dist`.

## Frontend structure (`src/`)

The live code path is **`app.js` → `core/EditorController.js` → its managers**:

| File | Role |
|------|------|
| [src/app.js](src/app.js) | **Main app** (`PDFEditorApp`, ~1.6k lines). Owns the UI: per-page canvas rendering, inline editable text boxes, the Draw/Type/Image signature dialog, erase-drag, undo/redo, and the `savePDF()` flow (white-out rects + overlays via pdf-lib). |
| [src/core/EditorController.js](src/core/EditorController.js) | Coordinates the document + editors below. |
| [src/core/PDFDocumentManager.js](src/core/PDFDocumentManager.js) | Loads/holds the PDF document. |
| [src/core/TextEditor.js](src/core/TextEditor.js) | Text-edit model. |
| [src/core/SignatureEditor.js](src/core/SignatureEditor.js) | Signature model. |
| [src/errors/PDFEditorError.js](src/errors/PDFEditorError.js) | Typed errors / error codes. |

**Legacy / not in the live bundle:** `src/app-v2.js`, `src/index.js`,
`src/core/ImageBasedPDFEditor.js`, `src/services/pdfBackendService.js` (the old
backend client). Kept for history; not imported by the current entry point.

### Rendering model (current)

All pages are rendered as **one `<canvas>` per page, stacked vertically and
scrolled** inside the stage (`#canvasContainer`). Each page has an overlay
`.page-wrap` for editable text boxes and signatures. Prev/Next still exist but
just scroll to a page. (Earlier versions showed a single page with Prev/Next nav.)

## Features

- **Open** — button or drag & drop; up to **100 MB** (`MAX_FILE_MB` in `app.js`).
- **Edit (inline)** — click an existing line and retype; PDF.js text positions
  drive the editable boxes. On save the original is white-boxed and the new text
  drawn over it.
- **Add text** — type with font/bold/italic, click the page to place.
- **Signature** — a Draw / Type / Image dialog: draw with mouse/trackpad, type in
  a cursive font, or upload an image; then drag into place.
- **Erase** — drag a box to white-out anything (e.g. an old signature).
- **Undo / redo**, movable signatures.
- **Save** — `savePDF()` rebuilds the PDF with pdf-lib and downloads it.
- **SEO** — `robots.txt`, `sitemap.xml`, Search Console verification (public site).

## Backend (legacy/optional)

[backend/app.py](backend/app.py) — Flask + **PyMuPDF** (`fitz`), endpoints:
`/health`, `/extract-text`, `/edit-pdf`, `/clear-signature`. Originally did
server-side text extraction/editing. Commit `01fd890` moved the editor fully
client-side, so the backend is **not needed** for normal use and is kept for
reference. Its virtualenv (`backend/venv/`) is gitignored.

### The historical hard problem

[CURRENT_STATUS.md](CURRENT_STATUS.md) documents the long-standing pain:
**covering original text when editing it.** Coordinate-system mismatches between
PyMuPDF (origin bottom-left) and canvas (origin top-left) caused duplicated /
mis-placed text in saved PDFs. The client-side approach (pdf-lib white-out rects +
the erase tool) is how this is worked around today.

## Tooling

- **Tests:** Jest (+ `fast-check` property tests) — `npm test`. Config in
  [jest.config.js](jest.config.js).
- **Transpile:** Babel (`@babel/preset-env`), [.babelrc](.babelrc).
- **Node:** see [.nvmrc](.nvmrc).
