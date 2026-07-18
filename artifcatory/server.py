#!/usr/bin/env python3
"""
JFrog Artifactory MCP Server

A Model Context Protocol server that provides tools to interact with JFrog Artifactory.
"""

import os
import httpx
from typing import Optional
from starlette.requests import Request
from starlette.responses import JSONResponse
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

# Environment variables
ARTIFACTORY_BASE_URL = os.getenv("ARTIFACTORY_BASE_URL", "http://localhost:8081/artifactory")

# --- Open mode (shared token) ---
# A JFrog access/identity token used as a Bearer credential. Works with both a
# company-issued access token and a free-tier identity token generated from the
# JFrog Platform UI (Profile -> Generate Identity Token).
ARTIFACTORY_ACCESS_TOKEN = os.getenv("ARTIFACTORY_ACCESS_TOKEN")

# Legacy fallback: the deprecated Artifactory API key (X-JFrog-Art-Api header).
# Kept only for older self-hosted instances; new instances cannot create API keys.
ARTIFACTORY_API_KEY = os.getenv("ARTIFACTORY_API_KEY")

# --- Secure mode (per-user OAuth) ---
# When set, the server treats the incoming Authorization bearer as the user's
# OIDC id_token (forwarded by the gateway) and exchanges it for a short-lived,
# user-scoped JFrog access token via the JFrog OIDC token-exchange endpoint.
# The value is the name of the OIDC integration configured in the JFrog Platform.
ARTIFACTORY_OIDC_PROVIDER_NAME = os.getenv("ARTIFACTORY_OIDC_PROVIDER_NAME")

SECURE_MODE = bool(ARTIFACTORY_OIDC_PROVIDER_NAME)


def _platform_base_url() -> str:
    """Derive the JFrog Platform base URL (which hosts /access) from the
    Artifactory base URL, e.g. https://host/artifactory -> https://host."""
    base = ARTIFACTORY_BASE_URL.rstrip("/")
    if base.endswith("/artifactory"):
        base = base[: -len("/artifactory")]
    return base


ARTIFACTORY_OIDC_TOKEN_URL = f"{_platform_base_url()}/access/api/v1/oidc/token"

# Validate environment variables
if not os.getenv("ARTIFACTORY_BASE_URL"):
    print("Warning: ARTIFACTORY_BASE_URL not set. Using default localhost instance.")
if SECURE_MODE:
    print(f"Secure mode: exchanging user OIDC id_tokens via {ARTIFACTORY_OIDC_TOKEN_URL}")
    print(f"JFrog OIDC provider name: {ARTIFACTORY_OIDC_PROVIDER_NAME}")
elif not ARTIFACTORY_ACCESS_TOKEN and not ARTIFACTORY_API_KEY:
    print("Warning: no ARTIFACTORY_ACCESS_TOKEN (or legacy ARTIFACTORY_API_KEY) set.")
    print("API calls will return 401/403 until a real token is configured.")

# Initialize FastMCP server
mcp = FastMCP("artifactory-mcp-server")


@mcp.custom_route("/health", methods=["GET"])
async def health(_request: Request) -> JSONResponse:
    return JSONResponse({"status": "ok", "server": "artifactory-mcp-server"})

def _incoming_bearer_token() -> Optional[str]:
    """Read the Authorization bearer from the current MCP HTTP request.

    In secure mode the gateway sets this to the authenticated user's OIDC
    id_token (via forward_id_token). The server is only reachable behind the
    gateway, so it trusts this header as the user's identity assertion.
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


def _exchange_oidc_token(id_token: str) -> str:
    """Exchange a user's OIDC id_token for a short-lived, user-scoped JFrog
    access token using the JFrog OIDC token-exchange endpoint. JFrog validates
    the id_token against the configured OIDC integration + identity mapping and
    returns a token carrying that user's permissions."""
    payload = {
        "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
        "subject_token_type": "urn:ietf:params:oauth:token-type:id_token",
        "subject_token": id_token,
        "provider_name": ARTIFACTORY_OIDC_PROVIDER_NAME,
    }
    with httpx.Client(timeout=30.0) as client:
        resp = client.post(ARTIFACTORY_OIDC_TOKEN_URL, json=payload)
        if resp.status_code >= 400:
            # Surface JFrog's reason (audience/issuer mismatch, no identity
            # mapping matched, etc.) instead of a bare 400.
            raise RuntimeError(
                f"JFrog OIDC exchange failed: HTTP {resp.status_code} "
                f"provider={ARTIFACTORY_OIDC_PROVIDER_NAME} body={resp.text}"
            )
        data = resp.json()

    access_token = data.get("access_token")
    if not access_token:
        raise RuntimeError(
            f"JFrog OIDC exchange returned no access_token: {data}"
        )
    return access_token


