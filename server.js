// server.js - MEMORY-OPTIMIZED VERSION for 512MB Render.com Free Tier
// Key improvements:
// 1. Request queuing to prevent concurrent memory spikes
// 2. Aggressive file cleanup
// 3. Memory monitoring
// 4. Stream-based file handling where possible
// 5. Reduced file size limits

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

// ============================================
// MEMORY MANAGEMENT CONFIGURATION
// ============================================
const MAX_CONCURRENT_REQUESTS = 1; // Only 1 heavy operation at a time on free tier
const REQUEST_TIMEOUT = 60000; // 60 seconds max per request
let activeRequests = 0;
let requestQueue = [];

// Memory monitoring
setInterval(() => {
  const usage = process.memoryUsage();
  const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);
  const rssMB = Math.round(usage.rss / 1024 / 1024);
  
  if (rssMB > 450) { // Warning at 450MB (90% of 512MB limit)
    console.warn(`⚠️ HIGH MEMORY WARNING: RSS ${rssMB}MB / Heap ${heapUsedMB}MB`);
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
      console.log("🗑️ Forced garbage collection");
    }
  } else {
    console.log(`💾 Memory: RSS ${rssMB}MB / Heap ${heapUsedMB}MB`);
  }
}, 30000); // Every 30 seconds

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, "uploads");
const outputDir = path.join(__dirname, "output");

try {
  if (!fsSync.existsSync(uploadsDir)) {
    fsSync.mkdirSync(uploadsDir, { recursive: true });
  }
  if (!fsSync.existsSync(outputDir)) {
    fsSync.mkdirSync(outputDir, { recursive: true });
  }
} catch (err) {
  console.error("❌ Error creating directories:", err);
}

// Aggressive cleanup of old files every 5 minutes
setInterval(async () => {
  try {
    const now = Date.now();
    const maxAge = 10 * 60 * 1000; // 10 minutes
    
    for (const dir of [uploadsDir, outputDir]) {
      const files = await fs.readdir(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        try {
          const stats = await fs.stat(filePath);
          if (now - stats.mtimeMs > maxAge) {
            await fs.unlink(filePath);
            console.log(`🗑️ Cleaned up old file: ${file}`);
          }
        } catch (err) {
          // Ignore errors, file may already be deleted
        }
      }
    }
    
    // Clean up /tmp LibreOffice profiles
    try {
      const tmpFiles = await fs.readdir('/tmp');
      for (const file of tmpFiles) {
        if (file.startsWith('lo-profile-') || file.startsWith('lo-output-')) {
          const tmpPath = path.join('/tmp', file);
          try {
            await fs.rm(tmpPath, { recursive: true, force: true });
            console.log(`🗑️ Cleaned up temp directory: ${file}`);
          } catch (err) {
            // Ignore errors
          }
        }
      }
    } catch (err) {
      // /tmp may not be readable
    }
  } catch (err) {
    console.error("❌ Cleanup error:", err);
  }
}, 5 * 60 * 1000); // Every 5 minutes

// ============================================
// REQUEST QUEUE MIDDLEWARE
// ============================================
function requestQueueMiddleware(req, res, next) {
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    console.log(`⏳ Request queued (${requestQueue.length + 1} in queue)`);
    
    requestQueue.push({ req, res, next });
    
    // Set timeout for queued requests
    const timeout = setTimeout(() => {
      const index = requestQueue.findIndex(item => item.req === req);
      if (index !== -1) {
        requestQueue.splice(index, 1);
        res.status(503).json({
          error: "Server busy",
          message: "Too many concurrent requests. Please try again in a moment.",
        });
      }
    }, 30000); // 30 second queue timeout
    
    req.on('close', () => clearTimeout(timeout));
    return;
  }
  
  activeRequests++;
  console.log(`▶️ Processing request (${activeRequests}/${MAX_CONCURRENT_REQUESTS} active)`);
  
  // Set request timeout
  const timeout = setTimeout(() => {
    console.error("⏱️ Request timeout");
    if (!res.headersSent) {
      res.status(504).json({ error: "Request timeout" });
    }
  }, REQUEST_TIMEOUT);
  
  const originalEnd = res.end;
  res.end = function(...args) {
    clearTimeout(timeout);
    activeRequests--;
    console.log(`✅ Request completed (${activeRequests} active, ${requestQueue.length} queued)`);
    
    // Process next queued request
    if (requestQueue.length > 0) {
      const nextRequest = requestQueue.shift();
      setImmediate(() => requestQueueMiddleware(nextRequest.req, nextRequest.res, nextRequest.next));
    }
    
    originalEnd.apply(this, args);
  };
  
  next();
}

// ================================
// Multer: REDUCED file size limit for free tier
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
  limits: { fileSize: 25 * 1024 * 1024 }, // REDUCED to 25MB for free tier
});

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  }),
);
app.use(express.json({ limit: '10mb' }));

