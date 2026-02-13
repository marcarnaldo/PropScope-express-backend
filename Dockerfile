# Start from a Node.js 22 base image running on Debian slim (small but has what we need)
FROM node:22-slim

# Install Chromium and all the libraries it needs to run headless
# Puppeteer needs an actual browser installed on the machine
# We also install 'fonts-freefont-ttf' so web pages render text properly
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-freefont-ttf \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the Chromium we just installed instead of downloading its own
# This saves ~400MB and avoids download issues during build
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Create a folder inside the container to hold our app
WORKDIR /app

# Copy package.json first (before the rest of the code)
# Docker caches each step — if package.json hasn't changed, it skips reinstalling deps
# This makes rebuilds much faster when you only change code
COPY package.json package-lock.json* ./

# Install only production dependencies (skip devDependencies like jest, ts-jest, etc.)
# We keep tsx though since we need it to run TypeScript directly
RUN npm install --omit=dev && npm install tsx

# Now copy the rest of your source code into the container
COPY . .

# This is the command that runs when the container starts
# tsx lets us run TypeScript directly without compiling to JS first
CMD ["npx", "tsx", "src/index.ts"]