// server.js - UPGRADED with REAL PDF Compression + PROPER ERROR HANDLING
// This version uses Ghostscript for actual file size reduction

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");
const sharp = require("sharp");
const { exec } = require("child_process");
const { fromPath } = require("pdf2pic");
const util = require("util");
const execPromise = util.promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, "uploads");
const outputDir = path.join(__dirname, "output");

try {
  if (!fsSync.existsSync(uploadsDir)) {
    fsSync.mkdirSync(uploadsDir, { recursive: true });
    console.log("✅ Created uploads directory");
  }
  if (!fsSync.existsSync(outputDir)) {
    fsSync.mkdirSync(outputDir, { recursive: true });
    console.log("✅ Created output directory");
  }
} catch (err) {
  console.error("❌ Error creating directories:", err);
}

// ================================
// Multer: keep file extensions (CRITICAL for LibreOffice)
// ================================
const sanitize = (name) => name.replace(/[^a-zA-Z0-9._-]/g, "_");

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || "";
    const base = path.basename(file.originalname, ext);
    cb(null, `${Date.now()}-${sanitize(base)}${ext.toLowerCase()}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  }),
);
app.use(express.json());
app.use(express.static("public"));

// ============================================
// HELPER: Safe file cleanup (never throws)
// ============================================
async function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (_) {
    // ignore: file may already be deleted / missing / locked
  }
}

// ============================================
// HELPER: Safe directory cleanup (never throws)
// ============================================
async function safeRmdir(dirPath) {
  if (!dirPath) return;
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch (_) {
    // ignore: directory may already be deleted / missing
  }
}

// ============================================
// HELPER: Check if Ghostscript is available
// ============================================
async function isGhostscriptAvailable() {
  try {
    await execPromise("gs --version");
    return true;
  } catch (error) {
    return false;
  }
}
const LO_PROFILE = "file:///tmp/lo-profile";

// ============================================
// HELPER: Check if LibreOffice is available
// ============================================
async function checkLibreOffice() {
  try {
    await execPromise("libreoffice --version");
    return true;
  } catch (error) {
    return false;
  }
}

// ============================================
// HELPER: Compress with Ghostscript (REAL compression!)
// ============================================
async function compressWithGhostscript(inputPath, outputPath, targetSizeKB, compressionLevel = 'balanced') {
  const hasGs = await isGhostscriptAvailable();

  if (!hasGs) {
    console.log("⚠️ Ghostscript not available, using fallback compression");
    return compressWithPdfLib(inputPath, outputPath);
  }

  console.log(`🔧 Using Ghostscript for compression (level: ${compressionLevel})`);

  // Determine compression quality based on compression level and target size
  let quality;
  
  if (compressionLevel === 'gentle') {
    // Gentle: Best quality, may exceed target size
    quality = "/printer"; // ~300 DPI
  } else if (compressionLevel === 'strong') {
    // Strong: Maximum compression, smallest file
    quality = "/screen"; // ~72 DPI
  } else {
    // Balanced (default): Use target size to determine quality
    if (targetSizeKB <= 200) {
      quality = "/screen"; // Lowest quality for smallest target
    } else if (targetSizeKB <= 500) {
      quality = "/ebook"; // Medium quality
    } else {
      quality = "/printer"; // Higher quality for larger target
    }
  }

  const command = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=${quality} -dNOPAUSE -dQUIET -dBATCH -dDetectDuplicateImages=true -dCompressFonts=true -sOutputFile="${outputPath}" "${inputPath}"`;

  try {
    console.log(`📄 Executing Ghostscript compression with ${quality}...`);
    await execPromise(command);
    console.log("✅ Ghostscript compression complete");
    return true;
  } catch (error) {
    console.error("❌ Ghostscript failed:", error.message);
    // Fallback to basic compression
    return compressWithPdfLib(inputPath, outputPath);
  }
}