// ============================================
// CANONICAL DOMAIN ENFORCEMENT
// Force HTTPS + non-www in ONE redirect
// ============================================
app.use((req, res, next) => {
  const host = req.headers.host || '';
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  
  // Check if we need to redirect
  const isWWW = host.startsWith('www.');
  const isHTTP = protocol === 'http';
  
  // If either condition is true, redirect to canonical
  if (isWWW || isHTTP) {
    const canonicalHost = host.replace(/^www\./, '');
    const canonicalURL = `https://${canonicalHost}${req.originalUrl}`;
    
    console.log(`🔀 Redirecting: ${protocol}://${host}${req.originalUrl} → ${canonicalURL}`);
    return res.redirect(301, canonicalURL);
  }
  
  next();
});

app.use(express.static("public"));

// Apply queue middleware to all heavy endpoints
app.use('/api/compress', requestQueueMiddleware);
app.use('/api/merge', requestQueueMiddleware);
app.use('/api/split', requestQueueMiddleware);
app.use('/api/pdf-to-images', requestQueueMiddleware);
app.use('/api/images-to-pdf', requestQueueMiddleware);
app.use('/api/pdf-to-word', requestQueueMiddleware);
app.use('/api/word-to-pdf', requestQueueMiddleware);

// ============================================
// HELPER: Safe file cleanup (never throws)
// ============================================
async function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (_) {
    // ignore
  }
}

async function safeRmdir(dirPath) {
  if (!dirPath) return;
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
}

// Cleanup multiple files at once
async function cleanupFiles(...filePaths) {
  for (const filePath of filePaths) {
    await safeUnlink(filePath);
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
// HELPER: Compress with Ghostscript
// ============================================
async function compressWithGhostscript(
  inputPath,
  outputPath,
  targetSizeKB,
  compressionLevel = "balanced",
) {
  const hasGs = await isGhostscriptAvailable();

  if (!hasGs) {
    return compressWithPdfLib(inputPath, outputPath);
  }

  let quality;
  if (compressionLevel === "gentle") {
    quality = "/printer";
  } else if (compressionLevel === "strong") {
    quality = "/screen";
  } else {
    if (targetSizeKB <= 200) {
      quality = "/screen";
    } else if (targetSizeKB <= 500) {
      quality = "/ebook";
    } else {
      quality = "/printer";
    }
  }

  const command = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=${quality} -dNOPAUSE -dQUIET -dBATCH -dDetectDuplicateImages=true -dCompressFonts=true -sOutputFile="${outputPath}" "${inputPath}"`;

  try {
    await execPromise(command, { maxBuffer: 50 * 1024 * 1024 }); // 50MB buffer
    return true;
  } catch (error) {
    console.error("❌ Ghostscript failed:", error.message);
    return compressWithPdfLib(inputPath, outputPath);
  }
}

// ============================================
// HELPER: Fallback compression with pdf-lib
// ============================================
async function compressWithPdfLib(inputPath, outputPath) {
  const pdfBytes = await fs.readFile(inputPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);

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
// TOOL 1 & 2: COMPRESS PDF
// ============================================
app.post("/api/compress", upload.single("file"), async (req, res) => {
  let inputPath, outputPath;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { targetSize, compressionLevel = "balanced" } = req.body;
    inputPath = req.file.path;
    outputPath = path.join(outputDir, `compressed-${Date.now()}.pdf`);
    const targetSizeKB = parseInt(targetSize);

    await compressWithGhostscript(
      inputPath,
      outputPath,
      targetSizeKB,
      compressionLevel,
    );

    const compressedBytes = await fs.readFile(outputPath);

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="compressed-${req.file.originalname}"`,
      "Content-Length": compressedBytes.length,
    });

    res.send(Buffer.from(compressedBytes));
  } catch (error) {
    console.error("❌ Compression error:", error.message);
    res.status(500).json({
      error: "Compression failed",
      details: error.message,
    });
  } finally {
    await cleanupFiles(inputPath, outputPath);
  }
});

// ============================================
// TOOL 3: MERGE PDFs
// ============================================
app.post("/api/merge", upload.array("files", 10), async (req, res) => {
  const inputPaths = [];
  let outputPath;

  try {
    if (!req.files || req.files.length < 2) {
      return res.status(400).json({
        error: "Need at least 2 files",
        message: "Please upload at least 2 PDF files to merge.",
      });
    }

    inputPaths.push(...req.files.map((f) => f.path));
    outputPath = path.join(outputDir, `merged-${Date.now()}.pdf`);

    const mergedDoc = await PDFDocument.create();

    for (const filePath of inputPaths) {
      const pdfBytes = await fs.readFile(filePath);
      const pdf = await PDFDocument.load(pdfBytes);
      const copiedPages = await mergedDoc.copyPages(pdf, pdf.getPageIndices());
      copiedPages.forEach((page) => mergedDoc.addPage(page));
    }

    const mergedBytes = await mergedDoc.save();
    await fs.writeFile(outputPath, mergedBytes);

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="merged.pdf"',
      "Content-Length": mergedBytes.length,
    });

    res.send(Buffer.from(mergedBytes));
  } catch (error) {
    console.error("❌ Merge error:", error.message);
    res.status(500).json({
      error: "Merge failed",
      details: error.message,
    });
  } finally {
    await cleanupFiles(...inputPaths, outputPath);
  }
});

