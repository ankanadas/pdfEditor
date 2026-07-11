# Quick PDF Editor

A fully client-side, in-browser PDF editor. It **edits, restyles, moves and removes the existing text**
of a PDF (not just overlays new content), fills forms, adds text/signatures/highlights, merges, splits,
rotates and reorders pages, removes watermarks, and runs **on-device OCR** to make scanned documents
searchable and editable — all in the browser, with nothing uploaded to a server.

## Features

- **Edit existing text**: change wording, font, size, weight, colour and position of the text already
  in the PDF; true text removal/replacement (not a white-box overlay), with the original fonts reused
  where possible and metric-matched substitutes otherwise
- **Add text, signatures & highlights**; fill AcroForm fields
- **OCR for scanned PDFs**: image-only pages are recognized on-device (self-hosted Tesseract.js, no
  CDN, works offline) into an interactive text layer you can select, search, edit, move and delete
- **Save as searchable PDF** and **export recognized text** (.txt / .rtf, headers & page numbers
  stripped) for scanned documents
- **Search & Replace** across the whole document (fuzzy matching), including large 1000+ page files
- **Pages**: merge, split (range or extract-all), rotate, reorder
- **Remove watermarks**
- **Big documents**: virtualized rendering edits up to 1500 pages without crashing the tab; tuned for
  iPad/Safari

## How It Works

Everything runs in the browser:

- **PDF.js** renders pages and extracts the text geometry that becomes the editable overlay
- **mupdf-wasm** performs true, faithful text edits/removal in-browser (with a **pdf-lib** cover-and-
  redraw fallback for offline / restricted PDFs)
- **Tesseract.js** (self-hosted, SIMD where available) does the OCR
- **Fabric.js** backs the annotation/signature layer

No backend, no upload — your files never leave your device.

## Installation

```bash
npm install
```

## Development

```bash
npm run dev      # webpack dev server on http://localhost:9000
```

## Build

```bash
npm run build    # production bundle + static assets into dist/
```

## Testing

```bash
npm test         # jest unit tests
```

Integration coverage also includes Playwright E2E specs (`tests/e2e/`) and an agentic browser suite
(`tests/agentic/`, run via `tests/agentic/run_all.sh`).

## Technology Stack

- **mupdf-wasm**: in-browser true PDF text editing
- **pdf-lib**: fallback PDF manipulation
- **PDF.js**: rendering + text-geometry extraction
- **Tesseract.js**: on-device OCR (self-hosted)
- **Fabric.js**: annotation/signature layer
- **Jest** + **Playwright**: testing
- **Webpack**: bundling
