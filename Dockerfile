# ═══════════════════════════════════════════════════════════
# BatonBot - Docker Image
# ═══════════════════════════════════════════════════════════
# NOTE: This app spawns child processes (cline, aider CLI tools)
# to execute AI agent tasks. For agent execution to work inside
# Docker, those CLI tools must be available in the container.
#
# Options:
# 1. Run the web UI only (no agents): This image works as-is.
#    The UI will load but agent tasks will fail with "command not found".
# 2. Install agent tools: Add RUN commands below to install cline/aider.
# 3. Use host tools: Mount the host's PATH or use docker-compose with
#    privileged mode to access host CLI tools.
# ═══════════════════════════════════════════════════════════

FROM node:20-alpine

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy application source
COPY . .

# Create logs directory with proper permissions
RUN mkdir -p logs

# Expose the application port
EXPOSE 4321

# Health check using the /health endpoint
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4321/health || exit 1

# Start the server
CMD ["node", "batonbot.js"]