// ============================================
// HELPER: Fallback compression with pdf-lib
// ============================================
async function compressWithPdfLib(inputPath, outputPath) {
  console.log("📦 Using pdf-lib fallback compression");
  const pdfBytes = await fs.readFile(inputPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);

  // Basic compression: remove metadata
  pdfDoc.setTitle("");
  pdfDoc.setAuthor("");
  pdfDoc.setSubject("");
  pdfDoc.setKeywords([]);
  pdfDoc.setProducer("");
  pdfDoc.setCreator("");

  const compressedBytes = await pdfDoc.save({
    useObjectStreams: false,
    addDefaultPage: false,
  });

  await fs.writeFile(outputPath, compressedBytes);
  return true;
}

// ============================================
// TOOL 1 & 2: COMPRESS PDF (500KB / 200KB)
// ============================================
app.post("/api/compress", upload.single("file"), async (req, res) => {
  console.log("📥 Compress request received");
  let inputPath, outputPath;

  try {
    if (!req.file) {
      console.log("❌ No file uploaded");
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { targetSize, compressionLevel = 'balanced' } = req.body; // "500" or "200" in KB, and compression level
    inputPath = req.file.path;
    outputPath = path.join(outputDir, `compressed-${Date.now()}.pdf`);
    const targetSizeKB = parseInt(targetSize);

    console.log(
      `📄 Processing: ${req.file.originalname} (${req.file.size} bytes)`,
    );
    console.log(`🎯 Target size: ${targetSize}KB`);
    console.log(`⚙️ Compression level: ${compressionLevel}`);

    // Use Ghostscript for real compression
    await compressWithGhostscript(inputPath, outputPath, targetSizeKB, compressionLevel);

    // Read the compressed file
    const compressedBytes = await fs.readFile(outputPath);
    console.log(
      `✅ Compressed: ${compressedBytes.length} bytes (${Math.round((1 - compressedBytes.length / req.file.size) * 100)}% reduction)`,
    );

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="compressed-${req.file.originalname}"`,
      "Content-Length": compressedBytes.length,
    });

    res.send(Buffer.from(compressedBytes));
  } catch (error) {
    console.error("❌ Compression error:", error.message);
    console.error("Stack:", error.stack);
    res.status(500).json({
      error: "Compression failed",
      details: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  } finally {
    // ✅ GUARANTEED cleanup - runs even if error occurs
    await safeUnlink(inputPath);
    await safeUnlink(outputPath);
  }
});

// ============================================
// TOOL 3: MERGE PDFs
// ============================================
app.post("/api/merge", upload.array("files", 10), async (req, res) => {
  const filePaths = req.files ? req.files.map((f) => f.path) : [];

  try {
    const mergedPdf = await PDFDocument.create();

    // Process each file
    for (const file of req.files) {
      const pdfBytes = await fs.readFile(file.path);
      const pdf = await PDFDocument.load(pdfBytes);
      const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      pages.forEach((page) => mergedPdf.addPage(page));
    }

    const mergedBytes = await mergedPdf.save();

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="merged.pdf"',
      "Content-Length": mergedBytes.length,
    });

    res.send(Buffer.from(mergedBytes));
  } catch (error) {
    console.error("Merge error:", error);
    res.status(500).json({ error: "Merge failed" });
  } finally {
    // ✅ GUARANTEED cleanup - clean up all uploaded files
    for (const filePath of filePaths) {
      await safeUnlink(filePath);
    }
  }
});

// ============================================
// TOOL 4: SPLIT PDF
// ============================================
app.post("/api/split", upload.single("file"), async (req, res) => {
  let inputPath;

  try {
    const { pages } = req.body; // e.g., "1-3,5,7-9" or "all"
    inputPath = req.file.path;

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
        data: Buffer.from(pdfBytes).toString("base64"),
      });
    }

    res.json({
      success: true,
      files: splitPdfs,
    });
  } catch (error) {
    console.error("Split error:", error);
    res.status(500).json({ error: "Split failed" });
  } finally {
    // ✅ GUARANTEED cleanup
    await safeUnlink(inputPath);
  }
});

// ============================================
// TOOL 5: JPG to PDF
// ============================================
app.post("/api/jpg-to-pdf", upload.array("files", 20), async (req, res) => {
  const filePaths = req.files ? req.files.map((f) => f.path) : [];

  try {
    const pdfDoc = await PDFDocument.create();

    for (const file of req.files) {
      // Read and optimize image
      const imageBuffer = await fs.readFile(file.path);
      const image = await sharp(imageBuffer)
        .resize(2000, 2000, { fit: "inside", withoutEnlargement: true })
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
    }

    const pdfBytes = await pdfDoc.save();

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="images.pdf"',
      "Content-Length": pdfBytes.length,
    });

    res.send(Buffer.from(pdfBytes));
  } catch (error) {
    console.error("JPG to PDF error:", error);
    res.status(500).json({ error: "Conversion failed" });
  } finally {
    // ✅ GUARANTEED cleanup - clean up all uploaded images
    for (const filePath of filePaths) {
      await safeUnlink(filePath);
    }
  }
});

// ============================================
// TOOL 6: PDF to JPG (FIXED - no file leaks!)
// ============================================
app.post("/api/pdf-to-jpg", upload.single("file"), async (req, res) => {
  let inputPath, tempDir;

  try {
    inputPath = req.file.path;

    // ✅ Create a unique temp directory for this request
    tempDir = path.join(outputDir, `pdf2jpg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });

    const options = {
      density: 200,
      saveFilename: "page",
      savePath: tempDir, // ✅ Use per-request temp directory
      format: "jpg",
      width: 2000,
      height: 2000,
    };

    const convert = fromPath(inputPath, options);
    const pageCount = await getPdfPageCount(inputPath);

    const images = [];
    for (let i = 1; i <= pageCount; i++) {
      const result = await convert(i, { responseType: "base64" });
      images.push({
        page: i,
        data: result.base64,
      });
    }

    res.json({
      success: true,
      images: images,
    });
  } catch (error) {
    console.error("PDF to JPG error:", error);
    res.status(500).json({ error: "Conversion failed" });
  } finally {
    // ✅ GUARANTEED cleanup - delete input AND entire temp directory
    await safeUnlink(inputPath);
    await safeRmdir(tempDir);
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
app.post("/api/protect", upload.single("file"), async (req, res) => {
  let inputPath;

  try {
    const { password } = req.body;
    inputPath = req.file.path;

    const pdfBytes = await fs.readFile(inputPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);

    // Note: pdf-lib doesn't support encryption natively
    // You'll need qpdf or similar tool for real encryption
    // This is a placeholder

    const protectedBytes = await pdfDoc.save();

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="protected-${req.file.originalname}"`,
    });

    res.send(Buffer.from(protectedBytes));
  } catch (error) {
    console.error("Protection error:", error);
    res.status(500).json({ error: "Protection failed" });
  } finally {
    // ✅ GUARANTEED cleanup
    await safeUnlink(inputPath);
  }
});

// ============================================
// TOOL 8: UNLOCK PDF (Remove Password)
// ============================================
app.post("/api/unlock", upload.single("file"), async (req, res) => {
  let inputPath;

  try {
    const { password } = req.body;
    inputPath = req.file.path;

    const pdfBytes = await fs.readFile(inputPath);

    // Attempt to load with password
    const pdfDoc = await PDFDocument.load(pdfBytes, {
      ignoreEncryption: true,
    });

    const unlockedBytes = await pdfDoc.save();

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="unlocked-${req.file.originalname}"`,
    });

    res.send(Buffer.from(unlockedBytes));
  } catch (error) {
    console.error("Unlock error:", error);
    res.status(500).json({ error: "Unlock failed - wrong password?" });
  } finally {
    // ✅ GUARANTEED cleanup
    await safeUnlink(inputPath);
  }
});

