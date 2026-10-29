FROM node:22-bookworm-slim

# Install build dependencies for native modules (better-sqlite3, etc.)
# python3-setuptools provides distutils which node-gyp requires
# ca-certificates: the Claude Code binary (AI sheet reading) talks HTTPS to Anthropic
RUN apt-get update && apt-get install -y \
    python3 \
    python3-setuptools \
    build-essential \
    ca-certificates \
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

# --- AI sheet reading (Claude) -----------------------------------------------
# The Claude Agent SDK (installed by npm ci above) brings its own Claude Code
# binary for this platform. Put it on PATH so an admin can run
# `docker exec -it <container> claude setup-token` (or `claude login`) on the
# server. Its sign-in and settings live on the data volume, so they survive
# image updates. See docs/ai-sheet-reading-runbook.md.
RUN ln -s "$(ls -d /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-*/claude | head -n1)" /usr/local/bin/claude \
    && claude --version
ENV CLAUDE_CONFIG_DIR=/app/data/claude

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
