"""GatewayMCPClient — connects to an MCP server *through* the MCP gateway using
per-user OAuth.

The gateway owns the OAuth dance (DCR -> PKCE authorize -> consent -> upstream
IdP -> token). This client implements the RFC 9728 / 8414 discovery + auth-code
+ PKCE flow that the gateway expects, then keeps an MCP session (initialize ->
notifications/initialized -> tools/*) alive for the run.

Key behaviours the JFrog agent relies on:
  * **One-time authentication.** The browser authorization runs once; the
    resulting gateway token is cached on disk and reused on subsequent runs
    (with silent refresh-token renewal when possible).
  * **Per-user identity.** The gateway maps the token to a single human and
    forwards their id_token upstream for the JFrog OIDC exchange, so only that
    authorized user's queries reach JFrog.
  * **Client-type telemetry.** Every request carries `x-mcp-client-type` so the
    gateway can tell the agent's traffic apart from a coding assistant.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import time
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import httpx

from .settings import Settings, settings as default_settings


class MCPError(RuntimeError):
    """Raised when an MCP JSON-RPC call returns an error."""


class AuthError(RuntimeError):
    """Raised when OAuth authentication cannot be completed."""


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


class _ReusableHTTPServer(HTTPServer):
    # Allow immediate rebind after a previous auth attempt (avoids Errno 48).
    allow_reuse_address = True
    allow_reuse_port = True


class _CallbackHandler(BaseHTTPRequestHandler):
    code: str | None = None
    state: str | None = None

    def do_GET(self):  # noqa: N802 (http.server API)
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        _CallbackHandler.code = (params.get("code") or [None])[0]
        _CallbackHandler.state = (params.get("state") or [None])[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(
            b"<html><body style='font-family:sans-serif'>"
            b"<h2>Authentication complete</h2>"
            b"<p>You can close this tab and return to the JFrog agent.</p>"
            b"</body></html>"
        )

    def log_message(self, *_args):  # silence the default logging
        return


class GatewayMCPClient:
    def __init__(self, settings: Settings = default_settings, *, verbose: bool = True):
        self.s = settings
        self.verbose = verbose
        self._http = httpx.Client(timeout=60.0, follow_redirects=False)
        self._token: dict[str, Any] | None = None
        self._session_id: str | None = None
        self._initialized = False
        self._req_id = 0

    # ── logging ──────────────────────────────────────────────────────────────
    def _log(self, msg: str) -> None:
        if self.verbose:
            print(f"[mcp] {msg}")

    # ── token cache ────────────────────────────────────────────────────────
    def _load_cache(self) -> dict[str, Any] | None:
        path = self.s.token_cache
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text())
        except Exception:
            return None

    def _save_cache(self, data: dict[str, Any]) -> None:
        path = self.s.token_cache
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=2))
        os.chmod(path, 0o600)

    def _cache_valid(self, cache: dict[str, Any]) -> bool:
        if not cache.get("access_token"):
            return False
        # keep a 60s safety margin
        return cache.get("expires_at", 0) - 60 > time.time()

    # ── OAuth discovery ──────────────────────────────────────────────────────
    def _rewrite_origin(self, url: str, base: str) -> str:
        """Swap the scheme+host of a discovery-provided URL for `base`, so a
        containerized client can reach the gateway even though the gateway's
        metadata advertises a different (browser-facing) origin."""
        target = urllib.parse.urlsplit(base)
        parts = urllib.parse.urlsplit(url)
        return urllib.parse.urlunsplit(
            (target.scheme, target.netloc, parts.path, parts.query, parts.fragment)
        )

    def _discover(self) -> dict[str, str]:
        gw = self.s.gateway_url.rstrip("/")
        ns = self.s.namespace
        as_url = f"{gw}/.well-known/oauth-authorization-server/{ns}"
        resp = self._http.get(as_url)
        if resp.status_code != 200:
            raise AuthError(f"authorization-server metadata failed: {resp.status_code} {as_url}")
        meta = resp.json()
        # server-side calls (register/token) always go to the internal gateway_url;
        # the authorize link is rewritten to the public url for the browser.
        return {
            "registration_endpoint": self._rewrite_origin(meta["registration_endpoint"], self.s.gateway_url),
            "authorization_endpoint": self._rewrite_origin(meta["authorization_endpoint"], self.s.gateway_public_url),
            "token_endpoint": self._rewrite_origin(meta["token_endpoint"], self.s.gateway_url),
        }

    def _register_client(self, endpoints: dict[str, str], redirect_uri: str) -> dict[str, str]:
        resp = self._http.post(
            endpoints["registration_endpoint"],
            json={
                "client_name": self.s.client_name,
                "redirect_uris": [redirect_uri],
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "client_secret_post",
            },
        )
        if resp.status_code not in (200, 201):
            raise AuthError(f"dynamic client registration failed: {resp.status_code} {resp.text}")
        body = resp.json()
        return {"client_id": body["client_id"], "client_secret": body.get("client_secret", "")}

    def _browser_authorize(
        self,
        endpoints: dict[str, str],
        client_id: str,
        redirect_uri: str,
        *,
        open_browser: bool = True,
        url_callback=None,
    ):
        verifier = _b64url(secrets.token_bytes(32))
        challenge = _b64url(hashlib.sha256(verifier.encode()).digest())
        state = secrets.token_urlsafe(16)

        authorize_url = endpoints["authorization_endpoint"] + "?" + urllib.parse.urlencode(
            {
                "response_type": "code",
                "client_id": client_id,
                "redirect_uri": redirect_uri,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "state": state,
                "scope": self.s.oauth_scope,
            }
        )

        _CallbackHandler.code = None
        _CallbackHandler.state = None
        try:
            server = _ReusableHTTPServer(
                (self.s.callback_bind_host, self.s.callback_port), _CallbackHandler
            )
        except OSError as e:
            raise AuthError(
                f"could not bind OAuth callback port {self.s.callback_port} "
                f"({e}). Another authorization may be in progress — wait a few "
                "seconds and retry, or free the port."
            ) from e
        # Single-threaded, interruptible wait so the socket is always released.
        server.timeout = 1

        # Surface the URL to a UI (e.g. Streamlit) before we block waiting.
        if url_callback is not None:
            try:
                url_callback(authorize_url)
            except Exception:
                pass

        self._log("Opening browser for one-time authorization…")
        self._log(f"If it does not open, visit:\n{authorize_url}")
        if open_browser:
            try:
                webbrowser.open(authorize_url)
            except Exception:
                pass

        try:
            deadline = time.time() + 300
            while _CallbackHandler.code is None and time.time() < deadline:
                server.handle_request()  # returns after `timeout` if no request
        finally:
            server.server_close()

        if _CallbackHandler.code is None:
            raise AuthError("timed out waiting for OAuth redirect")
        if _CallbackHandler.state != state:
            raise AuthError("OAuth state mismatch (possible CSRF)")
        return _CallbackHandler.code, verifier

    def _exchange_code(
        self,
        endpoints: dict[str, str],
        client: dict[str, str],
        code: str,
        verifier: str,
        redirect_uri: str,
    ) -> dict[str, Any]:
        form = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": client["client_id"],
            "client_secret": client["client_secret"],
            "code_verifier": verifier,
        }
        resp = self._http.post(
            endpoints["token_endpoint"],
            data=form,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        if resp.status_code != 200:
            raise AuthError(f"token exchange failed: {resp.status_code} {resp.text}")
        return resp.json()

    def _refresh(self, endpoints: dict[str, str], cache: dict[str, Any]) -> dict[str, Any] | None:
        if not cache.get("refresh_token"):
            return None
        form = {
            "grant_type": "refresh_token",
            "refresh_token": cache["refresh_token"],
            "client_id": cache["client_id"],
            "client_secret": cache.get("client_secret", ""),
        }
        resp = self._http.post(
            endpoints["token_endpoint"],
            data=form,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        if resp.status_code != 200:
            return None
        return resp.json()

    def _store_token(self, tok: dict[str, Any], client: dict[str, str]) -> None:
        expires_in = int(tok.get("expires_in", 3600))
        cache = {
            "access_token": tok["access_token"],
            "refresh_token": tok.get("refresh_token"),
            "expires_at": time.time() + expires_in,
            "client_id": client["client_id"],
            "client_secret": client.get("client_secret", ""),
        }
        self._token = cache
        self._save_cache(cache)

    def has_valid_token(self) -> bool:
        """True if a cached, unexpired token is available (no browser needed)."""
        cache = self._load_cache()
        if cache and self._cache_valid(cache):
            self._token = cache
            return True
        return False

    def authenticate(self, force: bool = False, *, open_browser: bool = True, url_callback=None) -> str:
        """Ensure we hold a valid gateway access token, running the browser flow
        at most once. Returns the access token.

        `open_browser`/`url_callback` let a UI (Streamlit) show the authorize link
        instead of launching a desktop browser."""
        cache = self._load_cache()
        if not force and cache and self._cache_valid(cache):
            self._token = cache
            self._log("Reusing cached gateway token (no browser needed).")
            return cache["access_token"]

        endpoints = self._discover()

        # Try a silent refresh before falling back to the browser.
        if not force and cache and cache.get("refresh_token"):
            refreshed = self._refresh(endpoints, cache)
            if refreshed and refreshed.get("access_token"):
                self._log("Refreshed gateway token silently.")
                self._store_token(refreshed, cache)
                return self._token["access_token"]

        redirect_uri = f"http://127.0.0.1:{self.s.callback_port}/callback"
        client = self._register_client(endpoints, redirect_uri)
        code, verifier = self._browser_authorize(
            endpoints, client["client_id"], redirect_uri,
            open_browser=open_browser, url_callback=url_callback,
        )
        tok = self._exchange_code(endpoints, client, code, verifier, redirect_uri)
        self._store_token(tok, client)
        self._log("Authenticated. Token cached for future runs.")
        return self._token["access_token"]

    # ── MCP JSON-RPC ────────────────────────────────────────────────────────
    def _headers(self, *, with_session: bool = True) -> dict[str, str]:
        if not self._token:
            raise AuthError("not authenticated; call authenticate() first")
        headers = {
            "Authorization": f"Bearer {self._token['access_token']}",
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
            **self.s.client_headers(client_instance_id=self._session_id),
        }
        if with_session and self._session_id:
            headers["mcp-session-id"] = self._session_id
        return headers

    def _next_id(self) -> int:
        self._req_id += 1
        return self._req_id

    @staticmethod
    def _parse_response(resp: httpx.Response, want_id: int | None) -> dict[str, Any] | None:
        content_type = resp.headers.get("content-type", "").split(";")[0].strip().lower()
        if content_type == "text/event-stream":
            for line in resp.text.splitlines():
                if not line.startswith("data:"):
                    continue
                payload = line[len("data:"):].strip()
                if not payload:
                    continue
                try:
                    obj = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                if want_id is None or obj.get("id") == want_id:
                    return obj
            return None
        if not resp.content:
            return None
        try:
            return resp.json()
        except json.JSONDecodeError:
            return None

    def _rpc(self, method: str, params: dict[str, Any] | None, *, notify: bool = False) -> Any:
        body: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        req_id = None
        if not notify:
            req_id = self._next_id()
            body["id"] = req_id
        if params is not None:
            body["params"] = params

        resp = self._http.post(self.s.mcp_url, headers=self._headers(), json=body)

        # capture a freshly minted session id (from initialize)
        session = resp.headers.get("mcp-session-id")
        if session:
            self._session_id = session

        if notify:
            return None

        if resp.status_code == 401:
            raise AuthError("gateway returned 401 (token expired or unauthorized user)")
        if resp.status_code >= 400:
            raise MCPError(f"{method} -> HTTP {resp.status_code}: {resp.text[:500]}")

        obj = self._parse_response(resp, req_id)
        if obj is None:
            raise MCPError(f"{method}: no JSON-RPC response returned")
        if "error" in obj:
            raise MCPError(f"{method}: {obj['error'].get('message', obj['error'])}")
        return obj.get("result")

    def connect(self) -> None:
        """Authenticate (once) and open an MCP session."""
        # A stale cached token surfaces as a 401; retry once with a fresh login.
        try:
            self.authenticate()
            self._open_session()
        except AuthError:
            self._log("Cached token rejected; re-authenticating…")
            self.authenticate(force=True)
            self._open_session()

    def _open_session(self) -> None:
        self._session_id = None
        self._rpc(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": self.s.client_name, "version": "0.1.0"},
            },
        )
        # A notification (no id); required before tools/* on stateful servers.
        self._rpc("notifications/initialized", None, notify=True)
        self._initialized = True
        self._log(f"MCP session established (session-id={self._session_id}).")

    def list_tools(self) -> list[dict[str, Any]]:
        result = self._rpc("tools/list", {})
        return result.get("tools", []) if isinstance(result, dict) else []

    def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        if not self._initialized:
            self.connect()
        result = self._rpc("tools/call", {"name": name, "arguments": arguments or {}})
        return self._normalize_tool_result(result)

    @staticmethod
    def _normalize_tool_result(result: Any) -> dict[str, Any]:
        """MCP tools return {content:[{type:'text',text:...}], isError:bool}. We
        surface the parsed JSON payload when possible plus the raw text."""
        if not isinstance(result, dict):
            return {"raw": result, "is_error": False}
        is_error = bool(result.get("isError"))
        texts: list[str] = []
        for block in result.get("content", []) or []:
            if isinstance(block, dict) and block.get("type") == "text":
                texts.append(block.get("text", ""))
        joined = "\n".join(texts)
        data: Any = None
        if joined:
            try:
                data = json.loads(joined)
            except json.JSONDecodeError:
                data = None
        return {"data": data, "text": joined, "is_error": is_error}

    def close(self) -> None:
        try:
            self._http.close()
        except Exception:
            pass

    def __enter__(self) -> "GatewayMCPClient":
        self.connect()
        return self

    def __exit__(self, *_exc) -> None:
        self.close()
