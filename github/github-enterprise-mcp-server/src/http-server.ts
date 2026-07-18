#!/usr/bin/env node

import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosInstance } from "axios";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// Environment variables for GitHub Enterprise
const GITHUB_ENTERPRISE_URL = process.env.GITHUB_ENTERPRISE_URL;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_ENTERPRISE_URL || !GITHUB_TOKEN) {
  console.error("Error: GITHUB_ENTERPRISE_URL and GITHUB_TOKEN environment variables must be set");
  process.exit(1);
}

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get("/health", (_req, res) => {
  res.json({ 
    status: "ok", 
    service: "github-enterprise-mcp-server-http",
    github_url: GITHUB_ENTERPRISE_URL
  });
});

// MCP endpoint - spawns a new STDIO server process for each request
app.post("/mcp", async (req, res) => {
  console.error(`New MCP request from ${req.ip}`);
  
  try {
    // Path to the main server script
    const serverScript = path.join(__dirname, "index.js");
    
    // Spawn the MCP server process with STDIO transport
    const serverProcess = spawn("node", [serverScript], {
      env: {
        ...process.env,
        GITHUB_ENTERPRISE_URL,
        GITHUB_TOKEN,
      },
      stdio: ["pipe", "pipe", "pipe"], // stdin, stdout, stderr
    });

    let responseData = "";
    let errorData = "";

    // Set up timeout
    const timeout = setTimeout(() => {
      serverProcess.kill();
      if (!res.headersSent) {
        res.status(504).json({ error: "Request timeout" });
      }
    }, 30000); // 30 second timeout

    // Handle stdout (MCP protocol messages)
    serverProcess.stdout.on("data", (data) => {
      responseData += data.toString();
    });

    // Handle stderr (logging)
    serverProcess.stderr.on("data", (data) => {
      errorData += data.toString();
      console.error(`Server log: ${data.toString().trim()}`);
    });

    // Send the request to the server via stdin
    if (req.body) {
      serverProcess.stdin.write(JSON.stringify(req.body) + "\n");
      serverProcess.stdin.end();
    }

    // Handle process completion
    serverProcess.on("close", (code) => {
      clearTimeout(timeout);
      
      if (res.headersSent) {
        return;
      }

      if (code === 0) {
        try {
          // Parse and return the MCP response
          const response = JSON.parse(responseData);
          res.json(response);
        } catch (error) {
          console.error("Failed to parse server response:", error);
          res.status(500).json({ 
            error: "Invalid server response",
            details: responseData 
          });
        }
      } else {
        console.error(`Server process exited with code ${code}`);
        res.status(500).json({ 
          error: "Server process failed",
          code,
          stderr: errorData 
        });
      }
    });

    // Handle process errors
    serverProcess.on("error", (error) => {
      clearTimeout(timeout);
      console.error("Failed to start server process:", error);
      if (!res.headersSent) {
        res.status(500).json({ 
          error: "Failed to start server",
          details: error.message 
        });
      }
    });

  } catch (error: any) {
    console.error("Request handler error:", error);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: "Internal server error",
        details: error.message 
      });
    }
  }
});

// SSE endpoint for MCP Inspector support
app.post("/sse", async (req, res) => {
  console.error(`New SSE connection from ${req.ip}`);
  
  try {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Path to the main server script
    const serverScript = path.join(__dirname, "index.js");
    
    // Spawn the MCP server process with STDIO transport
    const serverProcess = spawn("node", [serverScript], {
      env: {
        ...process.env,
        GITHUB_ENTERPRISE_URL,
        GITHUB_TOKEN,
      },
      stdio: ["pipe", "pipe", "pipe"], // stdin, stdout, stderr
    });

    // Forward stdout as SSE events
    serverProcess.stdout.on("data", (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          res.write(`data: ${line}\n\n`);
        }
      }
    });

    // Handle stderr (logging)
    serverProcess.stderr.on("data", (data) => {
      console.error(`SSE Server log: ${data.toString().trim()}`);
    });

    // Handle connection close from client
    req.on('close', () => {
      console.error('SSE connection closed by client');
      serverProcess.kill();
    });

    // Handle process completion
    serverProcess.on("close", (code) => {
      console.error(`SSE server process exited with code ${code}`);
      res.end();
    });

    // Handle process errors
    serverProcess.on("error", (error) => {
      console.error("SSE server process error:", error);
      res.end();
    });

  } catch (error: any) {
    console.error("SSE handler error:", error);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: "Internal server error",
        details: error.message 
      });
    }
  }
});

// Message endpoint for SSE (receives messages from client)
app.post("/message", async (req, res) => {
  console.error(`Received message on /message endpoint`);
  // For SSE, messages are typically sent via the SSE connection itself
  // This endpoint is here for compatibility but may not be used
  res.status(200).send();
});

// Start the HTTP server
app.listen(PORT, () => {
  console.error(`GitHub Enterprise MCP HTTP Server running on port ${PORT}`);
  console.error(`Health check: http://localhost:${PORT}/health`);
  console.error(`MCP endpoint: http://localhost:${PORT}/mcp`);
  console.error(`SSE endpoint: http://localhost:${PORT}/sse`);
  console.error(`Connected to GitHub Enterprise: ${GITHUB_ENTERPRISE_URL}`);
  console.error(`Transport: HTTP (POST) + SSE (Streamable HTTP)`);
  console.error(`Ready for GKE deployment`);
});


