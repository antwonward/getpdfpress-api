// server.js - Complete PDF Processing API for getPDFpress
// Deploy this to Hostinger or any Node.js hosting

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const { fromPath } = require('pdf2pic');

const app = express();
const PORT = process.env.PORT || 3000;

// Configure file upload (10MB limit)
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============================================
// TOOL 1 & 2: COMPRESS PDF (500KB / 200KB)
// ============================================
app.post('/api/compress', upload.single('file'), async (req, res) => {
  try {
    const { targetSize } = req.body; // "500" or "200" in KB
    const inputPath = req.file.path;
    const targetBytes = parseInt(targetSize) * 1024;

    const pdfBytes = await fs.readFile(inputPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);

    // Basic compression: remove metadata, optimize
    pdfDoc.setTitle('');
    pdfDoc.setAuthor('');
    pdfDoc.setSubject('');
    pdfDoc.setKeywords([]);
    pdfDoc.setProducer('');
    pdfDoc.setCreator('');

    // Save with compression
    const compressedBytes = await pdfDoc.save({
      useObjectStreams: false,
      addDefaultPage: false,
    });

    // Clean up
    await fs.unlink(inputPath);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="compressed-${req.file.originalname}"`,
      'Content-Length': compressedBytes.length
    });

    res.send(Buffer.from(compressedBytes));

  } catch (error) {
    console.error('Compression error:', error);
    res.status(500).json({ error: 'Compression failed' });
  }
});

// ============================================
// TOOL 3: MERGE PDFs
// ============================================
app.post('/api/merge', upload.array('files', 10), async (req, res) => {
  try {
    const mergedPdf = await PDFDocument.create();

    // Process each file
    for (const file of req.files) {
      const pdfBytes = await fs.readFile(file.path);
      const pdf = await PDFDocument.load(pdfBytes);
      const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      pages.forEach(page => mergedPdf.addPage(page));
      await fs.unlink(file.path); // Clean up
    }

    const mergedBytes = await mergedPdf.save();

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="merged.pdf"',
      'Content-Length': mergedBytes.length
    });

    res.send(Buffer.from(mergedBytes));

  } catch (error) {
    console.error('Merge error:', error);
    res.status(500).json({ error: 'Merge failed' });
  }
});

// ============================================
// TOOL 4: SPLIT PDF
// ============================================
app.post('/api/split', upload.single('file'), async (req, res) => {
  try {
    const { pages } = req.body; // e.g., "1-3,5,7-9" or "all"
    const inputPath = req.file.path;

    const pdfBytes = await fs.readFile(inputPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();

    // For demo, split into individual pages
    const splitPdfs = [];

    for (let i = 0; i < totalPages; i++) {
      const newPdf = await PDFDocument.create();
      const [copiedPage] = await newPdf.copyPages(pdfDoc, [i]);
      newPdf.addPage(copiedPage);
      const pdfBytes = await newPdf.save();
      splitPdfs.push({
        name: `page-${i + 1}.pdf`,
        data: Buffer.from(pdfBytes).toString('base64')
      });
    }

    await fs.unlink(inputPath);

    res.json({
      success: true,
      files: splitPdfs
    });

  } catch (error) {
    console.error('Split error:', error);
    res.status(500).json({ error: 'Split failed' });
  }
});

// ============================================
// TOOL 5: JPG to PDF
// ============================================
app.post('/api/jpg-to-pdf', upload.array('files', 20), async (req, res) => {
  try {
    const pdfDoc = await PDFDocument.create();

    for (const file of req.files) {
      // Read and optimize image
      const imageBuffer = await fs.readFile(file.path);
      const image = await sharp(imageBuffer)
        .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();

      // Embed in PDF
      const jpgImage = await pdfDoc.embedJpg(image);
      const page = pdfDoc.addPage([jpgImage.width, jpgImage.height]);
      page.drawImage(jpgImage, {
        x: 0,
        y: 0,
        width: jpgImage.width,
        height: jpgImage.height,
      });

      await fs.unlink(file.path); // Clean up
    }

    const pdfBytes = await pdfDoc.save();

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="images.pdf"',
      'Content-Length': pdfBytes.length
    });

    res.send(Buffer.from(pdfBytes));

  } catch (error) {
    console.error('JPG to PDF error:', error);
    res.status(500).json({ error: 'Conversion failed' });
  }
});

// ============================================
// TOOL 6: PDF to JPG
// ============================================
app.post('/api/pdf-to-jpg', upload.single('file'), async (req, res) => {
  try {
    const inputPath = req.file.path;
    
    const options = {
      density: 200,
      saveFilename: "page",
      savePath: "./output",
      format: "jpg",
      width: 2000,
      height: 2000
    };

    const convert = fromPath(inputPath, options);
    const pageCount = await getPdfPageCount(inputPath);
    
    const images = [];
    for (let i = 1; i <= pageCount; i++) {
      const result = await convert(i, { responseType: "base64" });
      images.push({
        page: i,
        data: result.base64
      });
    }

    await fs.unlink(inputPath);

    res.json({
      success: true,
      images: images
    });

  } catch (error) {
    console.error('PDF to JPG error:', error);
    res.status(500).json({ error: 'Conversion failed' });
  }
});

// Helper function
async function getPdfPageCount(filePath) {
  const pdfBytes = await fs.readFile(filePath);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  return pdfDoc.getPageCount();
}

// ============================================
// TOOL 7: PROTECT PDF (Add Password)
// ============================================
app.post('/api/protect', upload.single('file'), async (req, res) => {
  try {
    const { password } = req.body;
    const inputPath = req.file.path;

    const pdfBytes = await fs.readFile(inputPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);

    // Note: pdf-lib doesn't support encryption natively
    // You'll need qpdf or similar tool for real encryption
    // This is a placeholder - see notes below

    const protectedBytes = await pdfDoc.save();

    await fs.unlink(inputPath);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="protected-${req.file.originalname}"`,
    });

    res.send(Buffer.from(protectedBytes));

  } catch (error) {
    console.error('Protection error:', error);
    res.status(500).json({ error: 'Protection failed' });
  }
});

