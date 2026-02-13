# Start from a Node.js 22 base image running on Debian slim
FROM node:22-slim

# Install Chromium and all the libraries it needs to run headless
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-freefont-ttf \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the Chromium we just installed
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Create a folder inside the container to hold our app
WORKDIR /app

# Copy package.json from the server folder
COPY server/package.json server/package-lock.json* ./

# Install production dependencies + tsx for running TypeScript
RUN npm install --omit=dev && npm install tsx

# Copy the rest of the server source code
COPY server/ .

# Run the app
CMD ["npx", "tsx", "src/index.ts"]