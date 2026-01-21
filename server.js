// server.js - UPGRADED with REAL PDF Compression
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
    await fs.unlink(filePath); // ✅ this is the real delete
  } catch (_) {
    // ignore: file may already be deleted / missing / locked
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
async function compressWithGhostscript(inputPath, outputPath, targetSizeKB) {
  const hasGs = await isGhostscriptAvailable();

  if (!hasGs) {
    console.log("⚠️ Ghostscript not available, using fallback compression");
    return compressWithPdfLib(inputPath, outputPath);
  }

  console.log("🔧 Using Ghostscript for compression");

  // Determine compression quality based on target size
  let quality;
  if (targetSizeKB <= 200) {
    quality = "/screen"; // Lowest quality, smallest size (~72 DPI)
  } else if (targetSizeKB <= 500) {
    quality = "/ebook"; // Medium quality (~150 DPI)
  } else {
    quality = "/printer"; // Higher quality (~300 DPI)
  }

  const command = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=${quality} -dNOPAUSE -dQUIET -dBATCH -dDetectDuplicateImages=true -dCompressFonts=true -sOutputFile="${outputPath}" "${inputPath}"`;

  try {
    console.log("📄 Executing Ghostscript compression...");
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
  try {
    if (!req.file) {
      console.log("❌ No file uploaded");
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { targetSize } = req.body; // "500" or "200" in KB
    const inputPath = req.file.path;
    const outputPath = path.join(outputDir, `compressed-${Date.now()}.pdf`);
    const targetSizeKB = parseInt(targetSize);

    console.log(
      `📄 Processing: ${req.file.originalname} (${req.file.size} bytes)`,
    );
    console.log(`🎯 Target size: ${targetSize}KB`);

    // Use Ghostscript for real compression
    await compressWithGhostscript(inputPath, outputPath, targetSizeKB);

    // Read the compressed file
    const compressedBytes = await fs.readFile(outputPath);
    console.log(
      `✅ Compressed: ${compressedBytes.length} bytes (${Math.round((1 - compressedBytes.length / req.file.size) * 100)}% reduction)`,
    );

    // Clean up
    await safeUnlink(inputPath);
    await safeUnlink(outputPath);

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
  }
});

// ============================================
// TOOL 3: MERGE PDFs
// ============================================
app.post("/api/merge", upload.array("files", 10), async (req, res) => {
  try {
    const mergedPdf = await PDFDocument.create();

    // Process each file
    for (const file of req.files) {
      const pdfBytes = await fs.readFile(file.path);
      const pdf = await PDFDocument.load(pdfBytes);
      const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      pages.forEach((page) => mergedPdf.addPage(page));
      await safeUnlink(file.path); // Clean up
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
  }
});

// ============================================
// TOOL 4: SPLIT PDF
// ============================================
app.post("/api/split", upload.single("file"), async (req, res) => {
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
        data: Buffer.from(pdfBytes).toString("base64"),
      });
    }

    await safeUnlink(inputPath);

    res.json({
      success: true,
      files: splitPdfs,
    });
  } catch (error) {
    console.error("Split error:", error);
    res.status(500).json({ error: "Split failed" });
  }
});

// ============================================
// TOOL 5: JPG to PDF
// ============================================
app.post("/api/jpg-to-pdf", upload.array("files", 20), async (req, res) => {
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

      await safeUnlink(file.path); // Clean up
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
  }
});

// ============================================
// TOOL 6: PDF to JPG
// ============================================
app.post("/api/pdf-to-jpg", upload.single("file"), async (req, res) => {
  try {
    const inputPath = req.file.path;

    const options = {
      density: 200,
      saveFilename: "page",
      savePath: outputDir,
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

    await safeUnlink(inputPath);

    res.json({
      success: true,
      images: images,
    });
  } catch (error) {
    console.error("PDF to JPG error:", error);
    res.status(500).json({ error: "Conversion failed" });
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
  try {
    const { password } = req.body;
    const inputPath = req.file.path;

    const pdfBytes = await fs.readFile(inputPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);

    // Note: pdf-lib doesn't support encryption natively
    // You'll need qpdf or similar tool for real encryption
    // This is a placeholder

    const protectedBytes = await pdfDoc.save();

    await safeUnlink(inputPath);

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="protected-${req.file.originalname}"`,
    });

    res.send(Buffer.from(protectedBytes));
  } catch (error) {
    console.error("Protection error:", error);
    res.status(500).json({ error: "Protection failed" });
  }
});

