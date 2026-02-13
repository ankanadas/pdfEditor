# PDF Editor - Complete Setup Guide

This PDF editor uses a **Python backend** (PyMuPDF) for professional-quality PDF editing and a **JavaScript frontend** for the user interface.

## Architecture

```
Frontend (JavaScript)          Backend (Python)
┌─────────────────┐           ┌──────────────────┐
│  Browser        │           │  Flask Server    │
│  localhost:9000 │◄─────────►│  localhost:5000  │
│                 │   HTTP    │                  │
│  - PDF Viewer   │           │  - PyMuPDF       │
│  - UI Controls  │           │  - Text Extract  │
│  - Edit Input   │           │  - PDF Edit      │
└─────────────────┘           └──────────────────┘
```

## Prerequisites

1. **Node.js** (v14+) - Already installed ✅
2. **Python** (v3.8+) - Need to check

## Step 1: Check Python Installation

```bash
python3 --version
```

If not installed, download from: https://www.python.org/downloads/

## Step 2: Start the Backend

Open a **NEW terminal window** and run:

```bash
cd backend
./start.sh
```

You should see:
```
✅ Starting Flask server on http://localhost:5000
```

**Keep this terminal open!** The backend must run continuously.

## Step 3: Start the Frontend

Open **ANOTHER terminal window** and run:

```bash
./start.sh
```

The frontend will open at http://localhost:9000

## Step 4: Test the Setup

1. Open http://localhost:9000 in your browser
2. You should see a message: "✅ Backend connected"
3. Load a PDF file
4. Click "Edit Text" and click on any text
5. Edit the text and press Enter
6. The text should be replaced with proper font preservation!

## Troubleshooting

### Backend won't start

**Error: "python3: command not found"**
- Install Python from https://www.python.org/downloads/

**Error: "Port 5000 already in use"**
- Change port in `backend/app.py`:
  ```python
  app.run(debug=True, port=5001)
  ```
- Update `BACKEND_URL` in `src/services/pdfBackendService.js`

**Error: "pip: command not found"**
```bash
python3 -m ensurepip --upgrade
```

### Frontend can't connect to backend

**Error: "Backend not available"**
1. Make sure backend is running (check terminal)
2. Visit http://localhost:5000/health - should show `{"status": "ok"}`
3. Check browser console for CORS errors

**CORS Error:**
- Backend has CORS enabled, but if issues persist:
  ```bash
  pip install flask-cors
  ```

### PyMuPDF installation fails

**On macOS:**
```bash
brew install mupdf
pip install PyMuPDF
```

**On Linux:**
```bash
sudo apt-get install mupdf mupdf-tools
pip install PyMuPDF
```

**On Windows:**
```bash
pip install --upgrade pip
pip install PyMuPDF
```

## Running Both Services

You need **TWO terminal windows**:

**Terminal 1 - Backend:**
```bash
cd backend
source venv/bin/activate  # On Windows: venv\Scripts\activate
python app.py
```

**Terminal 2 - Frontend:**
```bash
npm run dev
```

## Development Workflow

1. Make changes to frontend code in `src/`
2. Webpack will auto-reload the browser
3. Make changes to backend code in `backend/app.py`
4. Flask will auto-reload the server (debug mode)

## Production Deployment

### Backend (Python)
```bash
cd backend
pip install gunicorn
gunicorn -w 4 -b 0.0.0.0:5000 app:app
```

### Frontend (JavaScript)
```bash
npm run build
# Serve the dist/ folder with nginx or any static server
```

## What You Get

✅ **Professional PDF Editing**
- Preserves original fonts (or uses closest match)
- Exact text positioning
- Clean white box coverage
- Proper font sizing

✅ **FREE Solution**
- No API costs
- No licensing fees
- Open-source libraries

✅ **Full Control**
- Run on your own servers
- No data sent to third parties
- Customize as needed

## Next Steps

Want to add more features?
- Text search and replace
- Batch editing
- Form filling
- Digital signatures
- PDF merging

Let me know what you need!
