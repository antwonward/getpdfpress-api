# Dockerfile - MEMORY-OPTIMIZED for 512MB Render.com Free Tier
# Key optimizations:
# 1. Minimal base image
# 2. Only essential dependencies
# 3. Reduced LibreOffice footprint
# 4. Aggressive cleanup

FROM node:18-slim

# Memory limits for Node.js (prevent exceeding 512MB)
ENV NODE_OPTIONS="--max-old-space-size=400"
ENV HOME=/tmp
ENV TMPDIR=/tmp

# Install ONLY essential system dependencies
# Minimize LibreOffice installation to save memory
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ghostscript \
    libreoffice-writer-nogui \
    graphicsmagick \
    fonts-liberation \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/share/doc/* \
    && rm -rf /usr/share/man/* \
    && rm -rf /var/cache/debconf/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production && \
    npm cache clean --force

# Copy application code
COPY . .

# Create directories with proper permissions
RUN mkdir -p uploads output /tmp/lo-profile && \
    chmod 777 uploads output /tmp/lo-profile

# Pre-warm LibreOffice (reduces first-request memory spike)
RUN echo "Test" > /tmp/test.txt && \
    timeout 30 libreoffice --headless --nofirststartwizard --nologo \
      -env:UserInstallation=file:///tmp/lo-profile \
      --convert-to pdf /tmp/test.txt --outdir /tmp 2>/dev/null || true && \
    rm -rf /tmp/test.* /tmp/*.pdf

# Expose port
EXPOSE 10000

# Health check with longer intervals to reduce overhead
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Run with --expose-gc flag to allow manual garbage collection
CMD ["node", "--expose-gc", "server.js"]
