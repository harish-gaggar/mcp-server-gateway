#!/usr/bin/env node

import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

// OAuth2 configuration
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

const app = express();

// Helper function to create authenticated Drive client
async function getAuthenticatedDriveClient() {
  try {
    // Check if we have credentials and token
    if (!existsSync(CREDENTIALS_PATH)) {
      console.log('⚠️  No credentials.json found. Using mock mode.');
      return null;
    }

    if (!existsSync(TOKEN_PATH)) {
      console.log('⚠️  No token.json found. Run "npm run auth" first. Using mock mode.');
      return null;
    }

    // Load credentials
    const credentialsContent = await fs.readFile(CREDENTIALS_PATH, 'utf8');
    const credentials = JSON.parse(credentialsContent);
    const { client_secret, client_id } = credentials.installed || credentials.web;

    // Load token
    const tokenContent = await fs.readFile(TOKEN_PATH, 'utf8');
    const token = JSON.parse(tokenContent);

    // Create OAuth2 client
    const oAuth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      'http://localhost:3000/oauth2callback'
    );
    oAuth2Client.setCredentials(token);

    // Create Drive client
    const drive = google.drive({ version: 'v3', auth: oAuth2Client });
    
    return drive;
  } catch (error) {
    console.error('Error creating authenticated Drive client:', error.message);
    return null;
  }
}

app.use(express.json({ limit: '50mb' }));

// Health check endpoint
app.get('/health', (req, res) => {
  console.log('Health check request');
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Google Drive MCP Server',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      mcp: '/mcp (POST for requests)'
    },
    instructions: 'Use POST /mcp with JSON-RPC 2.0 format or connect via MCP Inspector'
  });
});

// Helper function to create a server instance with handlers for each request
function createServerInstance() {
  const server = new Server(
    {
      name: 'gdrive-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Set up tool list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    console.log('Handling listTools request');
    return {
      tools: [
        {
          name: "search_files",
          description: "Search for files in Google Drive",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Search query (e.g., 'name contains \\'report\\'')",
              },
              maxResults: {
                type: "number",
                description: "Maximum number of results to return (default: 10)",
                default: 10,
              },
            },
            required: ["query"],
          },
        },
        {
          name: "get_file_metadata",
          description: "Get metadata for a specific file by ID",
          inputSchema: {
            type: "object",
            properties: {
              fileId: {
                type: "string",
                description: "The Google Drive file ID",
              },
            },
            required: ["fileId"],
          },
        },
        {
          name: "list_files",
          description: "List files in Google Drive",
          inputSchema: {
            type: "object",
            properties: {
              maxResults: {
                type: "number",
                description: "Maximum number of results to return (default: 10)",
                default: 10,
              },
              orderBy: {
                type: "string",
                description: "How to order results (e.g., 'modifiedTime desc', 'name')",
                default: "modifiedTime desc",
              },
            },
          },
        },
      ],
    };
  });

  // Set up call tool handler  
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    console.log('Handling callTool request for:', request.params.name);
    
    const { name, arguments: args } = request.params;
    const drive = await getAuthenticatedDriveClient();

    try {
      // If no authentication, return mock response
      if (!drive) {
        return {
          content: [
            {
              type: "text",
              text: `⚠️  Not authenticated with Google Drive\n\nTo connect your Google Drive:\n1. Follow the instructions in SETUP_AUTH.md\n2. Run: npm run auth\n3. Restart the server\n\nMock response for "${name}": ${JSON.stringify(args, null, 2)}`,
            },
          ],
        };
      }

      switch (name) {
        case "search_files": {
          const query = args?.query || '';
          const maxResults = args?.maxResults || 10;
          
          const response = await drive.files.list({
            q: query,
            pageSize: maxResults,
            fields: 'files(id, name, mimeType, modifiedTime, size, webViewLink)',
          });

          const files = response.data.files || [];
          if (files.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `No files found matching query: "${query}"`,
                },
              ],
            };
          }

          const filesList = files.map(f => 
            `📄 ${f.name}\n   ID: ${f.id}\n   Type: ${f.mimeType}\n   Modified: ${f.modifiedTime}\n   Link: ${f.webViewLink || 'N/A'}`
          ).join('\n\n');

          return {
            content: [
              {
                type: "text",
                text: `Found ${files.length} file(s):\n\n${filesList}`,
              },
            ],
          };
        }

        case "get_file_metadata": {
          const fileId = args?.fileId;
          if (!fileId) {
            throw new Error('fileId is required');
          }

          const response = await drive.files.get({
            fileId: fileId,
            fields: 'id, name, mimeType, modifiedTime, createdTime, size, webViewLink, owners, shared',
          });

          const file = response.data;
          const metadata = [
            `📄 File: ${file.name}`,
            `ID: ${file.id}`,
            `Type: ${file.mimeType}`,
            `Size: ${file.size ? (parseInt(file.size) / 1024).toFixed(2) + ' KB' : 'N/A'}`,
            `Created: ${file.createdTime}`,
            `Modified: ${file.modifiedTime}`,
            `Shared: ${file.shared ? 'Yes' : 'No'}`,
            `Owner: ${file.owners?.[0]?.displayName || 'Unknown'}`,
            `Link: ${file.webViewLink || 'N/A'}`,
          ].join('\n');

          return {
            content: [
              {
                type: "text",
                text: metadata,
              },
            ],
          };
        }

        case "list_files": {
          const maxResults = args?.maxResults || 10;
          const orderBy = args?.orderBy || 'modifiedTime desc';

          const response = await drive.files.list({
            pageSize: maxResults,
            orderBy: orderBy,
            fields: 'files(id, name, mimeType, modifiedTime, size, webViewLink)',
          });

          const files = response.data.files || [];
          if (files.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: 'No files found in your Google Drive.',
                },
              ],
            };
          }

          const filesList = files.map(f => 
            `📄 ${f.name}\n   ID: ${f.id}\n   Type: ${f.mimeType}\n   Modified: ${f.modifiedTime}\n   Link: ${f.webViewLink || 'N/A'}`
          ).join('\n\n');

          return {
            content: [
              {
                type: "text",
                text: `Recent files from your Google Drive:\n\n${filesList}`,
              },
            ],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      console.error(`Error in ${name}:`, error);
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// MCP endpoint - stateless mode
app.post('/mcp', async (req, res) => {
  console.log('Received MCP POST request');
  console.log('Request body:', req.body);

  // In stateless mode, create a new instance of transport for each request
  // to ensure complete isolation. A single instance would cause request ID collisions
  // when multiple clients connect concurrently.

  try {
    const server = createServerInstance();
    
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
});

// SSE not supported in stateless mode
app.get('/mcp', async (req, res) => {
  console.log('Received GET MCP request');
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed. Use POST for requests."
    },
    id: null
  }));
});

// Session termination not needed in stateless mode
app.delete('/mcp', async (req, res) => {
  console.log('Received DELETE MCP request');
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed."
    },
    id: null
  }));
});

// Start the server
app.listen(PORT, () => {
  console.log(`Google Drive MCP Server (HTTP) running on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