// ============================================
// TOOL 9: PDF to Word
// ============================================
app.post("/api/pdf-to-word", upload.single("file"), async (req, res) => {
  console.log("📥 PDF to Word request received");
  let inputPath, docxPath;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    inputPath = req.file.path;
    const hasLibreOffice = await checkLibreOffice();

    if (!hasLibreOffice) {
      return res.status(501).json({
        error: "Feature not available",
        message:
          "PDF to Word requires LibreOffice to be installed on the server.",
        suggestion: "This feature is coming soon!",
      });
    }

    console.log("🔧 Using LibreOffice for PDF to Word conversion");
    
    // Get timestamp before conversion to identify new files
    const beforeConversion = Date.now();
    
    const command =
      `libreoffice --headless --nologo --nofirststartwizard --norestore ` +
      `-env:UserInstallation=${LO_PROFILE} ` +
      `--convert-to docx:"MS Word 2007 XML" ` +
      `--outdir "${outputDir}" "${inputPath}"`;

    console.log(`📝 Running command: ${command}`);
    await execPromise(command, { timeout: 90000 }); // 90 second timeout

    // Longer delay to ensure file is fully written
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Find the newest .docx file created after conversion started
    const files = await fs.readdir(outputDir);
    console.log(`📂 Files in output directory:`, files);
    
    // Get all .docx files with their stats
    const docxFiles = [];
    for (const file of files) {
      if (file.toLowerCase().endsWith('.docx')) {
        const filePath = path.join(outputDir, file);
        try {
          const stats = await fs.stat(filePath);
          // Only consider files created/modified after we started conversion
          if (stats.mtimeMs >= beforeConversion) {
            docxFiles.push({ file, mtime: stats.mtimeMs });
          }
        } catch (err) {
          console.error(`Error checking file ${file}:`, err);
        }
      }
    }
    
    if (docxFiles.length === 0) {
      console.error(`❌ No DOCX files found created after conversion`);
      console.error(`📂 All available files:`, files);
      throw new Error(`Conversion completed but output file not found. No .docx files were created.`);
    }
    
    // Sort by modification time (newest first) and pick the first
    docxFiles.sort((a, b) => b.mtime - a.mtime);
    const docxFile = docxFiles[0].file;
    
    console.log(`✅ Found newest output file: ${docxFile}`);

    docxPath = path.join(outputDir, docxFile);
    const docxBytes = await fs.readFile(docxPath);

    console.log(`✅ Converted to Word: ${docxBytes.length} bytes`);

    res.set({
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${req.file.originalname.replace(/\.pdf$/i, "")}.docx"`,
      "Content-Length": docxBytes.length,
    });

    res.send(docxBytes);
  } catch (error) {
    console.error("❌ PDF to Word error:", error.message);
    res.status(500).json({
      error: "Conversion failed",
      message: error.message,
      suggestion: "Try a text-based PDF (not a scanned document).",
    });
  } finally {
    // ✅ GUARANTEED cleanup - runs even if LibreOffice fails
    await safeUnlink(inputPath);
    await safeUnlink(docxPath);
  }
});

