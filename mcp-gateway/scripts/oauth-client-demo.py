#!/usr/bin/env python3
"""
End-to-end MCP OAuth reference client (no third-party deps).

Demonstrates, against the local MCP Gateway in secure mode, the full
per-user authorization flow that a real MCP client performs:

  1. Hit the protected MCP endpoint  -> 401 + WWW-Authenticate pointer
  2. Fetch protected-resource + authorization-server metadata (RFC 9728 / 8414)
  3. Dynamic Client Registration (DCR, RFC 7591)
  4. Authorization Code + PKCE: open the browser so the user signs in with
     Google and approves the gateway's consent screen
  5. Exchange the code for the gateway's opaque, wrapped access token
  6. Call an MCP tool (initialize -> notifications/initialized -> tools/call)
     with that token and print the live, user-authorized result

Run:
    python3 scripts/oauth-client-demo.py
    python3 scripts/oauth-client-demo.py --tool get_system_info

The only interactive step is the browser login + consent (step 4), which is
the whole point of the demo.
"""

import argparse
import base64
import hashlib
import http.server
import json
import secrets
import ssl
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from typing import Optional

# Populated from --insecure; lets the demo talk to https://localhost:8443 even
# before the mkcert CA is trusted by Python's certifi bundle.
_SSL_CTX: Optional[ssl.SSLContext] = None

# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #
DEFAULT_GATEWAY = "http://localhost:8090"
DEFAULT_NAMESPACE = "artifactory"
CALLBACK_HOST = "localhost"
CALLBACK_PORT = 8765
CALLBACK_PATH = "/callback"


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def http_json(method: str, url: str, *, headers=None, data=None):
    """Minimal JSON/text HTTP helper. Returns (status, headers, body_text)."""
    body = None
    hdrs = dict(headers or {})
    if data is not None:
        if isinstance(data, (dict, list)):
            body = json.dumps(data).encode()
            hdrs.setdefault("Content-Type", "application/json")
        elif isinstance(data, bytes):
            body = data
        else:
            body = str(data).encode()
    req = urllib.request.Request(url, data=body, method=method, headers=hdrs)
    try:
        resp = urllib.request.urlopen(req, context=_SSL_CTX)
        return resp.status, dict(resp.headers), resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode("utf-8", "replace")


def parse_sse_json(body: str):
    """Extract the last JSON object from an SSE (text/event-stream) body, or
    fall back to parsing the whole body as JSON."""
    payloads = []
    for line in body.splitlines():
        if line.startswith("data:"):
            payloads.append(line[len("data:"):].strip())
    candidate = "\n".join(payloads) if payloads else body.strip()
    if not candidate:
        return None
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        # Multiple data blocks: try the last non-empty one
        for chunk in reversed(payloads):
            try:
                return json.loads(chunk)
            except json.JSONDecodeError:
                continue
    return None


# --------------------------------------------------------------------------- #
# Local redirect capture server
# --------------------------------------------------------------------------- #
class _CallbackState:
    code: Optional[str] = None
    state: Optional[str] = None
    error: Optional[str] = None
    event = threading.Event()


