FROM node:22-bookworm-slim

# Install build dependencies for native modules (better-sqlite3, etc.)
# python3-setuptools provides distutils which node-gyp requires
RUN apt-get update && apt-get install -y \
    python3 \
    python3-setuptools \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install dependencies
# --mount=type=cache persists the npm download cache across builds (BuildKit)
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Copy the rest of the application code
COPY . .

# Build the frontend
RUN npm run build

# --- Local AI (sheet reading) ----------------------------------------------
# This CPU image does NOT bundle the llama.cpp server, so the AI sheet-reading
# feature stays disabled here and page naming falls back to OCR. For GPU
# inference build the CUDA image instead: `Dockerfile.cuda` (see
# docs/ai-sheet-reading-runbook.md). The /models volume + AI_MODELS_DIR are
# declared for parity so the same compose/template works for both images.
ENV AI_MODELS_DIR=/models
VOLUME ["/models"]

# Set environment variables
ENV NODE_ENV=production
ENV STORAGE_PATH=/app/data
ENV PORT=3000

# Expose the port the app runs on
EXPOSE 3000

# Create the data directory
RUN mkdir -p /app/data

# Start the server
CMD ["npx", "tsx", "server.ts"]
