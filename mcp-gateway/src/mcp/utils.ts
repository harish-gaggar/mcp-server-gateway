import {
  ErrorCode,
  JSONRPCErrorResponse,
} from '@modelcontextprotocol/sdk/types.js'

export function errorResponse(code: ErrorCode, message: string, status = 400) {
  const resp = JSON.stringify({
    jsonrpc: '2.0',
    error: { code, message },
  } satisfies JSONRPCErrorResponse)

  return new Response(resp, {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
