#!/usr/bin/env node
/**
 * Minimal TLS-terminating reverse proxy (no dependencies).
 *
 * Terminates HTTPS on :8443 using an mkcert-issued, locally-trusted cert and
 * forwards to the gateway on http://127.0.0.1:8090. This exists because OAuth
 * clients (Cursor, Claude Desktop) refuse to run the MCP OAuth flow over plain
 * http:// — they require an https origin. With the mkcert CA installed in the
 * system trust store, https://localhost:8443 is trusted by those clients.
 *
 * Streaming (SSE) responses pass through unbuffered via pipe().
 *
 * Usage:  node scripts/https-proxy.mjs
 */
import fs from 'node:fs'
import https from 'node:https'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const TARGET_HOST = process.env.PROXY_TARGET_HOST || '127.0.0.1'
const TARGET_PORT = Number(process.env.PROXY_TARGET_PORT || 8090)
const LISTEN_PORT = Number(process.env.PROXY_LISTEN_PORT || 8443)

const here = path.dirname(fileURLToPath(import.meta.url))
const certDir = path.join(here, '..', 'certs')

let tlsOptions
try {
  tlsOptions = {
    key: fs.readFileSync(path.join(certDir, 'localhost-key.pem')),
    cert: fs.readFileSync(path.join(certDir, 'localhost.pem')),
  }
} catch (e) {
  console.error(
    `Could not read certs in ${certDir}.\n` +
      `Generate them first:\n` +
      `  mkcert -install\n` +
      `  mkcert -cert-file certs/localhost.pem -key-file certs/localhost-key.pem localhost 127.0.0.1 ::1`
  )
  process.exit(1)
}

const handler = (req, res) => {
  const proxyReq = http.request(
    {
      host: TARGET_HOST,
      port: TARGET_PORT,
      method: req.method,
      path: req.url,
      headers: {
        ...req.headers,
        'x-forwarded-proto': 'https',
        'x-forwarded-host': req.headers.host,
      },
    },
    proxyRes => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
      proxyRes.pipe(res)
    }
  )
  proxyReq.on('error', err => {
    res.writeHead(502, { 'content-type': 'text/plain' })
    res.end(`proxy error: ${err.message}`)
  })
  req.pipe(proxyReq)
}

// Bind BOTH IPv4 and IPv6 loopback. lvh.me / *.lvh.me resolve to 127.0.0.1
// (IPv4), and MCP clients (Cursor's undici) connect over IPv4 — so an
// IPv6-only bind yields ECONNREFUSED 127.0.0.1:8443. We listen on 0.0.0.0 for
// IPv4 and additionally on ::1 for clients that prefer IPv6.
https.createServer(tlsOptions, handler).listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(
    `HTTPS proxy listening on https://0.0.0.0:${LISTEN_PORT} -> http://${TARGET_HOST}:${TARGET_PORT}`
  )
})

https
  .createServer(tlsOptions, handler)
  .listen(LISTEN_PORT, '::1', () => {
    console.log(`HTTPS proxy also listening on https://[::1]:${LISTEN_PORT}`)
  })
  .on('error', err => {
    // Non-fatal: IPv6 loopback may be unavailable; IPv4 bind is what matters.
    console.warn(`IPv6 listener skipped: ${err.message}`)
  })
