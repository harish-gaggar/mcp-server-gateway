# Google Drive MCP Server

A simple Model Context Protocol (MCP) server for interacting with Google Drive via HTTP.

## Features

- **search_files**: Search for files in Google Drive
- **get_file_metadata**: Get detailed metadata for a specific file
- **list_files**: List recent files from Google Drive

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Start the Server

```bash
npm start
```

The server will start on `http://localhost:3001`

### 3. Setup Google Drive Authentication

To access your real Google Drive files:

1. See detailed instructions in **[SETUP_AUTH.md](./SETUP_AUTH.md)**

2. Quick summary:
   - Create a Google Cloud project
   - Enable Google Drive API
   - Create OAuth 2.0 credentials (Desktop app)
   - Download `credentials.json` to this directory
   - Run `npm run auth` to authenticate

3. The authentication process will:
   - Open your browser
   - Ask you to sign in to Google
   - Grant access to read your Drive files
   - Save your access token

**Without authentication, the server runs in mock mode.**

### 4. Connect with MCP Inspector

1. Start MCP Inspector in a separate terminal:
   ```bash
   npx @modelcontextprotocol/inspector
   ```

2. The Inspector will open in your browser automatically, or visit the URL shown

3. In the Inspector interface:
   - Set **Transport Type** to `Streamable HTTP`
   - Set **URL** to `http://localhost:3001/mcp`
   - Click **Connect**

4. You should now see the 3 available tools: `list_files`, `search_files`, and `get_file_metadata`

## Tools Available

### search_files
Search for files using Google Drive query syntax.

**Parameters:**
- `query` (string, required): Search query
- `maxResults` (number, optional): Max results (default: 10)

**Example query:** `"name contains 'report'"`

### get_file_metadata
Get detailed metadata for a specific file.

**Parameters:**
- `fileId` (string, required): Google Drive file ID

### list_files
List recent files from Google Drive.

**Parameters:**
- `maxResults` (number, optional): Max results (default: 10)
- `orderBy` (string, optional): Sort order (default: "modifiedTime desc")

## Endpoints

- **GET /health** - Health check endpoint
- **POST /mcp** - MCP protocol endpoint (Streamable HTTP transport)
- **GET /** - Server information

## Environment Variables

- `PORT` - Server port (default: 3001)

## Architecture

This server uses a **stateless HTTP transport** model:
- Each MCP request creates a new server instance
- No persistent connections or sessions
- Suitable for serverless and containerized deployments
- Based on the official MCP Google Drive server implementation