// ============================================
// TOOL 10: Word to PDF
// ============================================
app.post("/api/word-to-pdf", upload.single("file"), async (req, res) => {
  console.log("📥 Word to PDF request received");
  let inputPath, pdfPath;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    inputPath = req.file.path;
    const hasLibreOffice = await checkLibreOffice();

    if (!hasLibreOffice) {
      return res.status(501).json({
        error: "Feature not available",
        message:
          "Word to PDF requires LibreOffice to be installed on the server.",
        suggestion: "This feature is coming soon!",
      });
    }

    console.log("🔧 Using LibreOffice for Word to PDF conversion");
    
    // Get timestamp before conversion to identify new files
    const beforeConversion = Date.now();
    
    const command =
      `libreoffice --headless --nologo --nofirststartwizard --norestore ` +
      `-env:UserInstallation=${LO_PROFILE} ` +
      `--convert-to pdf ` +
      `--outdir "${outputDir}" "${inputPath}"`;

    console.log(`📝 Running command: ${command}`);
    await execPromise(command, { timeout: 90000 }); // 90 second timeout

    // Longer delay to ensure file is fully written
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Find the newest .pdf file created after conversion started
    const files = await fs.readdir(outputDir);
    console.log(`📂 Files in output directory:`, files);
    
    // Get all .pdf files with their stats
    const pdfFiles = [];
    for (const file of files) {
      if (file.toLowerCase().endsWith('.pdf')) {
        const filePath = path.join(outputDir, file);
        try {
          const stats = await fs.stat(filePath);
          // Only consider files created/modified after we started conversion
          if (stats.mtimeMs >= beforeConversion) {
            pdfFiles.push({ file, mtime: stats.mtimeMs });
          }
        } catch (err) {
          console.error(`Error checking file ${file}:`, err);
        }
      }
    }
    
    if (pdfFiles.length === 0) {
      console.error(`❌ No PDF files found created after conversion`);
      console.error(`📂 All available files:`, files);
      throw new Error(`Conversion completed but output file not found. No .pdf files were created.`);
    }
    
    // Sort by modification time (newest first) and pick the first
    pdfFiles.sort((a, b) => b.mtime - a.mtime);
    const pdfFile = pdfFiles[0].file;
    
    console.log(`✅ Found newest output file: ${pdfFile}`);

    pdfPath = path.join(outputDir, pdfFile);
    const pdfBytes = await fs.readFile(pdfPath);

    console.log(`✅ Converted to PDF: ${pdfBytes.length} bytes`);

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${req.file.originalname.replace(/\.(docx?|doc)$/i, "")}.pdf"`,
      "Content-Length": pdfBytes.length,
    });

    res.send(pdfBytes);
  } catch (error) {
    console.error("❌ Word to PDF error:", error.message);
    res.status(500).json({
      error: "Conversion failed",
      message: error.message,
    });
  } finally {
    // ✅ GUARANTEED cleanup - runs even if LibreOffice fails
    await safeUnlink(inputPath);
    await safeUnlink(pdfPath);
  }
});