// ============================================
// TOOL 8: UNLOCK PDF (Remove Password)
// ============================================
app.post("/api/unlock", upload.single("file"), async (req, res) => {
  try {
    const { password } = req.body;
    const inputPath = req.file.path;

    const pdfBytes = await fs.readFile(inputPath);

    // Attempt to load with password
    const pdfDoc = await PDFDocument.load(pdfBytes, {
      ignoreEncryption: true,
    });

    const unlockedBytes = await pdfDoc.save();

    await safeUnlink(inputPath);

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="unlocked-${req.file.originalname}"`,
    });

    res.send(Buffer.from(unlockedBytes));
  } catch (error) {
    console.error("Unlock error:", error);
    res.status(500).json({ error: "Unlock failed - wrong password?" });
  }
});

// ============================================
// TOOL 9: PDF to Word
// ============================================
app.post("/api/pdf-to-word", upload.single("file"), async (req, res) => {
  console.log("📥 PDF to Word request received");
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const inputPath = req.file.path;
    const hasLibreOffice = await checkLibreOffice();

    if (!hasLibreOffice) {
      await safeUnlink(inputPath);
      return res.status(501).json({
        error: "Feature not available",
        message:
          "PDF to Word requires LibreOffice to be installed on the server.",
        suggestion: "This feature is coming soon!",
      });
    }

    console.log("🔧 Using LibreOffice for PDF to Word conversion");
    const command =
      `libreoffice --headless --nologo --nofirststartwizard --norestore ` +
      `-env:UserInstallation=${LO_PROFILE} ` +
      `--convert-to docx:"MS Word 2007 XML" ` +
      `--outdir "${outputDir}" "${inputPath}"`;

    try {
      await execPromise(command, { timeout: 90000 }); // 90 second timeout

      // Find the output file
      const files = await fs.readdir(outputDir);
      const baseName = path.basename(inputPath, path.extname(inputPath));
      const docxFile = files.find(
        (f) => f.includes(baseName) && f.endsWith(".docx"),
      );

      if (!docxFile) {
        throw new Error("Conversion completed but output file not found");
      }

      const docxPath = path.join(outputDir, docxFile);
      const docxBytes = await fs.readFile(docxPath);

      console.log(`✅ Converted to Word: ${docxBytes.length} bytes`);

      // Clean up
      await safeUnlink(inputPath);
      await safeUnlink(docxPath);

      res.set({
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${req.file.originalname.replace(/\.pdf$/i, "")}.docx"`,
        "Content-Length": docxBytes.length,
      });

      res.send(docxBytes);
    } catch (error) {
      console.error("❌ LibreOffice conversion failed:", error.message);
      await safeUnlink(inputPath);
      throw new Error(
        "Conversion failed. If this is a scanned PDF, OCR is required. Otherwise the file may be malformed.",
      );
    }
  } catch (error) {
    console.error("❌ PDF to Word error:", error.message);
    res.status(500).json({
      error: "Conversion failed",
      message: error.message,
      suggestion: "Try a text-based PDF (not a scanned document).",
    });
  }
});

// ============================================
// TOOL 10: Word to PDF
// ============================================
app.post("/api/word-to-pdf", upload.single("file"), async (req, res) => {
  console.log("📥 Word to PDF request received");
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const inputPath = req.file.path;
    const hasLibreOffice = await checkLibreOffice();

    if (!hasLibreOffice) {
      await safeUnlink(inputPath);
      return res.status(501).json({
        error: "Feature not available",
        message:
          "Word to PDF requires LibreOffice to be installed on the server.",
        suggestion: "This feature is coming soon!",
      });
    }

    console.log("🔧 Using LibreOffice for Word to PDF conversion");
    const command =
      `libreoffice --headless --nologo --nofirststartwizard --norestore ` +
      `-env:UserInstallation=${LO_PROFILE} ` +
      `--convert-to pdf ` +
      `--outdir "${outputDir}" "${inputPath}"`;

    try {
      await execPromise(command, { timeout: 90000 }); // 90 second timeout

      // Find the output file
      const files = await fs.readdir(outputDir);
      const baseName = path.basename(inputPath, path.extname(inputPath));
      const pdfFile = files.find(
        (f) => f.includes(baseName) && f.endsWith(".pdf"),
      );

      if (!pdfFile) {
        throw new Error("Conversion completed but output file not found");
      }

      const pdfPath = path.join(outputDir, pdfFile);
      const pdfBytes = await fs.readFile(pdfPath);

      console.log(`✅ Converted to PDF: ${pdfBytes.length} bytes`);

      // Clean up
      await safeUnlink(inputPath);
      await safeUnlink(pdfPath);

      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${req.file.originalname.replace(/\.(docx?|doc)$/i, "")}.pdf"`,
        "Content-Length": pdfBytes.length,
      });

      res.send(pdfBytes);
    } catch (error) {
      console.error("❌ LibreOffice conversion failed:", error.message);
      await safeUnlink(inputPath);
      throw new Error(
        "Word to PDF conversion failed. Make sure the Word document is valid.",
      );
    }
  } catch (error) {
    console.error("❌ Word to PDF error:", error.message);
    res.status(500).json({
      error: "Conversion failed",
      message: error.message,
    });
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
// Multer error handler middleware
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
app.listen(PORT, async () => {
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
