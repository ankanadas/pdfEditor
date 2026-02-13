# PDF Editor

A JavaScript-based PDF editing application that allows you to view PDFs and add text or signatures on top of existing content.

## Features

- **View PDF Content**: Renders actual PDF pages using PDF.js so you can see the original content
- **Add Text**: Click anywhere on the PDF to add custom text
- **Add Signatures**: Add typed signatures in a cursive font style
- **Multi-page Support**: Navigate between pages with Previous/Next buttons
- **Download**: Save your edited PDF with all additions

## How It Works

This editor uses two PDF libraries:
- **PDF.js**: Renders the PDF content visually on a canvas
- **pdf-lib**: Handles PDF editing and saving

When you load a PDF:
1. PDF.js renders the actual PDF content so you can see it
2. pdf-lib loads the PDF for editing
3. You can add text/signatures by clicking on the canvas
4. New content is overlaid on top of the existing PDF
5. When you save, pdf-lib creates a new PDF with your additions

## Important Note

This editor **adds new content on top** of existing PDFs. It does not edit or remove existing PDF text. To edit existing text in a PDF, you would need:
- OCR (Optical Character Recognition) to detect text
- Complex text extraction and manipulation
- Or the original editable source document

## Installation

```bash
npm install
```

## Development

```bash
npm run dev
```

## Build

```bash
npm run build
```

## Testing

```bash
npm test
```

## Quick Start

1. Run `npm run dev` to start the development server
2. Click "Choose File" and select a PDF
3. The PDF content will be displayed on the canvas
4. Click "Text Mode" and enter some text
5. Click anywhere on the PDF to place the text
6. Click "Save PDF" to download your edited version

## Technology Stack

- **pdf-lib**: Core PDF manipulation
- **PDF.js**: PDF rendering
- **fast-check**: Property-based testing
- **Jest**: Testing framework
- **Webpack**: Bundling
