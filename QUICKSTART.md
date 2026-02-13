# Quick Start Guide - PDF Editor with Python Backend

## ✅ What We've Built

A professional PDF editor with:
- **Frontend**: JavaScript (what you see in browser)
- **Backend**: Python + PyMuPDF (handles PDF editing with proper fonts)

## 🚀 Setup (5 minutes)

### Step 1: Install Backend Dependencies

Open a terminal and run:

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install flask flask-cors PyMuPDF Pillow
```

**Note**: PyMuPDF download is ~84MB, so it takes 2-3 minutes.

### Step 2: Start the Backend

In the same terminal (with venv activated):

```bash
python app.py
```

You should see:
```
✅ Server running on http://localhost:5000
```

**Keep this terminal open!**

### Step 3: Start the Frontend

Open a **NEW terminal** and run:

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
npm run dev
```

Browser opens at http://localhost:9000

## 🎯 How to Use

1. **Load PDF**: Click "Choose File"
2. **Edit Text**: 
   - Click "Edit Text" button
   - Click on any text in the PDF
   - Edit in the popup box
   - Press Enter
3. **Save**: Click "Save PDF"

## ✨ What's Different Now?

**Before (JavaScript only):**
- ❌ Font changes to Arial/Helvetica
- ❌ Font size inconsistent
- ❌ Looks unprofessional

**After (with Python backend):**
- ✅ Preserves original fonts
- ✅ Exact font sizes
- ✅ Professional quality (like Smallpdf)
- ✅ Completely FREE

## 🔧 Troubleshooting

### Backend won't start

**"python3: command not found"**
```bash
# Install Python from python.org
# Or use Homebrew:
brew install python3
```

**"Port 5000 already in use"**
```bash
# Kill the process using port 5000:
lsof -ti:5000 | xargs kill -9
```

### Frontend can't connect

1. Check backend is running: http://localhost:5000/health
2. Should show: `{"status": "ok"}`
3. If not, restart backend

### PyMuPDF installation fails

```bash
# Try upgrading pip first:
pip install --upgrade pip setuptools wheel
pip install PyMuPDF
```

## 📝 Quick Commands

**Start everything:**
```bash
# Terminal 1 - Backend
cd backend && source venv/bin/activate && python app.py

# Terminal 2 - Frontend  
npm run dev
```

**Stop everything:**
- Press `Ctrl+C` in both terminals

## 🎉 You're Done!

Your PDF editor now has professional-quality editing capabilities, completely free!

## Next Steps

Want to add more features?
- Batch editing multiple PDFs
- Text search and replace across pages
- Form filling
- Digital signatures

Just let me know!
