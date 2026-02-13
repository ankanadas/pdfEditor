# PDF Editor Backend (Python + PyMuPDF)

This is the backend service for the PDF Editor that provides professional-quality PDF editing using PyMuPDF.

## Features

- Extract text with exact positions and font information
- Edit PDFs while preserving fonts
- Cover original text with white rectangles
- Add new text with proper font matching

## Setup

### 1. Install Python (if not already installed)

Check if Python is installed:
```bash
python3 --version
```

If not installed, download from: https://www.python.org/downloads/

### 2. Create Virtual Environment

```bash
cd backend
python3 -m venv venv
```

### 3. Activate Virtual Environment

**macOS/Linux:**
```bash
source venv/bin/activate
```

**Windows:**
```bash
venv\Scripts\activate
```

### 4. Install Dependencies

```bash
pip install -r requirements.txt
```

### 5. Run the Server

```bash
python app.py
```

The server will start on http://localhost:5000

## API Endpoints

### GET /health
Health check endpoint

**Response:**
```json
{
  "status": "ok",
  "message": "PDF Editor Backend is running"
}
```

### POST /extract-text
Extract text with positions from PDF

**Request:**
- Content-Type: multipart/form-data
- Body: PDF file

**Response:**
```json
{
  "success": true,
  "pageCount": 1,
  "pages": [
    {
      "pageNumber": 0,
      "width": 612,
      "height": 792,
      "textItems": [
        {
          "text": "Hello",
          "x": 100,
          "y": 700,
          "width": 50,
          "height": 12,
          "fontSize": 12,
          "fontName": "Helvetica"
        }
      ]
    }
  ]
}
```

### POST /edit-pdf
Edit PDF by covering text and adding new text

**Request:**
```json
{
  "pdfBase64": "base64-encoded-pdf",
  "edits": [
    {
      "pageIndex": 0,
      "x": 100,
      "y": 700,
      "width": 50,
      "height": 12,
      "newText": "New text",
      "fontSize": 12,
      "fontName": "Helvetica"
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "pdfBase64": "base64-encoded-edited-pdf"
}
```

## Troubleshooting

### Port already in use
If port 5000 is already in use, change it in app.py:
```python
app.run(debug=True, port=5001)  # Use different port
```

### PyMuPDF installation issues
If PyMuPDF fails to install, try:
```bash
pip install --upgrade pip
pip install PyMuPDF
```

## Development

To run in development mode with auto-reload:
```bash
export FLASK_ENV=development
python app.py
```
