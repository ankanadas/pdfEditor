import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fs from 'fs';

async function createTestPDF() {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]); // A4 size
  
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  
  page.drawText('Test PDF Document', {
    x: 50,
    y: 800,
    size: 24,
    font,
    color: rgb(0, 0, 0),
  });
  
  page.drawText('This is a test PDF for the PDF Editor application.', {
    x: 50,
    y: 750,
    size: 14,
    font,
    color: rgb(0, 0, 0),
  });
  
  page.drawText('You can add text and signatures to this document.', {
    x: 50,
    y: 730,
    size: 14,
    font,
    color: rgb(0, 0, 0),
  });
  
  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync('test-document.pdf', pdfBytes);
  
  console.log('✅ Test PDF created: test-document.pdf');
}

createTestPDF().catch(console.error);
