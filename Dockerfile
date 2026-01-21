# Dockerfile - Node.js with Ghostscript
FROM node:18-slim

# Install Ghostscript
RUN apt-get update && \
    apt-get install -y ghostscript && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy app source
COPY . .

# Create directories
RUN mkdir -p uploads output

# Expose port
EXPOSE 3000

# Start app
CMD ["npm", "start"]
