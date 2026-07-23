#!/usr/bin/env python3
"""
Google Drive + Google Docs MCP Server

A Model Context Protocol server that provides tools to interact with Google
Drive and Google Docs (list/search/read/create files and read/write documents).
"""

import json
import os
import time
from typing import Optional

import httpx
from starlette.requests import Request
from starlette.responses import JSONResponse
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

# Google REST API base URLs
DRIVE_API_BASE = "https://www.googleapis.com/drive/v3"
DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3"
DOCS_API_BASE = "https://docs.googleapis.com/v1"

# --- Open mode (shared credential) ---
# A Google OAuth access token carrying Drive/Docs scopes, sent as a Bearer
# credential. Easiest way to run locally: mint one for your account and export
# it here. Access tokens are short-lived (~1h), so for anything long-running
# prefer a service account (below) or secure mode.
GOOGLE_ACCESS_TOKEN = os.getenv("GOOGLE_ACCESS_TOKEN")

# Path to a Google service-account JSON key file. When set (and not in secure
# mode), the server mints its own OAuth access tokens for the configured scopes.
# Optionally impersonate a Workspace user via GOOGLE_IMPERSONATE_SUBJECT.
GOOGLE_SERVICE_ACCOUNT_FILE = os.getenv("GOOGLE_SERVICE_ACCOUNT_FILE")
GOOGLE_IMPERSONATE_SUBJECT = os.getenv("GOOGLE_IMPERSONATE_SUBJECT")
GOOGLE_SCOPES = os.getenv(
    "GOOGLE_SCOPES",
    "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/documents",
).split()

# --- Secure mode (per-user OAuth) ---
# When enabled, the server treats the incoming Authorization bearer as the
# user's Google OAuth access token (forwarded by the gateway) and calls the
# Google APIs directly as that user. This is the recommended mode: every call
# runs with the calling user's own Drive/Docs permissions.
SECURE_MODE = os.getenv("GDRIVE_SECURE_MODE", "").lower() in ("1", "true", "yes")

# Cache for service-account minted tokens: (token, expiry_epoch)
_sa_token_cache: tuple[Optional[str], float] = (None, 0.0)


# Validate / announce configuration
if SECURE_MODE:
    print("Secure mode: using each request's forwarded Google OAuth access token.")
elif GOOGLE_ACCESS_TOKEN:
    print("Open mode: using shared GOOGLE_ACCESS_TOKEN Bearer credential.")
elif GOOGLE_SERVICE_ACCOUNT_FILE:
    print(f"Open mode: minting tokens from service account {GOOGLE_SERVICE_ACCOUNT_FILE}")
    if GOOGLE_IMPERSONATE_SUBJECT:
        print(f"Impersonating Workspace user: {GOOGLE_IMPERSONATE_SUBJECT}")
else:
    print("Warning: no Google credentials configured.")
    print("Set GDRIVE_SECURE_MODE=true (gateway), GOOGLE_ACCESS_TOKEN, or")
    print("GOOGLE_SERVICE_ACCOUNT_FILE. API calls will return 401 until then.")

# Initialize FastMCP server
mcp = FastMCP("gdrive-mcp-server")


@mcp.custom_route("/health", methods=["GET"])
async def health(_request: Request) -> JSONResponse:
    return JSONResponse({"status": "ok", "server": "gdrive-mcp-server"})


