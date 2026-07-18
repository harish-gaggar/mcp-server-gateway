FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit

COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app

RUN apk add --no-cache wget

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit

COPY --from=builder /app/dist ./dist/
COPY --from=builder /app/views ./views/
COPY configs ./configs/
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8090
ENTRYPOINT ["docker-entrypoint.sh"]
