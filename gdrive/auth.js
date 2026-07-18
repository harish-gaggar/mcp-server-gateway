#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import http from 'http';
import { URL } from 'url';
import open from 'open';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

async function authenticate() {
  try {
    // Load client secrets from credentials.json
    const content = await fs.readFile(CREDENTIALS_PATH, 'utf8');
    const credentials = JSON.parse(content);
    
    const { client_secret, client_id } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);

    // Check if we already have a token
    try {
      const token = await fs.readFile(TOKEN_PATH, 'utf8');
      oAuth2Client.setCredentials(JSON.parse(token));
      console.log('✅ Already authenticated! Token found.');
      
      // Test the token
      const drive = google.drive({ version: 'v3', auth: oAuth2Client });
      const res = await drive.files.list({ pageSize: 1 });
      console.log('✅ Token is valid and working!');
      return;
    } catch (err) {
      // No token yet, need to authenticate
      console.log('🔐 No valid token found. Starting OAuth flow...\n');
    }

    // Generate auth URL
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
    });

    console.log('Opening browser for authorization...');
    console.log('If browser doesn\'t open, visit this URL manually:\n');
    console.log(authUrl);
    console.log('');

    // Create a local server to receive the OAuth callback
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://localhost:3000`);
        
        if (url.pathname === '/oauth2callback') {
          const code = url.searchParams.get('code');
          
          if (code) {
            // Exchange code for token
            const { tokens } = await oAuth2Client.getToken(code);
            oAuth2Client.setCredentials(tokens);
            
            // Save token
            await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2));
            
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
              <!DOCTYPE html>
              <html>
              <head>
                <title>Authentication Successful</title>
                <style>
                  body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                  .success { color: #4CAF50; font-size: 24px; margin-bottom: 20px; }
                </style>
              </head>
              <body>
                <div class="success">✅ Authentication Successful!</div>
                <p>You can close this window and return to the terminal.</p>
                <p>Your Google Drive MCP server is now connected.</p>
              </body>
              </html>
            `);
            
            console.log('\n✅ Authentication successful!');
            console.log('✅ Token saved to token.json');
            console.log('\nYou can now start your MCP server with: npm start');
            
            server.close();
            process.exit(0);
          } else {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<h1>Authentication failed - no code received</h1>');
            server.close();
            process.exit(1);
          }
        }
      } catch (err) {
        console.error('Error during OAuth callback:', err);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<h1>Authentication error</h1>');
        server.close();
        process.exit(1);
      }
    });

    server.listen(3000, () => {
      console.log('Waiting for authentication...');
      // Open browser
      open(authUrl).catch(err => {
        console.log('Could not open browser automatically.');
      });
    });

  } catch (err) {
    console.error('❌ Error during authentication setup:');
    if (err.code === 'ENOENT') {
      console.error('\n⚠️  credentials.json not found!');
      console.error('\nPlease follow these steps:');
      console.error('1. Go to https://console.cloud.google.com/');
      console.error('2. Create a project and enable Google Drive API');
      console.error('3. Create OAuth 2.0 credentials (Desktop app)');
      console.error('4. Download the credentials and save as credentials.json');
      console.error('5. Run this script again: npm run auth');
      console.error('\nSee SETUP_AUTH.md for detailed instructions.');
    } else {
      console.error(err);
    }
    process.exit(1);
  }
}

authenticate();