# HTTP client for Artifactory API
def get_artifactory_client() -> httpx.Client:
    """Create an HTTP client configured for the Artifactory API.

    Secure mode: exchanges the incoming user's OIDC id_token for a per-user
    JFrog access token so every call runs with that user's own permissions.

    Open mode: uses a shared Bearer access/identity token (or the legacy
    X-JFrog-Art-Api key header) from the environment.
    """
    headers = {"Content-Type": "application/json"}

    if SECURE_MODE:
        id_token = _incoming_bearer_token()
        if not id_token:
            raise RuntimeError(
                "Secure mode: no Authorization bearer on the request. "
                "This server must be called through the OAuth-protected gateway."
            )
        user_token = _exchange_oidc_token(id_token)
        headers["Authorization"] = f"Bearer {user_token}"
    elif ARTIFACTORY_ACCESS_TOKEN:
        headers["Authorization"] = f"Bearer {ARTIFACTORY_ACCESS_TOKEN}"
    elif ARTIFACTORY_API_KEY:
        headers["X-JFrog-Art-Api"] = ARTIFACTORY_API_KEY

    return httpx.Client(
        base_url=ARTIFACTORY_BASE_URL,
        headers=headers,
        timeout=30.0
    )


@mcp.tool()
def list_repositories(type: Optional[str] = None) -> str:
    """
    List all repositories in Artifactory.
    
    Args:
        type: Optional repository type filter (LOCAL, REMOTE, VIRTUAL, FEDERATED, DISTRIBUTION)
    
    Returns:
        JSON string with list of repositories
    """
    with get_artifactory_client() as client:
        endpoint = "/api/repositories"
        if type:
            endpoint += f"?type={type}"
        
        response = client.get(endpoint)
        response.raise_for_status()
        return response.text


@mcp.tool()
def get_repository_info(repository: str) -> str:
    """
    Get detailed information about a specific repository.
    
    Args:
        repository: The repository key/name
    
    Returns:
        JSON string with repository details
    """
    with get_artifactory_client() as client:
        response = client.get(f"/api/repositories/{repository}")
        response.raise_for_status()
        return response.text


@mcp.tool()
def search_artifacts(name: Optional[str] = None, repo: Optional[str] = None) -> str:
    """
    Search for artifacts in Artifactory using AQL (Artifactory Query Language).
    
    Args:
        name: Artifact name pattern to search for
        repo: Repository to search in
    
    Returns:
        JSON string with search results
    """
    # Build AQL query
    aql_query = 'items.find({'
    conditions = []
    
    if name:
        conditions.append(f'"name": {{"$match": "{name}"}}')
    if repo:
        conditions.append(f'"repo": "{repo}"')
    
    if conditions:
        aql_query += ', '.join(conditions)
    
    aql_query += '})'
    
    with get_artifactory_client() as client:
        response = client.post(
            "/api/search/aql",
            content=aql_query,
            headers={"Content-Type": "text/plain"}
        )
        response.raise_for_status()
        return response.text


@mcp.tool()
def get_artifact_info(repo: str, path: str) -> str:
    """
    Get information about a specific artifact.
    
    Args:
        repo: Repository name
        path: Path to the artifact within the repository
    
    Returns:
        JSON string with artifact information
    """
    with get_artifactory_client() as client:
        response = client.get(f"/api/storage/{repo}/{path}")
        response.raise_for_status()
        return response.text


@mcp.tool()
def get_folder_info(repo: str, path: str = "") -> str:
    """
    Get information about a folder in Artifactory.
    
    Args:
        repo: Repository name
        path: Path to the folder within the repository (empty for root)
    
    Returns:
        JSON string with folder information and children
    """
    folder_path = f"{repo}/{path}" if path else repo
    
    with get_artifactory_client() as client:
        response = client.get(f"/api/storage/{folder_path}")
        response.raise_for_status()
        return response.text


@mcp.tool()
def get_system_info() -> str:
    """
    Get Artifactory system information.
    
    Returns:
        JSON string with system information
    """
    with get_artifactory_client() as client:
        response = client.get("/api/system/version")
        response.raise_for_status()
        return response.text


@mcp.tool()
def get_storage_info() -> str:
    """
    Get Artifactory storage summary information.
    
    Returns:
        JSON string with storage information
    """
    with get_artifactory_client() as client:
        response = client.get("/api/storageinfo")
        response.raise_for_status()
        return response.text


if __name__ == "__main__":
    # Run the server
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8091"))
    
    print(f"Starting Artifactory MCP Server...")
    print(f"Artifactory URL: {ARTIFACTORY_BASE_URL}")
    print(f"MCP endpoint available at: http://{host}:{port}/mcp")
    
    # Configure server settings
    mcp.settings.host = host
    mcp.settings.port = port

    if os.getenv("MCP_DISABLE_DNS_REBINDING", "").lower() in ("1", "true", "yes"):
        mcp.settings.transport_security = TransportSecuritySettings(
            enable_dns_rebinding_protection=False
        )

    # Run with streamable-http transport
    mcp.run(transport="streamable-http")