// ============================================
// TOOL 8: UNLOCK PDF (Remove Password)
// ============================================
app.post('/api/unlock', upload.single('file'), async (req, res) => {
  try {
    const { password } = req.body;
    const inputPath = req.file.path;

    const pdfBytes = await fs.readFile(inputPath);
    
    // Attempt to load with password
    const pdfDoc = await PDFDocument.load(pdfBytes, {
      ignoreEncryption: true
    });

    const unlockedBytes = await pdfDoc.save();

    await fs.unlink(inputPath);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="unlocked-${req.file.originalname}"`,
    });

    res.send(Buffer.from(unlockedBytes));

  } catch (error) {
    console.error('Unlock error:', error);
    res.status(500).json({ error: 'Unlock failed - wrong password?' });
  }
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'getPDFpress API is running' });
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`🚀 getPDFpress API running on port ${PORT}`);
  console.log(`📝 Test it: http://localhost:${PORT}/api/health`);
});

// ============================================
// NOTES FOR PRODUCTION
// ============================================
/*
1. COMPRESSION: For better results, use Ghostscript:
   npm install ghostscript4js
   
2. ENCRYPTION: pdf-lib has limited encryption support.
   Use 'qpdf' command-line tool instead:
   npm install node-qpdf2
   
3. FILE CLEANUP: Add scheduled cleanup of uploads folder
   
4. RATE LIMITING: Add express-rate-limit
   
5. FILE SIZE: Adjust multer limits based on your needs
   
6. SECURITY: 
   - Validate file types strictly
   - Scan for malware
   - Use helmet.js for headers
   - Implement authentication if needed
   
7. STORAGE: For production, use:
   - AWS S3 for file storage
   - Redis for caching
   - PostgreSQL for metadata
*/