def _incoming_bearer_token() -> Optional[str]:
    """Read the Authorization bearer from the current MCP HTTP request.

    In secure mode the gateway sets this to the authenticated user's Google
    OAuth access token. The server is only reachable behind the gateway, so it
    trusts this header as the user's credential.
    """
    try:
        ctx = mcp.get_context()
        request = ctx.request_context.request
    except Exception:
        request = None

    if request is None:
        return None

    auth = request.headers.get("authorization")
    if not auth:
        return None

    parts = auth.split(" ", 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return None


def _service_account_token() -> str:
    """Mint (and cache) an OAuth access token from the configured service
    account JSON key, for the configured scopes."""
    global _sa_token_cache
    token, expiry = _sa_token_cache
    if token and time.time() < expiry - 60:
        return token

    try:
        from google.oauth2 import service_account
        from google.auth.transport.requests import Request as GoogleAuthRequest
    except ImportError as exc:  # pragma: no cover - depends on optional dep
        raise RuntimeError(
            "GOOGLE_SERVICE_ACCOUNT_FILE is set but google-auth is not installed. "
            "Add google-auth to requirements.txt."
        ) from exc

    creds = service_account.Credentials.from_service_account_file(
        GOOGLE_SERVICE_ACCOUNT_FILE, scopes=GOOGLE_SCOPES
    )
    if GOOGLE_IMPERSONATE_SUBJECT:
        creds = creds.with_subject(GOOGLE_IMPERSONATE_SUBJECT)

    creds.refresh(GoogleAuthRequest())
    expiry_epoch = creds.expiry.timestamp() if creds.expiry else time.time() + 3600
    _sa_token_cache = (creds.token, expiry_epoch)
    return creds.token


def _access_token() -> str:
    """Resolve the OAuth access token to use for Google API calls.

    Secure mode: the user's token forwarded by the gateway.
    Open mode: a shared access token, or one minted from a service account.
    """
    if SECURE_MODE:
        token = _incoming_bearer_token()
        if not token:
            raise RuntimeError(
                "Secure mode: no Authorization bearer on the request. "
                "This server must be called through the OAuth-protected gateway."
            )
        return token
    if GOOGLE_ACCESS_TOKEN:
        return GOOGLE_ACCESS_TOKEN
    if GOOGLE_SERVICE_ACCOUNT_FILE:
        return _service_account_token()
    raise RuntimeError(
        "No Google credentials configured. Set GDRIVE_SECURE_MODE=true, "
        "GOOGLE_ACCESS_TOKEN, or GOOGLE_SERVICE_ACCOUNT_FILE."
    )


def get_client() -> httpx.Client:
    """Create an HTTP client authenticated for the Google APIs."""
    return httpx.Client(
        headers={
            "Authorization": f"Bearer {_access_token()}",
            "Content-Type": "application/json",
        },
        timeout=30.0,
    )


def _check(response: httpx.Response) -> httpx.Response:
    """Raise a descriptive error (including Google's response body) on failure.

    Google's API errors carry the real reason (insufficient scopes, API not
    enabled, permission denied, etc.) in the body, which a bare status code
    hides. Surfacing it makes misconfigurations diagnosable from the client.
    """
    if response.status_code >= 400:
        raise RuntimeError(
            f"Google API error: HTTP {response.status_code} "
            f"{response.request.method} {response.request.url} -> {response.text}"
        )
    return response


def _doc_end_index(document: dict) -> int:
    """Return the index just before the document body's final newline, i.e. the
    correct insertion point for appending text to the end of a doc."""
    content = document.get("body", {}).get("content", [])
    if not content:
        return 1
    end_index = content[-1].get("endIndex", 2)
    # The final structural element always ends with a newline; insert before it.
    return max(1, end_index - 1)


# --- Google Drive tools ---------------------------------------------------


@mcp.tool()
def list_files(query: Optional[str] = None, page_size: int = 20) -> str:
    """
    List or search files in Google Drive.

    Args:
        query: Optional Drive query string (Drive API `q` syntax), e.g.
            "name contains 'report'" or "mimeType='application/vnd.google-apps.document'".
        page_size: Maximum number of files to return (default 20, max 100).

    Returns:
        JSON string with the matching files (id, name, mimeType, modifiedTime, owners).
    """
    params = {
        "pageSize": max(1, min(page_size, 100)),
        "fields": "files(id,name,mimeType,modifiedTime,size,owners(displayName,emailAddress),webViewLink)",
    }
    if query:
        params["q"] = query
    with get_client() as client:
        response = client.get(f"{DRIVE_API_BASE}/files", params=params)
        _check(response)
        return response.text


@mcp.tool()
def get_file_metadata(file_id: str) -> str:
    """
    Get metadata for a specific Google Drive file.

    Args:
        file_id: The Drive file ID.

    Returns:
        JSON string with the file's metadata.
    """
    params = {
        "fields": "id,name,mimeType,modifiedTime,createdTime,size,owners(displayName,emailAddress),webViewLink,parents",
    }
    with get_client() as client:
        response = client.get(f"{DRIVE_API_BASE}/files/{file_id}", params=params)
        _check(response)
        return response.text


@mcp.tool()
def export_file(file_id: str, mime_type: str = "text/plain") -> str:
    """
    Export a Google Workspace file (Doc, Sheet, Slide) to a text-based format.

    Args:
        file_id: The Drive file ID of the Google Workspace document.
        mime_type: Export MIME type (default "text/plain"). Common values:
            "text/plain", "text/html", "text/markdown", "text/csv".

    Returns:
        The exported file contents as text.
    """
    with get_client() as client:
        response = client.get(
            f"{DRIVE_API_BASE}/files/{file_id}/export",
            params={"mimeType": mime_type},
        )
        _check(response)
        return response.text


@mcp.tool()
def create_file(name: str, content: str = "", mime_type: str = "text/plain", folder_id: Optional[str] = None) -> str:
    """
    Create a new plain file in Google Drive with the given text content.

    Note: to create a native Google Doc instead, use `create_document`.

    Args:
        name: Name for the new file.
        content: Text content of the file (default empty).
        mime_type: MIME type of the content (default "text/plain").
        folder_id: Optional parent folder ID.

    Returns:
        JSON string with the created file's metadata.
    """
    metadata: dict = {"name": name}
    if folder_id:
        metadata["parents"] = [folder_id]

    boundary = "gdrive-mcp-boundary"
    body = (
        f"--{boundary}\r\n"
        "Content-Type: application/json; charset=UTF-8\r\n\r\n"
        f"{json.dumps(metadata)}\r\n"
        f"--{boundary}\r\n"
        f"Content-Type: {mime_type}\r\n\r\n"
        f"{content}\r\n"
        f"--{boundary}--"
    )
    with get_client() as client:
        response = client.post(
            f"{DRIVE_UPLOAD_BASE}/files",
            params={"uploadType": "multipart", "fields": "id,name,mimeType,webViewLink"},
            headers={"Content-Type": f"multipart/related; boundary={boundary}"},
            content=body.encode("utf-8"),
        )
        _check(response)
        return response.text


# --- Google Docs tools ----------------------------------------------------


@mcp.tool()
def get_document(document_id: str) -> str:
    """
    Get the full structure of a Google Doc (including its text content).

    Args:
        document_id: The Google Doc ID (from the doc URL: /document/d/<ID>/edit).

    Returns:
        JSON string with the document structure.
    """
    with get_client() as client:
        response = client.get(f"{DOCS_API_BASE}/documents/{document_id}")
        _check(response)
        return response.text


@mcp.tool()
def create_document(title: str, body_text: str = "") -> str:
    """
    Create a new Google Doc.

    Args:
        title: Title for the new document.
        body_text: Optional initial text to insert into the document.

    Returns:
        JSON string with the created document (including documentId).
    """
    with get_client() as client:
        response = client.post(
            f"{DOCS_API_BASE}/documents",
            content=json.dumps({"title": title}).encode("utf-8"),
        )
        _check(response)
        created = response.json()

        if body_text:
            document_id = created["documentId"]
            requests = [{"insertText": {"location": {"index": 1}, "text": body_text}}]
            update = client.post(
                f"{DOCS_API_BASE}/documents/{document_id}:batchUpdate",
                content=json.dumps({"requests": requests}).encode("utf-8"),
            )
            _check(update)

        return json.dumps(created)


@mcp.tool()
def append_text(document_id: str, text: str) -> str:
    """
    Append text to the end of an existing Google Doc.

    Args:
        document_id: The Google Doc ID (from the doc URL: /document/d/<ID>/edit).
        text: The text to append.

    Returns:
        JSON string with the batchUpdate response.
    """
    with get_client() as client:
        doc = client.get(f"{DOCS_API_BASE}/documents/{document_id}")
        _check(doc)
        index = _doc_end_index(doc.json())

        requests = [{"insertText": {"location": {"index": index}, "text": text}}]
        response = client.post(
            f"{DOCS_API_BASE}/documents/{document_id}:batchUpdate",
            content=json.dumps({"requests": requests}).encode("utf-8"),
        )
        _check(response)
        return response.text


@mcp.tool()
def insert_text(document_id: str, text: str, index: int = 1) -> str:
    """
    Insert text at a specific index in a Google Doc.

    Args:
        document_id: The Google Doc ID.
        text: The text to insert.
        index: The 1-based character index at which to insert (default 1 = start of body).

    Returns:
        JSON string with the batchUpdate response.
    """
    with get_client() as client:
        requests = [{"insertText": {"location": {"index": max(1, index)}, "text": text}}]
        response = client.post(
            f"{DOCS_API_BASE}/documents/{document_id}:batchUpdate",
            content=json.dumps({"requests": requests}).encode("utf-8"),
        )
        _check(response)
        return response.text


@mcp.tool()
def replace_text(document_id: str, find: str, replace: str, match_case: bool = True) -> str:
    """
    Replace all occurrences of a string in a Google Doc.

    Args:
        document_id: The Google Doc ID.
        find: The text to search for.
        replace: The text to replace it with.
        match_case: Whether the search is case-sensitive (default True).

    Returns:
        JSON string with the batchUpdate response (includes number of replacements).
    """
    with get_client() as client:
        requests = [
            {
                "replaceAllText": {
                    "containsText": {"text": find, "matchCase": match_case},
                    "replaceText": replace,
                }
            }
        ]
        response = client.post(
            f"{DOCS_API_BASE}/documents/{document_id}:batchUpdate",
            content=json.dumps({"requests": requests}).encode("utf-8"),
        )
        _check(response)
        return response.text


if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8092"))

    print("Starting Google Drive + Docs MCP Server...")
    print(f"MCP endpoint available at: http://{host}:{port}/mcp")

    mcp.settings.host = host
    mcp.settings.port = port

    if os.getenv("MCP_DISABLE_DNS_REBINDING", "").lower() in ("1", "true", "yes"):
        mcp.settings.transport_security = TransportSecuritySettings(
            enable_dns_rebinding_protection=False
        )

    mcp.run(transport="streamable-http")
