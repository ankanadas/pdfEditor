# PDF Editor - Usage Guide

## Setup Complete! ✅

Your PDF editor now has text editing capabilities.

## Starting the Application

### Option 1: Using the start script (Recommended)
```bash
./start.sh
```

### Option 2: Manual start
```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
npm run dev
```

The app will open at http://localhost:9000

## Features

### 1. Edit Existing Text ⭐ TRUE INLINE EDITING!
- Click the "Edit Text" button
- Hover over text - cursor changes to text cursor
- Click on any text in the PDF
- An editable text box appears directly on the PDF (like Smallpdf!)
- Edit the text right there - you can type, delete, select, etc.
- Press Enter to save (or click outside to auto-save)
- Press Escape to cancel
- The original text is covered with a white box and replaced with your new text
- You can edit the same text multiple times without overlapping

### 2. Add New Text
- Click "Add Text" button
- Type your text in the input field
- Click anywhere on the PDF to place it

### 3. Add Signatures
- Click "Signature" button
- Type your name
- Click on the PDF to place your signature

### 4. Navigate Pages
- Use "Previous" and "Next" buttons to move between pages
- Current page number is displayed

### 5. Save Your Work
- Click "Save PDF" to download the edited version
- All changes (edits, additions, signatures) are saved

## How Text Editing Works

The editor uses a "white box overlay" technique:
1. PDF.js extracts text positions from the original PDF
2. When you click on text, it detects which text you clicked
3. A white rectangle covers the original text
4. Your new text is drawn in the same position
5. When saved, the PDF contains the white box + new text

This is similar to how professional PDF editors like Smallpdf work!

## Node.js Version

This project requires Node.js v14+ and uses nvm (Node Version Manager).

The `.nvmrc` file ensures you're using Node v24.13.1.

To make nvm permanent, add to your `~/.zshrc`:
```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
```

## Troubleshooting

### "node: command not found" or wrong version
```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use
```

### Build fails
```bash
rm -rf node_modules package-lock.json
npm install
npm run build
```

### Text editing not working
- Make sure you're in "Edit Text" mode (button should be green)
- Click directly on the text (not between letters)
- The text must be selectable (some PDFs have text as images)
