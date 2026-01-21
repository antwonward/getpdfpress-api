# Dockerfile - Complete with Ghostscript + LibreOffice + GraphicsMagick
# Optimized for Render.com deployment

FROM node:18-slim

# Install all required system dependencies
# - Ghostscript: PDF compression
# - LibreOffice: PDF ↔ Word conversion
# - GraphicsMagick: PDF to JPG conversion
# - Fonts: Better document rendering
RUN apt-get update && \
    apt-get install -y \
    ghostscript \
    libreoffice \
    libreoffice-writer \
    graphicsmagick \
    fonts-liberation \
    fonts-dejavu \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files first (better layer caching)
COPY package*.json ./

# Install Node dependencies
RUN npm install --omit=dev

# Copy application code
COPY . .

# Create necessary directories with proper permissions
RUN mkdir -p uploads output /tmp/lo-profile /tmp/lo-init && \
    chmod 777 uploads output /tmp/lo-profile /tmp/lo-init && \
    echo "Test" > /tmp/lo-init/test.txt && \
    libreoffice --headless --nofirststartwizard --nologo \
      -env:UserInstallation=file:///tmp/lo-profile \
      --convert-to pdf /tmp/lo-init/test.txt --outdir /tmp/lo-init 2>/dev/null || true && \
    libreoffice --headless --nofirststartwizard --nologo \
      -env:UserInstallation=file:///tmp/lo-profile \
      --convert-to docx /tmp/lo-init/test.txt --outdir /tmp/lo-init 2>/dev/null || true && \
    rm -rf /tmp/lo-init

# Expose port (Render will use PORT env var)
EXPOSE 10000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Run node directly (better signal handling than npm)
CMD ["node", "server.js"]
