# getPDFpress Backend API

Professional PDF processing API for your getPDFpress.com website.

## Features

✅ Compress PDFs to 500KB or 200KB
✅ Merge multiple PDFs
✅ Split PDFs into pages
✅ Convert JPG to PDF
✅ Convert PDF to JPG
✅ Protect PDFs with password
✅ Unlock password-protected PDFs

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Run Locally
```bash
npm start
```

API will run on http://localhost:3000

### 3. Test It
```bash
curl http://localhost:3000/api/health
```

Should return: `{"status":"OK","message":"getPDFpress API is running"}`

## API Endpoints

All endpoints accept multipart/form-data

### POST /api/compress
Compress PDF to target size
- **Body:** `file` (PDF), `targetSize` ("500" or "200" in KB)
- **Returns:** Compressed PDF file

### POST /api/merge
Merge multiple PDFs into one
- **Body:** `files[]` (array of PDFs)
- **Returns:** Merged PDF file

### POST /api/split
Split PDF into individual pages
- **Body:** `file` (PDF), `pages` ("all" or range)
- **Returns:** JSON with base64 encoded PDF pages

### POST /api/jpg-to-pdf
Convert images to PDF
- **Body:** `files[]` (array of images)
- **Returns:** PDF file

### POST /api/pdf-to-jpg
Convert PDF pages to images
- **Body:** `file` (PDF)
- **Returns:** JSON with base64 encoded images

### POST /api/protect
Add password protection to PDF
- **Body:** `file` (PDF), `password` (string)
- **Returns:** Protected PDF file

### POST /api/unlock
Remove password from PDF
- **Body:** `file` (PDF), `password` (string)
- **Returns:** Unlocked PDF file

## Environment Variables

```bash
PORT=3000              # Server port
NODE_ENV=production    # Environment
```

## Deployment

### Render.com (Recommended)
1. Create account at render.com
2. New Web Service → Deploy from GitHub
3. Build: `npm install`
4. Start: `npm start`

### Railway.app
1. Create account at railway.app
2. New Project → Deploy from GitHub
3. Auto-deploys!

### Hostinger VPS
1. SSH into server
2. Install Node.js
3. Clone repo
4. `npm install && npm start`
5. Use PM2 to keep running

## File Size Limits

Default: 10MB per file
To change: Edit `multer` config in server.js

## Security Notes

⚠️ **For Production:**
- [ ] Add rate limiting
- [ ] Implement file type validation
- [ ] Add malware scanning
- [ ] Use HTTPS only
- [ ] Implement user authentication (if needed)
- [ ] Add logging
- [ ] Monitor disk usage
- [ ] Auto-cleanup old files

## Performance Tips

1. **Disk Space:** Uploaded files are temporarily stored. Add scheduled cleanup.
2. **Memory:** Large PDFs can use lots of RAM. Monitor and scale accordingly.
3. **Processing Time:** Complex operations may take time. Consider queue system for production.

## Troubleshooting

**CORS errors?**
- CORS is enabled by default for all origins
- For production, restrict to your domain only

**File upload fails?**
- Check file size limit (10MB default)
- Verify content-type is correct

**Compression not working well?**
- pdf-lib has basic compression
- For better results, install Ghostscript:
  ```bash
  npm install ghostscript4js
  ```

**Protection/Unlock not working?**
- pdf-lib has limited encryption support
- Consider using `qpdf` command-line tool:
  ```bash
  npm install node-qpdf2
  ```

## Development

```bash
# Install dev dependencies
npm install

# Run with auto-reload
npm run dev

# Test endpoints with curl
curl -X POST -F "file=@test.pdf" -F "targetSize=500" \
  http://localhost:3000/api/compress --output compressed.pdf
```

## License

MIT

## Support

Need help? Check the COMPLETE_DEPLOYMENT_GUIDE.md for step-by-step instructions.
