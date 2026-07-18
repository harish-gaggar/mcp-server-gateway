#!/usr/bin/env node

const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:8090';
const NAMESPACE = process.env.MCP_NAMESPACE || 'artifactory';

let sessionId = null;

async function rpc(method, params = undefined, id = 1) {
  const body = { jsonrpc: '2.0', id, method };
  if (params !== undefined) body.params = params;

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const response = await fetch(`${GATEWAY}/${NAMESPACE}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const newSession = response.headers.get('mcp-session-id');
  if (newSession) sessionId = newSession;

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} failed (${response.status}): ${text}`);
  }

  if (text.startsWith('event:')) {
    const dataLine = text.split('\n').find(line => line.startsWith('data: '));
    if (!dataLine) throw new Error(`No SSE data in response for ${method}`);
    return JSON.parse(dataLine.slice(6));
  }

  return JSON.parse(text);
}

async function main() {
  console.log(`Gateway: ${GATEWAY}`);
  console.log(`Namespace: ${NAMESPACE}`);

  const health = await fetch(`${GATEWAY}/health`);
  if (!health.ok) throw new Error(`/health returned ${health.status}`);
  console.log('health: ok');

  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'e2e-test', version: '1.0.0' },
  });
  if (init.error) throw new Error(`initialize error: ${init.error.message}`);
  console.log(`initialize: ${init.result?.serverInfo?.name || 'ok'}`);
  console.log(`session: ${sessionId || '(none)'}`);

  await rpc('notifications/initialized', {}, 2);

  const tools = await rpc('tools/list', {}, 3);
  if (tools.error) throw new Error(`tools/list error: ${tools.error.message}`);
  const names = (tools.result?.tools || []).map(t => t.name).join(', ');
  console.log(`tools/list: ${tools.result?.tools?.length || 0} tools (${names})`);

  console.log('e2e: passed');
}

main().catch(err => {
  console.error('e2e: failed');
  console.error(err.message);
  process.exit(1);
});
