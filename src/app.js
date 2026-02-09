import { EditorController } from './core/EditorController.js';

class PDFEditorApp {
  constructor() {
    this.controller = new EditorController();
    this.canvas = document.getElementById('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.currentPage = 0;
    this.mode = null; // 'text' or 'signature'
    this.pageWidth = 612; // Standard US Letter width in points
    this.pageHeight = 792; // Standard US Letter height in points
    this.scale = 1.0;
    
    this.initializeEventListeners();
    this.setupControllerEvents();
    
    console.log('PDF Editor App initialized');
  }

  initializeEventListeners() {
    // File input
    document.getElementById('fileInput').addEventListener('change', (e) => {
      this.handleFileSelect(e);
    });

    // Mode buttons
    document.getElementById('textModeBtn').addEventListener('click', () => {
      this.setMode('text');
    });

    document.getElementById('signatureModeBtn').addEventListener('click', () => {
      this.setMode('signature');
    });

    // Save button
    document.getElementById('saveBtn').addEventListener('click', () => {
      this.savePDF();
    });

    // Canvas click
    this.canvas.addEventListener('click', (e) => {
      this.handleCanvasClick(e);
    });
  }

  setupControllerEvents() {
    this.controller.on('loaded', (data) => {
      console.log('PDF loaded event received:', data);
      this.showStatus(`PDF loaded successfully! ${data.pageCount} page(s)`, 'success');
      this.renderCurrentPage();
      document.getElementById('saveBtn').disabled = false;
      document.getElementById('textInput').disabled = false;
      document.getElementById('signatureInput').disabled = false;
      this.updateModeIndicator();
      
      // Auto-select text mode for convenience
      this.setMode('text');
    });

    this.controller.on('saved', () => {
      this.showStatus('PDF saved successfully!', 'success');
    });

    this.controller.on('error', (data) => {
      console.error('Controller error:', data);
      this.showStatus(`Error: ${data.message}`, 'error');
    });
  }

  async handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
      console.log('File selected:', file.name);
      this.showStatus('Loading PDF...', 'info');
      
      // Load into controller (pdf-lib)
      await this.controller.loadPDF(file);
      console.log('Controller loaded PDF');
      
      this.currentPage = 0;
      this.renderCurrentPage();
      
    } catch (error) {
      console.error('Error loading PDF:', error);
      this.showStatus(`Failed to load PDF: ${error.message}`, 'error');
    }
  }

  renderCurrentPage() {
    if (!this.controller.isLoaded) {
      console.log('No PDF loaded yet');
      return;
    }

    try {
      console.log('Rendering page', this.currentPage + 1);
      
      // Set canvas size to standard page dimensions
      this.canvas.width = this.pageWidth * this.scale;
      this.canvas.height = this.pageHeight * this.scale;

      console.log('Canvas size:', this.canvas.width, 'x', this.canvas.height);

      // Draw a white background to represent the PDF page
      this.ctx.fillStyle = '#ffffff';
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      
      // Draw a border
      this.ctx.strokeStyle = '#cccccc';
      this.ctx.lineWidth = 2;
      this.ctx.strokeRect(0, 0, this.canvas.width, this.canvas.height);
      
      // Draw info text
      this.ctx.fillStyle = '#666666';
      this.ctx.font = '16px Arial';
      this.ctx.textAlign = 'center';
      this.ctx.fillText('PDF Loaded - Click to add text or signature', this.canvas.width / 2, this.canvas.height / 2);
      this.ctx.font = '14px Arial';
      this.ctx.fillText(`Page ${this.currentPage + 1}`, this.canvas.width / 2, this.canvas.height / 2 + 30);
      
      // Draw all text elements on this page
      if (this.controller.textEditor) {
        const textElements = this.controller.textEditor.getTextElements();
        textElements.forEach(element => {
          if (element.pageIndex === this.currentPage) {
            this.ctx.fillStyle = `rgb(${element.color.r * 255}, ${element.color.g * 255}, ${element.color.b * 255})`;
            this.ctx.font = `${element.size * this.scale}px Arial`;
            this.ctx.textAlign = 'left';
            // Convert PDF coordinates (bottom-left origin) to canvas coordinates (top-left origin)
            const canvasY = this.canvas.height - (element.y * this.scale);
            this.ctx.fillText(element.text, element.x * this.scale, canvasY);
          }
        });
      }
      
      // Draw all signatures on this page
      if (this.controller.signatureEditor) {
        const signatures = this.controller.signatureEditor.getSignatures();
        signatures.forEach(sig => {
          if (sig.pageIndex === this.currentPage && sig.type === 'typed') {
            this.ctx.fillStyle = `rgb(${sig.color.r * 255}, ${sig.color.g * 255}, ${sig.color.b * 255})`;
            this.ctx.font = `italic ${sig.fontSize * this.scale}px "Brush Script MT", cursive`;
            this.ctx.textAlign = 'left';
            // Convert PDF coordinates (bottom-left origin) to canvas coordinates (top-left origin)
            const canvasY = this.canvas.height - (sig.y * this.scale);
            this.ctx.fillText(sig.text, sig.x * this.scale, canvasY);
          }
        });
      }
      
      console.log('Page rendered successfully');
    } catch (error) {
      console.error('Error rendering page:', error);
      this.showStatus('Error rendering PDF page', 'error');
    }
  }

  setMode(mode) {
    this.mode = mode;
    
    // Update button styles
    const textBtn = document.getElementById('textModeBtn');
    const sigBtn = document.getElementById('signatureModeBtn');
    
    if (mode === 'text') {
      textBtn.classList.remove('secondary');
      textBtn.style.background = '#28a745';
      sigBtn.classList.add('secondary');
      sigBtn.style.background = '';
      document.getElementById('textInput').focus();
    } else if (mode === 'signature') {
      sigBtn.classList.remove('secondary');
      sigBtn.style.background = '#28a745';
      textBtn.classList.add('secondary');
      textBtn.style.background = '';
      document.getElementById('signatureInput').focus();
    }
    
    this.updateModeIndicator();
  }

  updateModeIndicator() {
    const indicator = document.getElementById('modeIndicator');
    if (!this.controller.isLoaded) {
      indicator.textContent = 'No PDF loaded';
      indicator.classList.remove('active');
    } else if (this.mode === 'text') {
      indicator.textContent = 'Text Mode Active';
      indicator.classList.add('active');
    } else if (this.mode === 'signature') {
      indicator.textContent = 'Signature Mode Active';
      indicator.classList.add('active');
    } else {
      indicator.textContent = 'Select a mode';
      indicator.classList.remove('active');
    }
  }

  async handleCanvasClick(event) {
    if (!this.controller.isLoaded || !this.mode) {
      this.showStatus('Please load a PDF and select a mode first', 'error');
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / this.scale;
    const y = this.pageHeight - (event.clientY - rect.top) / this.scale; // Convert to PDF coordinates (origin at bottom-left)

    console.log('Canvas click at:', x, y);

    try {
      if (this.mode === 'text') {
        const text = document.getElementById('textInput').value.trim();
        if (!text) {
          this.showStatus('Please enter text first', 'error');
          return;
        }

        const textEditor = this.controller.getTextEditor();
        await textEditor.addText(this.currentPage, text, x, y, {
          size: 16,
          color: { r: 0, g: 0, b: 0 }
        });

        this.showStatus(`Text "${text}" added at position (${Math.round(x)}, ${Math.round(y)})`, 'success');
        
        // Re-render to show the new text
        this.renderCurrentPage();
        
        // Clear input
        document.getElementById('textInput').value = '';
        
      } else if (this.mode === 'signature') {
        const signatureText = document.getElementById('signatureInput').value.trim();
        if (!signatureText) {
          this.showStatus('Please enter your name first', 'error');
          return;
        }

        const signatureEditor = this.controller.getSignatureEditor();
        await signatureEditor.addTypedSignature(this.currentPage, signatureText, x, y, {
          fontSize: 24,
          color: { r: 0, g: 0, b: 0.5 }
        });

        this.showStatus(`Signature "${signatureText}" added`, 'success');
        
        // Re-render to show the new signature
        this.renderCurrentPage();
        
        // Clear input
        document.getElementById('signatureInput').value = '';
      }
    } catch (error) {
      console.error('Error handling canvas click:', error);
      this.showStatus(`Error: ${error.message}`, 'error');
    }
  }

  async savePDF() {
    if (!this.controller.isLoaded) {
      this.showStatus('No PDF loaded', 'error');
      return;
    }

    try {
      this.showStatus('Saving PDF...', 'info');
      await this.controller.saveAs('edited-document.pdf');
    } catch (error) {
      this.showStatus(`Failed to save: ${error.message}`, 'error');
    }
  }

  showStatus(message, type) {
    const status = document.getElementById('status');
    status.textContent = message;
    status.className = type;
    
    if (type === 'success' || type === 'info') {
      setTimeout(() => {
        status.style.display = 'none';
      }, 5000);
    }
  }
}

// Initialize the app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new PDFEditorApp();
});
