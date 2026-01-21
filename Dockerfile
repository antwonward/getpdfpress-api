# Dockerfile - Complete with Ghostscript + LibreOffice
# This enables ALL 8 PDF tools!

FROM node:18-slim

# Install Ghostscript (for compression) AND LibreOffice (for Word conversion)
RUN apt-get update && \
    apt-get install -y \
    ghostscript \
    libreoffice \
    libreoffice-writer \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm install --production

# Copy application code
COPY . .

# Create necessary directories
RUN mkdir -p uploads output

# Expose port
EXPOSE 3000

# Start application
CMD ["npm", "start"]