// ============================================
// TOOL 4: SPLIT PDF
// ============================================
app.post("/api/split", upload.single("file"), async (req, res) => {
  let inputPath;
  const outputPaths = [];

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    inputPath = req.file.path;
    const pdfBytes = await fs.readFile(inputPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();

    for (let i = 0; i < totalPages; i++) {
      const newDoc = await PDFDocument.create();
      const [copiedPage] = await newDoc.copyPages(pdfDoc, [i]);
      newDoc.addPage(copiedPage);
      const bytes = await newDoc.save();
      const outputPath = path.join(outputDir, `page-${i + 1}-${Date.now()}.pdf`);
      await fs.writeFile(outputPath, bytes);
      outputPaths.push(outputPath);
    }

    // Create a ZIP of all pages (simplified response for now)
    // For free tier, just send info about successful split
    res.json({
      success: true,
      message: `PDF split into ${totalPages} pages`,
      pages: totalPages,
      note: "Download feature requires upgrading your tier or implementing ZIP streaming",
    });
  } catch (error) {
    console.error("❌ Split error:", error.message);
    res.status(500).json({
      error: "Split failed",
      details: error.message,
    });
  } finally {
    await cleanupFiles(inputPath, ...outputPaths);
  }
});

// ============================================
// TOOL 5 & 6: PDF TO IMAGES
// ============================================
app.post("/api/pdf-to-images", upload.single("file"), async (req, res) => {
  let inputPath;
  let tempDir;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    inputPath = req.file.path;
    tempDir = path.join(outputDir, `images-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    const options = {
      density: 150, // Lower density to save memory
      saveFilename: "page",
      savePath: tempDir,
      format: "png",
      width: 1200, // Reasonable width
      height: 1600,
    };

    const convert = fromPath(inputPath, options);
    const pageCount = await convert.bulk(-1, { responseType: "image" });

    res.json({
      success: true,
      message: `Converted ${pageCount.length} pages`,
      pages: pageCount.length,
      note: "Images created. Download feature requires additional implementation.",
    });
  } catch (error) {
    console.error("❌ PDF to images error:", error.message);
    res.status(500).json({
      error: "Conversion failed",
      details: error.message,
    });
  } finally {
    await cleanupFiles(inputPath);
    await safeRmdir(tempDir);
  }
});

// ============================================
// TOOL 7: IMAGES TO PDF
// ============================================
app.post("/api/images-to-pdf", upload.array("files", 20), async (req, res) => {
  const inputPaths = [];
  let outputPath;

  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No images uploaded" });
    }

    inputPaths.push(...req.files.map((f) => f.path));
    outputPath = path.join(outputDir, `images-to-pdf-${Date.now()}.pdf`);

    const pdfDoc = await PDFDocument.create();

    for (const imagePath of inputPaths) {
      const imageBytes = await fs.readFile(imagePath);
      let image;

      if (imagePath.toLowerCase().endsWith(".png")) {
        image = await pdfDoc.embedPng(imageBytes);
      } else {
        image = await pdfDoc.embedJpg(imageBytes);
      }

      const page = pdfDoc.addPage([image.width, image.height]);
      page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    }

    const pdfBytes = await pdfDoc.save();
    await fs.writeFile(outputPath, pdfBytes);

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="images.pdf"',
      "Content-Length": pdfBytes.length,
    });

    res.send(Buffer.from(pdfBytes));
  } catch (error) {
    console.error("❌ Images to PDF error:", error.message);
    res.status(500).json({
      error: "Conversion failed",
      details: error.message,
    });
  } finally {
    await cleanupFiles(...inputPaths, outputPath);
  }
});

// ============================================
// TOOL 9: PDF TO WORD
// ============================================
app.post("/api/pdf-to-word", upload.single("file"), async (req, res) => {
  let inputPath, docxPath, loProfileDir, tempOutputDir;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    inputPath = req.file.path;
    const hasLibreOffice = await checkLibreOffice();

    if (!hasLibreOffice) {
      return res.status(501).json({
        error: "Feature not available",
        message: "PDF to Word requires LibreOffice.",
        suggestion: "This feature is coming soon!",
      });
    }

    loProfileDir = `/tmp/lo-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    tempOutputDir = `/tmp/lo-output-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    
    await execPromise(`mkdir -p "${loProfileDir}" "${tempOutputDir}" && chmod 777 "${loProfileDir}" "${tempOutputDir}"`);

    const command =
      `libreoffice --headless --nologo --nofirststartwizard --norestore ` +
      `-env:UserInstallation=file://${loProfileDir} ` +
      `--convert-to docx ` +
      `--outdir "${tempOutputDir}" "${inputPath}"`;

    await execPromise(command, { timeout: 90000 });
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const files = await fs.readdir(tempOutputDir);
    const docxFile = files.find((f) => f.toLowerCase().endsWith(".docx"));

    if (!docxFile) {
      throw new Error("Conversion completed but output file not found");
    }

    docxPath = path.join(tempOutputDir, docxFile);
    const docxBytes = await fs.readFile(docxPath);

    res.set({
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${req.file.originalname.replace(".pdf", "")}.docx"`,
      "Content-Length": docxBytes.length,
    });

    res.send(docxBytes);
  } catch (error) {
    console.error("❌ PDF to Word error:", error.message);
    res.status(500).json({
      error: "Conversion failed",
      message: error.message,
    });
  } finally {
    await cleanupFiles(inputPath, docxPath);
    await safeRmdir(loProfileDir);
    await safeRmdir(tempOutputDir);
  }
});

