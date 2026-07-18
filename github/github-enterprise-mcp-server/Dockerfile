# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files and TypeScript config
COPY package*.json ./
COPY tsconfig.json ./

# Copy source code
COPY src/ ./src/

# Install ALL dependencies (including dev dependencies for TypeScript)
RUN npm ci --production=false

# Build TypeScript to JavaScript
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ONLY production dependencies
RUN npm ci --production

# Copy compiled JavaScript from builder stage
COPY --from=builder /app/build ./build

# Expose the MCP server port
EXPOSE 8080

# Set environment variables (will be overridden by docker-compose or k8s)
ENV GITHUB_ENTERPRISE_URL=""
ENV GITHUB_TOKEN=""
ENV PORT="8080"

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Run the MCP HTTP server (STDIO with HTTP wrapper)
CMD ["node", "build/http-server.js"]

