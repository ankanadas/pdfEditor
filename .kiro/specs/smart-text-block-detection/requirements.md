# Smart Text Block Detection - Requirements

## Overview
Implement intelligent text block detection for PDF editing that automatically groups text into logical, editable sections (similar to Smallpdf.com), allowing users to edit text in natural, document-like blocks rather than line-by-line or as one giant box.

## User Stories

### 1. As a user, I want text to be automatically grouped into logical blocks
**Acceptance Criteria:**
- When I click "Edit Text", the system analyzes the PDF and creates separate editable boxes for distinct content sections
- Text blocks are identified based on vertical spacing, font characteristics, and positioning
- Each block is independently editable
- Blocks do not overlap or interfere with each other

### 2. As a user, I want to edit each text block like a Word document
**Acceptance Criteria:**
- I can click on any text block to start editing
- I can freely type, delete, and insert text within a block
- Text wraps naturally within the block boundaries
- The block expands vertically as I add more content
- I can use keyboard shortcuts (Ctrl+A, Ctrl+C, Ctrl+V, etc.)

### 3. As a user, I want visual feedback on editable areas
**Acceptance Criteria:**
- Editable blocks have subtle borders when not focused
- Active block highlights with a blue border when clicked
- Blocks have a white/semi-transparent background to cover original PDF text
- Hover effects show which areas are editable

### 4. As a user, I want my edits to be saved with proper formatting
**Acceptance Criteria:**
- When I save the PDF, all edited blocks are processed
- Original text is covered with white rectangles
- New text is rendered with matching font sizes
- Font families are preserved (serif, sans-serif, monospace)
- Text positioning matches the original layout

## Technical Requirements

### Text Block Detection Algorithm
The system should group text items into blocks based on:

1. **Vertical Spacing Analysis**
   - Calculate gaps between consecutive text items
   - Threshold: Gap > 1.5x average line height = new block
   - Special case: Very large gaps (>2x) always create new blocks

2. **Font Characteristics**
   - Group items with similar font sizes (±2 points tolerance)
   - Separate headers (larger fonts) from body text
   - Keep monospace text (code/tables) in separate blocks

3. **Horizontal Alignment**
   - Detect left-aligned, center-aligned, and right-aligned text
   - Group items with similar X positions (±10 points tolerance)
   - Separate multi-column layouts into distinct blocks

4. **Semantic Grouping**
   - Consecutive lines with similar characteristics = one block
   - Isolated single lines (headers, signatures) = separate blocks
   - Dense paragraphs = one block

### Block Properties
Each text block should have:
- `id`: Unique identifier
- `text`: Combined text content with line breaks
- `x, y`: Top-left position
- `width, height`: Bounding box dimensions
- `fontSize`: Average font size of contained text
- `fontFamily`: Dominant font family
- `alignment`: left | center | right
- `items`: Array of original text items in this block

### Rendering Requirements
- Blocks should be `contenteditable` divs, not textareas
- Minimum block width: 200px
- Minimum block height: Based on content
- Padding: 8px
- Line height: 1.4
- White-space: pre-wrap
- Word-wrap: break-word

## Non-Functional Requirements

### Performance
- Text block detection should complete in < 500ms for typical PDFs
- UI should remain responsive during block creation
- No flickering or layout shifts

### Usability
- Blocks should be intuitive and match user expectations
- Editing should feel natural, like editing a Word document
- Visual feedback should be immediate

### Compatibility
- Works with PDFs extracted via PyMuPDF backend
- Falls back to PDF.js extraction if backend unavailable
- Handles various PDF layouts (single column, multi-column, mixed)

## Out of Scope (for this version)
- AI/ML-based text block detection
- OCR for scanned PDFs
- Image editing
- Table structure detection
- Multi-column text reflow
- Collaborative editing

## Success Metrics
- Users can identify and edit distinct content sections
- Average of 3-7 text blocks per page (not 1, not 20+)
- 90%+ of text blocks match user's mental model of document structure
- Editing feels natural and intuitive

## Dependencies
- Existing PDF rendering (PDF.js)
- Existing text extraction (PyMuPDF backend)
- Existing save functionality (backend edit-pdf endpoint)

## References
- Smallpdf.com edit-pdf feature (reference implementation)
- Current implementation: `.kiro/specs/smart-text-block-detection/` (to be created)
