/**
 * Image-based PDF Editor
 * Renders PDF pages as images and overlays editable text
 * Reconstructs PDF on save to preserve formatting
 */

export class ImageBasedPDFEditor {
  constructor(canvas, pdfJsDoc) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pdfJsDoc = pdfJsDoc;
    this.scale = 1.5;
    this.currentPage = 0;
    this.textLayers = []; // Store text positions for each page
    this.edits = new Map(); // Track edits by page and text ID
  }

  /**
   * Render a page as an image
   */
  async renderPageAsImage(pageNumber) {
    const page = await this.pdfJsDoc.getPage(pageNumber + 1);
    const viewport = page.getViewport({ scale: this.scale });
    
    this.canvas.width = viewport.width;
    this.canvas.height = viewport.height;
    
    // Render PDF page to canvas (this creates the background image)
    await page.render({
      canvasContext: this.ctx,
      viewport: viewport
    }).promise;
    
    return { page, viewport };
  }

  /**
   * Extract text positions from a page
   */
  async extractTextPositions(page, viewport) {
    const textContent = await page.getTextContent();
    const textItems = [];
    
    textContent.items.forEach((item, index) => {
      if (!item.str || item.str.trim().length === 0) return;
      
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const x = tx[4] / this.scale;
      const y = (viewport.height - tx[5]) / this.scale;
      const fontSize = Math.sqrt(tx[0] * tx[0] + tx[3] * tx[3]);
      
      textItems.push({
        id: `text-${this.currentPage}-${index}`,
        text: item.str,
        x: x,
        y: y,
        width: item.width,
        height: item.height,
        fontSize: fontSize,
        fontName: item.fontName || 'Helvetica',
        pageIndex: this.currentPage
      });
    });
    
    return textItems;
  }

  /**
   * Create transparent editable overlays
   */
  createEditableOverlays(textItems, container) {
    const overlays = [];
    
    // Group text items into logical blocks
    const blocks = this.groupIntoBlocks(textItems);
    
    blocks.forEach(block => {
      const overlay = document.createElement('div');
      overlay.contentEditable = 'true';
      overlay.className = 'text-overlay';
      overlay.dataset.blockId = block.id;
      overlay.textContent = block.text;
      
      // Position overlay exactly over the text in the image
      const canvasX = block.x * this.scale;
      const canvasY = this.canvas.height - (block.y * this.scale);
      
      overlay.style.position = 'absolute';
      overlay.style.left = canvasX + 'px';
      overlay.style.top = canvasY + 'px';
      overlay.style.width = (block.width * this.scale) + 'px';
      overlay.style.minHeight = (block.height * this.scale) + 'px';
      overlay.style.fontSize = (block.fontSize * this.scale) + 'px';
      overlay.style.fontFamily = this.mapFontFamily(block.fontName);
      overlay.style.color = '#000';
      overlay.style.background = 'transparent';
      overlay.style.border = '2px solid transparent';
      overlay.style.padding = '2px';
      overlay.style.margin = '0';
      overlay.style.lineHeight = '1.2';
      overlay.style.whiteSpace = 'pre-wrap';
      overlay.style.cursor = 'text';
      overlay.style.outline = 'none';
      overlay.style.zIndex = '10';
      
      // Show border on focus
      overlay.addEventListener('focus', () => {
        overlay.style.border = '2px dotted #4A90E2';
        overlay.style.background = 'rgba(255, 255, 255, 0.9)';
      });
      
      overlay.addEventListener('blur', () => {
        overlay.style.border = '2px solid transparent';
        overlay.style.background = 'transparent';
        
        // Track edit
        const originalText = block.text;
        const newText = overlay.textContent;
        if (originalText !== newText) {
          this.edits.set(block.id, {
            blockId: block.id,
            pageIndex: block.pageIndex,
            originalText: originalText,
            newText: newText,
            x: block.x,
            y: block.y,
            width: block.width,
            height: block.height,
            fontSize: block.fontSize,
            fontName: block.fontName
          });
        }
      });
      
      container.appendChild(overlay);
      overlays.push(overlay);
    });
    
    return overlays;
  }

  /**
   * Group text items into logical blocks
   */
  groupIntoBlocks(textItems) {
    // Sort by Y position (top to bottom)
    const sorted = [...textItems].sort((a, b) => b.y - a.y);
    
    const blocks = [];
    let currentBlock = null;
    
    sorted.forEach(item => {
      const shouldStartNewBlock = !currentBlock || 
        Math.abs(item.y - currentBlock.y) > 20 ||
        Math.abs(item.x - currentBlock.x) > 10;
      
      if (shouldStartNewBlock) {
        if (currentBlock) blocks.push(currentBlock);
        currentBlock = {
          id: item.id,
          text: item.text,
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,
          fontSize: item.fontSize,
          fontName: item.fontName,
          pageIndex: item.pageIndex,
          items: [item]
        };
      } else {
        currentBlock.text += ' ' + item.text;
        currentBlock.width = Math.max(currentBlock.width, item.x + item.width - currentBlock.x);
        currentBlock.items.push(item);
      }
    });
    
    if (currentBlock) blocks.push(currentBlock);
    return blocks;
  }

  /**
   * Map PDF font names to CSS font families
   */
  mapFontFamily(fontName) {
    if (!fontName) return 'Arial, sans-serif';
    const lower = fontName.toLowerCase();
    if (lower.includes('times') || lower.includes('serif')) {
      return '"Times New Roman", Times, serif';
    } else if (lower.includes('courier') || lower.includes('mono')) {
      return '"Courier New", Courier, monospace';
    }
    return 'Arial, Helvetica, sans-serif';
  }

  /**
   * Get all edits for reconstruction
   */
  getEdits() {
    return Array.from(this.edits.values());
  }
}
