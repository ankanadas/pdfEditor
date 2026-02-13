# PDF Editor - Current Status

## Date: February 13, 2026

## What Works
✅ PDF loading and display
✅ Text extraction from backend (PyMuPDF)
✅ Creating editable text boxes in edit mode
✅ Tracking user edits
✅ Basic save functionality

## Critical Issues

### Issue 1: Duplicate Text in Saved PDF
**Problem**: When saving, both original and edited text appear
**Example**: "February 10, 2026" (original) + "May 10, 202 6" (edited) both show
**Root Cause**: White rectangle is not covering the original text - coordinate mismatch

### Issue 2: Formatting Broken
**Problem**: Spacing is lost, text is crammed together
**Root Cause**: `insert_textbox()` doesn't preserve line breaks properly

### Issue 3: Signature Sometimes Missing
**Problem**: Signature image gets covered by white rectangles
**Status**: Partially fixed with image detection, but not working reliably

## Technical Analysis

### Coordinate System Problem
The core issue is coordinate conversion between:
1. **Backend extraction** (PyMuPDF): Y from bottom-left, bbox[3] is BOTTOM of text
2. **Frontend display** (Canvas): Y from top-left
3. **Backend editing** (PyMuPDF): Y from bottom-left

Current conversion in backend:
```python
y = page_height - span.get("bbox")[3]  # Y is BOTTOM of text
```

Current conversion for white rectangle:
```python
pymupdf_bottom = page_height - y  # This gives TOP, not bottom!
pymupdf_top = pymupdf_bottom - height
```

**This is backwards!** If `y` is already the bottom in PDF coords, then:
- `page_height - y` gives us the TOP in PyMuPDF coords
- We're drawing the rectangle in the wrong place

### Correct Calculation Should Be:
```python
# y from backend is BOTTOM of text in PDF coords (origin bottom-left)
# In PyMuPDF coords (origin top-left):
pymupdf_bottom = page_height - y  # Bottom in PyMuPDF
pymupdf_top = pymupdf_bottom - height  # Top in PyMuPDF
# This is actually correct!
```

Wait, the calculation IS correct. So why isn't it working?

### The Real Problem
Looking at the saved PDF, the white rectangle is being drawn but in the WRONG location. Need to debug by:
1. Printing exact coordinates being used
2. Checking if the rectangle is even visible in the PDF
3. Verifying the text insertion coordinates match

## Attempted Solutions (All Failed)
1. ❌ White rectangles with various padding amounts
2. ❌ Text search and replace (can't find text)
3. ❌ Redaction (removes too much)
4. ❌ Page reconstruction (same issues)
5. ❌ Image-based approach (coordinate problems)

## Next Steps to Try
1. Add visual debugging - draw RED rectangles to see where they're being placed
2. Print ALL coordinates at every step
3. Verify the extracted text coordinates match what's displayed
4. Consider if the scale factor is being applied incorrectly

## Conclusion
We are close - the architecture is sound, but there's a subtle coordinate bug preventing the white rectangles from covering the original text. Once this is fixed, everything should work.