class _CallbackHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != CALLBACK_PATH:
            self.send_response(404)
            self.end_headers()
            return
        qs = urllib.parse.parse_qs(parsed.query)
        _CallbackState.code = (qs.get("code") or [None])[0]
        _CallbackState.state = (qs.get("state") or [None])[0]
        _CallbackState.error = (qs.get("error") or [None])[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        msg = "Authorization complete. You can close this tab and return to the terminal."
        if _CallbackState.error:
            msg = f"Authorization failed: {_CallbackState.error}"
        self.wfile.write(
            f"<html><body style='font-family:sans-serif;padding:40px'>"
            f"<h2>{msg}</h2></body></html>".encode()
        )
        _CallbackState.event.set()

    def log_message(self, *_):  # silence default logging
        pass


def wait_for_code(timeout=300):
    server = http.server.HTTPServer((CALLBACK_HOST, CALLBACK_PORT), _CallbackHandler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    got = _CallbackState.event.wait(timeout)
    server.shutdown()
    if not got:
        raise TimeoutError("Timed out waiting for the OAuth redirect.")
    if _CallbackState.error:
        raise RuntimeError(f"Authorization error: {_CallbackState.error}")
    return _CallbackState.code, _CallbackState.state


# --------------------------------------------------------------------------- #
# Main flow
# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--gateway", default=DEFAULT_GATEWAY)
    ap.add_argument("--namespace", default=DEFAULT_NAMESPACE)
    ap.add_argument("--tool", default="list_repositories")
    ap.add_argument("--args", default="{}", help="JSON object of tool arguments")
    ap.add_argument("--insecure", action="store_true",
                    help="skip TLS verification (for https://localhost with an "
                         "mkcert cert whose CA is not yet trusted)")
    args = ap.parse_args()

    global _SSL_CTX
    if args.insecure:
        _SSL_CTX = ssl.create_default_context()
        _SSL_CTX.check_hostname = False
        _SSL_CTX.verify_mode = ssl.CERT_NONE

    gw = args.gateway.rstrip("/")
    ns = args.namespace
    mcp_url = f"{gw}/{ns}/mcp"
    redirect_uri = f"http://{CALLBACK_HOST}:{CALLBACK_PORT}{CALLBACK_PATH}"

    def step(n, msg):
        print(f"\n\033[1m[{n}] {msg}\033[0m")

    # 1) Unauthenticated probe -> 401 + WWW-Authenticate
    step(1, f"Probe protected endpoint {mcp_url} (expect 401)")
    status, hdrs, _ = http_json(
        "POST", mcp_url,
        headers={"Accept": "application/json, text/event-stream"},
        data={"jsonrpc": "2.0", "id": 0, "method": "tools/list"},
    )
    www = hdrs.get("WWW-Authenticate") or hdrs.get("www-authenticate", "")
    print(f"    status={status}")
    print(f"    WWW-Authenticate: {www}")
    if status != 401:
        print("    (!) Expected 401. Is the gateway in secure mode?")

    # 2) Discovery
    step(2, "Fetch OAuth discovery metadata")
    pr_url = f"{gw}/.well-known/oauth-protected-resource/{ns}/mcp"
    _, _, pr_body = http_json("GET", pr_url)
    pr = json.loads(pr_body)
    auth_server = pr["authorization_servers"][0]
    print(f"    resource:              {pr['resource']}")
    print(f"    authorization_server:  {auth_server}")

    as_url = f"{gw}/.well-known/oauth-authorization-server/{ns}"
    _, _, as_body = http_json("GET", as_url)
    meta = json.loads(as_body)
    reg_ep = meta["registration_endpoint"]
    auth_ep = meta["authorization_endpoint"]
    token_ep = meta["token_endpoint"]
    print(f"    registration_endpoint: {reg_ep}")
    print(f"    authorization_endpoint:{auth_ep}")
    print(f"    token_endpoint:        {token_ep}")

    # 3) Dynamic Client Registration
    step(3, "Dynamic Client Registration (DCR)")
    status, _, reg_body = http_json(
        "POST", reg_ep,
        data={
            "client_name": "oauth-client-demo",
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "client_secret_post",
        },
    )
    if status not in (200, 201):
        print(f"    DCR failed: {status} {reg_body}")
        sys.exit(1)
    reg = json.loads(reg_body)
    client_id = reg["client_id"]
    client_secret = reg.get("client_secret", "")
    print(f"    client_id={client_id}")

    # 4) Authorization Code + PKCE (browser: Google login + gateway consent)
    step(4, "Authorization + consent (browser opens)")
    verifier = b64url(secrets.token_bytes(32))
    challenge = b64url(hashlib.sha256(verifier.encode()).digest())
    state = b64url(secrets.token_bytes(16))
    authorize_url = auth_ep + "?" + urllib.parse.urlencode({
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
        "scope": "openid email",
    })
    print("    Opening browser. Sign in with Google, then click Authorize on the")
    print("    gateway consent screen. If the browser does not open, visit:")
    print(f"    {authorize_url}")
    webbrowser.open(authorize_url)
    code, returned_state = wait_for_code()
    if returned_state != state:
        print("    (!) state mismatch — possible CSRF; aborting.")
        sys.exit(1)
    print("    Received authorization code from redirect.")

    # 5) Token exchange
    step(5, "Exchange authorization code for access token")
    form = urllib.parse.urlencode({
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": client_id,
        "client_secret": client_secret,
        "code_verifier": verifier,
    }).encode()
    status, _, tok_body = http_json(
        "POST", token_ep,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data=form,
    )
    if status != 200:
        print(f"    Token exchange failed: {status} {tok_body}")
        sys.exit(1)
    tok = json.loads(tok_body)
    access_token = tok["access_token"]
    print(f"    token_type={tok.get('token_type')} expires_in={tok.get('expires_in')}")
    print(f"    access_token (opaque, wrapped): {access_token[:24]}...")

    # 6) Call an MCP tool with the token
    auth = {"Authorization": f"Bearer {access_token}",
            "Accept": "application/json, text/event-stream"}

    step(6, "MCP initialize")
    status, hdrs, body = http_json(
        "POST", mcp_url, headers=auth,
        data={"jsonrpc": "2.0", "id": 1, "method": "initialize",
              "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                         "clientInfo": {"name": "oauth-client-demo", "version": "1.0"}}},
    )
    session_id = hdrs.get("mcp-session-id") or hdrs.get("Mcp-Session-Id")
    init = parse_sse_json(body)
    server_info = (init or {}).get("result", {}).get("serverInfo", {})
    print(f"    status={status} session={session_id} server={server_info}")
    sess_hdr = {"mcp-session-id": session_id} if session_id else {}

    # initialized notification
    http_json("POST", mcp_url, headers={**auth, **sess_hdr},
              data={"jsonrpc": "2.0", "method": "notifications/initialized"})

    step(6, f"tools/call -> {args.tool}")
    tool_args = json.loads(args.args)
    status, _, body = http_json(
        "POST", mcp_url, headers={**auth, **sess_hdr},
        data={"jsonrpc": "2.0", "id": 2, "method": "tools/call",
              "params": {"name": args.tool, "arguments": tool_args}},
    )
    result = parse_sse_json(body)
    print(f"    status={status}")
    content = (result or {}).get("result", {}).get("content")
    if content:
        for block in content:
            if block.get("type") == "text":
                text = block["text"]
                print("\n\033[1m=== Tool result (authorized as the logged-in user) ===\033[0m")
                print(text[:4000] + ("\n... (truncated)" if len(text) > 4000 else ""))
    else:
        print(json.dumps(result, indent=2)[:4000])

    print("\n\033[1m Done — full per-user OAuth + consent + tool call succeeded.\033[0m")


if __name__ == "__main__":
    main()
