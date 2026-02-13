from flask import Flask, request, send_file, jsonify
from flask_cors import CORS
import fitz  # PyMuPDF
import io
import base64
import os

app = Flask(__name__)
CORS(app)  # Allow requests from frontend

@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({"status": "ok", "message": "PDF Editor Backend is running"})

@app.route('/extract-text', methods=['POST'])
def extract_text():
    """Extract text with positions from PDF"""
    try:
        # Get PDF file from request
        if 'file' not in request.files:
            return jsonify({"error": "No file provided"}), 400
        
        pdf_file = request.files['file']
        pdf_bytes = pdf_file.read()
        
        # Open PDF with PyMuPDF
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        
        # Extract text from all pages
        pages_data = []
        for page_num in range(len(doc)):
            page = doc[page_num]
            
            # Get page dimensions
            rect = page.rect
            page_width = rect.width
            page_height = rect.height
            
            # Extract text with positions
            text_instances = page.get_text("dict")
            
            # Parse text blocks
            text_items = []
            for block in text_instances.get("blocks", []):
                if block.get("type") == 0:  # Text block
                    for line in block.get("lines", []):
                        for span in line.get("spans", []):
                            text_items.append({
                                "text": span.get("text", ""),
                                "x": span.get("bbox")[0],
                                "y": page_height - span.get("bbox")[3],  # Convert to bottom-left origin
                                "width": span.get("bbox")[2] - span.get("bbox")[0],
                                "height": span.get("bbox")[3] - span.get("bbox")[1],
                                "fontSize": span.get("size", 12),
                                "fontName": span.get("font", "Helvetica"),
                                "color": span.get("color", 0)
                            })
            
            pages_data.append({
                "pageNumber": page_num,
                "width": page_width,
                "height": page_height,
                "textItems": text_items
            })
        
        page_count = len(doc)
        doc.close()
        
        return jsonify({
            "success": True,
            "pageCount": page_count,
            "pages": pages_data
        })
    
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/reconstruct-pdf', methods=['POST'])
def reconstruct_pdf():
    """Reconstruct PDF from scratch with edited text"""
    try:
        data = request.get_json()
        
        if 'pdfBase64' not in data or 'edits' not in data:
            return jsonify({"error": "Missing required fields"}), 400
        
        pdf_base64 = data['pdfBase64']
        pdf_bytes = base64.b64decode(pdf_base64)
        
        # Open original PDF
        original_doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        
        # Create new PDF
        new_doc = fitz.open()
        
        edits = data['edits']
        edits_by_page = {}
        for edit in edits:
            page_idx = edit.get('pageIndex', 0)
            if page_idx not in edits_by_page:
                edits_by_page[page_idx] = []
            edits_by_page[page_idx].append(edit)
        
        print(f"\nReconstructing PDF with {len(edits)} edits across {len(edits_by_page)} pages")
        
        # Process each page
        for page_num in range(len(original_doc)):
            original_page = original_doc[page_num]
            
            # Create new page with same dimensions
            new_page = new_doc.new_page(
                width=original_page.rect.width,
                height=original_page.rect.height
            )
            
            # Copy the original page content as background
            # This preserves images, graphics, etc.
            new_page.show_pdf_page(
                new_page.rect,
                original_doc,
                page_num
            )
            
            # Apply edits for this page
            if page_num in edits_by_page:
                page_edits = edits_by_page[page_num]
                print(f"\nPage {page_num}: {len(page_edits)} edits")
                
                for edit in page_edits:
                    x = edit.get('x', 0)
                    y = edit.get('y', 0)
                    width = edit.get('width', 100)
                    height = edit.get('height', 20)
                    new_text = edit.get('newText', '')
                    font_size = edit.get('fontSize', 12)
                    font_name = edit.get('fontName', 'helv')
                    
                    # Convert coordinates
                    page_height = new_page.rect.height
                    pymupdf_bottom = page_height - y
                    pymupdf_top = pymupdf_bottom - height
                    
                    # Cover original text with white rectangle
                    cover_rect = fitz.Rect(
                        max(0, x - 2),
                        max(0, pymupdf_top - 2),
                        min(new_page.rect.width, x + width + 10),
                        min(new_page.rect.height, pymupdf_bottom + 2)
                    )
                    new_page.draw_rect(cover_rect, color=(1, 1, 1), fill=(1, 1, 1))
                    
                    # Clean text
                    cleaned_text = new_text.replace('\u2019', "'").replace('\u2018', "'")
                    cleaned_text = cleaned_text.replace('\u201c', '"').replace('\u201d', '"')
                    
                    # Font mapping
                    font_map = {
                        'Helvetica': 'helv', 'Helvetica-Bold': 'hebo',
                        'Times-Roman': 'tiro', 'Times-Bold': 'tibo',
                        'Courier': 'cour', 'Courier-Bold': 'cobo'
                    }
                    pymupdf_font = font_map.get(font_name, 'helv')
                    
                    # Insert edited text
                    textbox_rect = fitz.Rect(
                        x,
                        pymupdf_top,
                        new_page.rect.width - 50,
                        pymupdf_bottom + height
                    )
                    
                    result = new_page.insert_textbox(
                        textbox_rect,
                        cleaned_text,
                        fontname=pymupdf_font,
                        fontsize=font_size,
                        color=(0, 0, 0),
                        align=0
                    )
                    
                    print(f"  Edit at ({x:.0f}, {y:.0f}): '{new_text[:30]}...' -> result: {result}")
        
        # Save new PDF
        output_bytes = new_doc.tobytes()
        original_doc.close()
        new_doc.close()
        
        output_base64 = base64.b64encode(output_bytes).decode('utf-8')
        
        return jsonify({"success": True, "pdfBase64": output_base64})
    
    except Exception as e:
        print(f"Error: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route('/edit-pdf', methods=['POST'])
def edit_pdf():
    """Edit PDF using coordinate-based text replacement"""
    try:
        data = request.get_json()
        
        if 'pdfBase64' not in data or 'edits' not in data:
            return jsonify({"error": "Missing required fields"}), 400
        
        pdf_base64 = data['pdfBase64']
        pdf_bytes = base64.b64decode(pdf_base64)
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        
        edits = data['edits']
        print(f"\nProcessing {len(edits)} edits")
        
        # Get images on each page to avoid covering them
        page_images = {}
        for page_num in range(len(doc)):
            page = doc[page_num]
            images = page.get_images()
            image_rects = []
            for img in images:
                xref = img[0]
                img_list = page.get_image_rects(xref)
                for img_rect in img_list:
                    image_rects.append(img_rect)
            page_images[page_num] = image_rects
            if image_rects:
                print(f"Page {page_num} has {len(image_rects)} images")
        
        for edit in edits:
            page_num = edit.get('pageIndex', 0)
            page = doc[page_num]
            page_height = page.rect.height
            
            x = edit.get('x', 0)
            y = edit.get('y', 0)
            width = edit.get('width', 100)
            height = edit.get('height', 20)
            new_text = edit.get('newText', '')
            font_size = edit.get('fontSize', 12)
            font_name = edit.get('fontName', 'helv')
            
            print(f"\nEdit at ({x}, {y}), size ({width}x{height})")
            print(f"New text: '{new_text[:50]}...'")
            print(f"Page height: {page_height}")
            
            # Convert coordinates
            pymupdf_bottom = page_height - y
            pymupdf_top = pymupdf_bottom - height
            
            print(f"Converted: top={pymupdf_top:.2f}, bottom={pymupdf_bottom:.2f}")
            
            # Clean text first
            cleaned_text = new_text.replace('\u2019', "'").replace('\u2018', "'")
            cleaned_text = cleaned_text.replace('\u201c', '"').replace('\u201d', '"')
            cleaned_text = cleaned_text.replace('\u2013', '-').replace('\u2014', '--')
            
            # Calculate how many lines the new text will take
            # Estimate: each line is roughly font_size * 1.5 in height
            line_height = font_size * 1.5
            num_lines = len(cleaned_text.split('\n'))
            estimated_text_height = num_lines * line_height
            
            # Use the larger of: original height or estimated new text height
            redaction_height = max(height, estimated_text_height)
            
            print(f"Original height: {height:.2f}, Estimated new height: {estimated_text_height:.2f}, Using: {redaction_height:.2f}")
            
            # Create redaction rectangle with minimal padding
            # Only extend vertically if the new text is actually taller
            extra_height = max(0, estimated_text_height - height)
            
            cover_rect = fitz.Rect(
                max(0, x - 3),
                max(0, pymupdf_top - 2),
                min(page.rect.width, x + width + 15),
                min(page.rect.height, pymupdf_bottom + extra_height + 3)
            )
            
            print(f"Cover rectangle: {cover_rect}")
            
            # Check if this overlaps with any images
            overlaps_image = False
            if page_num in page_images:
                for img_rect in page_images[page_num]:
                    if cover_rect.intersects(img_rect):
                        overlaps_image = True
                        print(f"  ⚠️  Skipping white rectangle - would cover image at {img_rect}")
                        break
            
            # Only redact and cover if it doesn't overlap an image
            if not overlaps_image:
                # REDACT the original text (actually remove it)
                page.add_redact_annot(cover_rect)
                page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
                print(f"  ✅ REDACTED original text: {cover_rect}")
            else:
                print(f"  ❌ Skipped redaction (image overlap)")
            
            # Font mapping
            font_map = {
                'Helvetica': 'helv', 'Helvetica-Bold': 'hebo',
                'Times-Roman': 'tiro', 'Times-Bold': 'tibo',
                'Courier': 'cour', 'Courier-Bold': 'cobo'
            }
            pymupdf_font = font_map.get(font_name, 'helv')
            
            # Insert new text
            textbox_rect = fitz.Rect(
                x,
                pymupdf_top,
                page.rect.width - 50,
                pymupdf_bottom + height * 2
            )
            
            result = page.insert_textbox(
                textbox_rect,
                cleaned_text,
                fontname=pymupdf_font,
                fontsize=font_size,
                color=(0, 0, 0),
                align=0
            )
            
            print(f"Insert result: {result}")
        
        output_bytes = doc.tobytes()
        doc.close()
        
        output_base64 = base64.b64encode(output_bytes).decode('utf-8')
        
        return jsonify({"success": True, "pdfBase64": output_base64})
    
    except Exception as e:
        print(f"Error: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route('/clear-signature', methods=['POST'])
def clear_signature():
    """Clear signature image from PDF by covering it with white (only images in signature area)"""
    try:
        data = request.get_json()
        
        if 'pdfBase64' not in data:
            return jsonify({"error": "Missing required fields"}), 400
        
        pdf_base64 = data['pdfBase64']
        pdf_bytes = base64.b64decode(pdf_base64)
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        
        print(f"\nClearing signatures from PDF")
        
        # Find and clear only signature images (not logos/headers)
        for page_num in range(len(doc)):
            page = doc[page_num]
            page_height = page.rect.height
            images = page.get_images()
            
            if not images:
                continue
                
            print(f"Page {page_num} has {len(images)} images")
            
            for img in images:
                xref = img[0]
                img_rects = page.get_image_rects(xref)
                
                for img_rect in img_rects:
                    # Only clear images in the middle/lower part of the page
                    # Signatures are typically in the middle (around 40-70% from top)
                    # Logos/headers are at the top (0-20% from top)
                    img_top_percent = (img_rect.y0 / page_height) * 100
                    img_bottom_percent = (img_rect.y1 / page_height) * 100
                    
                    print(f"  Image at {img_rect}, top: {img_top_percent:.1f}%, bottom: {img_bottom_percent:.1f}%")
                    
                    # Only clear if image is in signature area (30-80% from top)
                    if 30 <= img_top_percent <= 80:
                        # Cover the image with white rectangle
                        page.draw_rect(img_rect, color=(1, 1, 1), fill=(1, 1, 1))
                        print(f"  ✅ Cleared signature at {img_rect}")
                    else:
                        print(f"  ⏭️  Skipped (likely logo/header)")
        
        output_bytes = doc.tobytes()
        doc.close()
        
        output_base64 = base64.b64encode(output_bytes).decode('utf-8')
        
        return jsonify({"success": True, "pdfBase64": output_base64})
    
    except Exception as e:
        print(f"Error: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


if __name__ == '__main__':
    print("🚀 PDF Editor Backend starting...")
    print("📝 Endpoints:")
    print("   - GET  /health")
    print("   - POST /extract-text")
    print("   - POST /edit-pdf")
    print("\n✅ Server running on http://localhost:5000")
    app.run(debug=True, port=5000)
