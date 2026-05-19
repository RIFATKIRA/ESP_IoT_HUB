# ── Stage 1: deps ────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy only package files first for better layer caching
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev


# ── Stage 2: production image ─────────────────────────────────────────────────
FROM node:20-alpine AS runner

# Add non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy installed node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY . .

# Set ownership to non-root user
RUN chown -R appuser:appgroup /app

USER appuser

# Your app listens on PORT (default 3000)
EXPOSE 3000

# Healthcheck — matches your /health endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Start the server
CMD ["node", "server.js"]