// ============================================
// HEALTH CHECK
// ============================================
app.get("/api/health", async (req, res) => {
  const hasGs = await isGhostscriptAvailable();
  const hasLibre = await checkLibreOffice();
  res.json({
    status: "OK",
    message: "getPDFpress API is running",
    ghostscript: hasGs ? "available" : "not available",
    libreoffice: hasLibre ? "available" : "not available",
    compression: hasGs ? "Real (Ghostscript)" : "Basic (pdf-lib)",
    wordTools: hasLibre ? "Available" : "Not available",
  });
});

// ============================================
// ✅ MULTER ERROR HANDLER - MUST BE AFTER ALL ROUTES!
// ============================================
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: "File too large",
        message:
          "File must be under 50MB. Try compressing it first or splitting it into smaller files.",
        maxSize: "50MB",
      });
    }
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// ============================================
// START SERVER
// ============================================
const server = app.listen(PORT, async () => {
  const hasGs = await isGhostscriptAvailable();
  const hasLibre = await checkLibreOffice();
  console.log(`🚀 getPDFpress API running on port ${PORT}`);
  console.log(`📝 Test it: http://localhost:${PORT}/api/health`);
  console.log(
    `🔧 Compression: ${hasGs ? "REAL (Ghostscript)" : "BASIC (pdf-lib only)"}`,
  );
  console.log(
    `📄 Word Tools: ${hasLibre ? "AVAILABLE (LibreOffice)" : "NOT AVAILABLE"}`,
  );
  if (!hasGs) {
    console.log("⚠️  Install Ghostscript for better compression!");
  }
  if (!hasLibre) {
    console.log("⚠️  Install LibreOffice for PDF↔Word conversion!");
  }
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
// Handle shutdown signals gracefully (important for Render.com)
process.on('SIGTERM', () => {
  console.log('📴 SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed successfully');
    process.exit(0);
  });
  
  // Force shutdown after 10 seconds if graceful shutdown hangs
  setTimeout(() => {
    console.error('⚠️  Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
});

process.on('SIGINT', () => {
  console.log('📴 SIGINT received, shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed successfully');
    process.exit(0);
  });
});

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