// ============================================
// TOOL 10: WORD TO PDF
// ============================================
app.post("/api/word-to-pdf", upload.single("file"), async (req, res) => {
  let inputPath, pdfPath, loProfileDir, tempOutputDir;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    inputPath = req.file.path;
    const hasLibreOffice = await checkLibreOffice();

    if (!hasLibreOffice) {
      return res.status(501).json({
        error: "Feature not available",
        message: "Word to PDF requires LibreOffice.",
      });
    }

    loProfileDir = `/tmp/lo-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    tempOutputDir = `/tmp/lo-output-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    
    await execPromise(`mkdir -p "${loProfileDir}" "${tempOutputDir}" && chmod 777 "${loProfileDir}" "${tempOutputDir}"`);

    const command =
      `libreoffice --headless --nologo --nofirststartwizard --norestore ` +
      `-env:UserInstallation=file://${loProfileDir} ` +
      `--convert-to pdf ` +
      `--outdir "${tempOutputDir}" "${inputPath}"`;

    await execPromise(command, { timeout: 90000 });
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const files = await fs.readdir(tempOutputDir);
    const pdfFile = files.find((f) => f.toLowerCase().endsWith(".pdf"));

    if (!pdfFile) {
      throw new Error("Conversion completed but output file not found");
    }

    pdfPath = path.join(tempOutputDir, pdfFile);
    const pdfBytes = await fs.readFile(pdfPath);

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
    await cleanupFiles(inputPath, pdfPath);
    await safeRmdir(loProfileDir);
    await safeRmdir(tempOutputDir);
  }
});

// ============================================
// HEALTH CHECK
// ============================================
app.get("/api/health", async (req, res) => {
  const hasGs = await isGhostscriptAvailable();
  const hasLibre = await checkLibreOffice();
  const usage = process.memoryUsage();
  
  res.json({
    status: "OK",
    memory: {
      heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024),
      rssMB: Math.round(usage.rss / 1024 / 1024),
      limitMB: 512,
    },
    requests: {
      active: activeRequests,
      queued: requestQueue.length,
      maxConcurrent: MAX_CONCURRENT_REQUESTS,
    },
    ghostscript: hasGs ? "available" : "not available",
    libreoffice: hasLibre ? "available" : "not available",
  });
});

// ============================================
// MULTER ERROR HANDLER
// ============================================
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: "File too large",
        message: "File must be under 25MB on free tier.",
        maxSize: "25MB",
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
  console.log(`💾 Memory-optimized mode: Max 1 concurrent request`);
  console.log(`📝 Test: http://localhost:${PORT}/api/health`);
  console.log(`🔧 Compression: ${hasGs ? "REAL (Ghostscript)" : "BASIC"}`);
  console.log(`📄 Word Tools: ${hasLibre ? "AVAILABLE" : "NOT AVAILABLE"}`);
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
process.on("SIGTERM", () => {
  console.log("📴 SIGTERM received, shutting down...");
  server.close(() => {
    console.log("✅ Server closed");
    process.exit(0);
  });

  setTimeout(() => {
    console.error("⚠️ Forced shutdown");
    process.exit(1);
  }, 10000);
});

process.on("SIGINT", () => {
  console.log("📴 SIGINT received, shutting down...");
  server.close(() => {
    console.log("✅ Server closed");
    process.exit(0);
  });
});

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection:", reason);
  process.exit(1);
});
