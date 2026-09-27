# Corporate TLS-inspecting proxies re-sign registry.npmjs.org; Node needs NODE_EXTRA_CA_CERTS.
# Build context supplies optional certs via Compose additional_contexts (no-op when empty).
FROM node:20-alpine AS builder
WORKDIR /app

RUN --mount=type=bind,from=certs,target=/tmp/certs \
    cat /tmp/certs/*-ca.pem > /usr/local/share/corporate-ca.crt 2>/dev/null \
    || touch /usr/local/share/corporate-ca.crt
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/corporate-ca.crt

COPY package*.json ./
COPY tsconfig.json ./
COPY src/ ./src/

RUN npm ci --production=false --no-audit

RUN npm run build

FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache wget

RUN --mount=type=bind,from=certs,target=/tmp/certs \
    cat /tmp/certs/*-ca.pem > /usr/local/share/corporate-ca.crt 2>/dev/null \
    || touch /usr/local/share/corporate-ca.crt
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/corporate-ca.crt

COPY package*.json ./

RUN npm ci --production --no-audit

COPY --from=builder /app/build ./build

EXPOSE 8080

ENV GITHUB_ENTERPRISE_URL=""
ENV GITHUB_TOKEN=""
ENV PORT="8080"

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "build/server.js"]
