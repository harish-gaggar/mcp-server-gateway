#!/usr/bin/env node
/**
 * GitHub MCP Server (streamable HTTP)
 *
 * Secure mode (default when GITHUB_TOKEN is unset): every request must carry
 * the user's GitHub OAuth access token in Authorization: Bearer, forwarded by
 * the MCP gateway after the user completes GitHub login + gateway consent.
 * No shared PAT is used — each tool call runs as the authenticated GitHub user.
 *
 * Optional GITHUB_ALLOWED_USERS (comma-separated logins) restricts which GitHub
 * accounts may use the server even after OAuth (defense in depth).
 */

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { createGithubClient, fetchAuthenticatedLogin, githubApiBase } from "./github-client.js";
import { registerGithubTools } from "./register-tools.js";
import { requestContext } from "./request-context.js";

const PORT = Number(process.env.PORT || 8080);
const SHARED_TOKEN = process.env.GITHUB_TOKEN?.trim();
/** When true, reject requests without a gateway-forwarded bearer token. */
const SECURE_MODE =
  process.env.GITHUB_SECURE_MODE === "true" ||
  (!SHARED_TOKEN && process.env.GITHUB_SECURE_MODE !== "false");

const ALLOWED_USERS = (process.env.GITHUB_ALLOWED_USERS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

if (SECURE_MODE) {
  console.log("Secure mode: per-user GitHub OAuth tokens via gateway Authorization bearer");
  console.log(`GitHub API: ${githubApiBase()}`);
  if (ALLOWED_USERS.length) {
    console.log(`Allowed GitHub users: ${ALLOWED_USERS.join(", ")}`);
  }
} else if (!SHARED_TOKEN) {
  console.warn("Warning: no GITHUB_TOKEN and secure mode off — API calls will fail.");
} else {
  console.warn("Open mode: using shared GITHUB_TOKEN from environment.");
}

function extractBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim();
}

async function authorizeRequest(token: string | undefined): Promise<string> {
  if (SECURE_MODE) {
    if (!token) {
      throw Object.assign(new Error("Unauthorized"), { status: 401 });
    }
  } else {
    token = token || SHARED_TOKEN;
    if (!token) {
      throw Object.assign(new Error("No GitHub token configured"), { status: 500 });
    }
  }

  const client = createGithubClient(token);
  const login = (await fetchAuthenticatedLogin(client)).toLowerCase();

  if (ALLOWED_USERS.length && !ALLOWED_USERS.includes(login)) {
    throw Object.assign(
      new Error(`GitHub user '${login}' is not authorized to use this MCP server`),
      { status: 403 }
    );
  }

  return token;
}

/**
 * Live Streamable HTTP transports keyed by MCP session id.
 *
 * The Streamable HTTP protocol is stateful: the client's `initialize` request
 * creates a session (returned via the `mcp-session-id` response header) and all
 * follow-up requests (`notifications/initialized`, `tools/list`, `tools/call`,
 * the GET notification stream, and the DELETE teardown) must reach the SAME
 * transport. Recreating a transport per request makes every follow-up fail with
 * "Bad Request: Server not initialized", so we keep them here until closed.
 */
const transports: Record<string, StreamableHTTPServerTransport> = {};

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "github-mcp-server",
    version: "2.0.0",
  });
  registerGithubTools(server);
  return server;
}

const app = express();
app.use(express.json({ limit: "4mb" }));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    server: "github-mcp-server",
    secure_mode: SECURE_MODE,
    github_api: githubApiBase(),
  });
});

async function handleMcp(req: express.Request, res: express.Response) {
  let token: string;
  try {
    token = await authorizeRequest(extractBearer(req.headers.authorization));
  } catch (err: unknown) {
    const status = (err as { status?: number }).status ?? 401;
    const message = err instanceof Error ? err.message : "Unauthorized";
    res.status(status).json({ error: message });
    return;
  }

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport = sessionId ? transports[sessionId] : undefined;

  if (!transport) {
    // Only a fresh `initialize` request may open a new session. Any other
    // request without a known session id is a protocol error.
    if (sessionId || !isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided",
        },
        id: null,
      });
      return;
    }

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: false,
      enableDnsRebindingProtection: false,
      onsessioninitialized: (sid) => {
        transports[sid] = transport!;
      },
    });

    transport.onclose = () => {
      if (transport!.sessionId) {
        delete transports[transport!.sessionId];
      }
    };

    await createMcpServer().connect(transport);
  }

  await requestContext.run({ token }, async () => {
    await transport!.handleRequest(req, res, req.body);
  });
}

app.post("/mcp", (req, res) => {
  handleMcp(req, res).catch((err) => {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  });
});

/**
 * GET opens the server->client notification stream and DELETE tears the session
 * down. Both must be routed to the existing transport for the session.
 */
async function handleSessionRequest(req: express.Request, res: express.Response) {
  let token: string;
  try {
    token = await authorizeRequest(extractBearer(req.headers.authorization));
  } catch (err: unknown) {
    const status = (err as { status?: number }).status ?? 401;
    const message = err instanceof Error ? err.message : "Unauthorized";
    res.status(status).json({ error: message });
    return;
  }

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports[sessionId] : undefined;
  if (!transport) {
    res.status(400).json({ error: "Invalid or missing session ID" });
    return;
  }

  await requestContext.run({ token }, async () => {
    await transport.handleRequest(req, res);
  });
}

app.get("/mcp", (req, res) => {
  handleSessionRequest(req, res).catch((err) => {
    console.error("MCP GET request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  });
});

app.delete("/mcp", (req, res) => {
  handleSessionRequest(req, res).catch((err) => {
    console.error("MCP DELETE request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`GitHub MCP Server listening on http://0.0.0.0:${PORT}/mcp`);
});
