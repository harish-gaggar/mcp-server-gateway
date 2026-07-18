"""Typed Artifactory tools.

Each function is a small, typed wrapper over a single MCP tool call. They return
structured dicts (never dump huge raw payloads into the LLM context). The raw
MCP text is preserved under `_raw` for the evidence validator/audit trail, but
callers summarize before sending anything to the model.
"""

from __future__ import annotations

from typing import Any

from ..mcp_client import GatewayMCPClient
from ..settings import Settings, settings as default_settings
from .aql import SearchIntent, build_items_aql, describe_intent


def _unwrap(result: dict[str, Any]) -> Any:
    """Prefer parsed JSON; fall back to text."""
    if result.get("data") is not None:
        return result["data"]
    return result.get("text")


def list_repositories(client: GatewayMCPClient, repo_type: str | None = None) -> dict[str, Any]:
    args = {"type": repo_type} if repo_type else {}
    res = client.call_tool("list_repositories", args)
    return {"tool": "list_repositories", "is_error": res["is_error"], "result": _unwrap(res), "_raw": res.get("text")}


def get_repository_info(client: GatewayMCPClient, repository: str) -> dict[str, Any]:
    res = client.call_tool("get_repository_info", {"repository": repository})
    return {"tool": "get_repository_info", "is_error": res["is_error"], "result": _unwrap(res), "_raw": res.get("text")}


def get_artifact_info(client: GatewayMCPClient, repo: str, path: str) -> dict[str, Any]:
    res = client.call_tool("get_artifact_info", {"repo": repo, "path": path})
    return {"tool": "get_artifact_info", "is_error": res["is_error"], "result": _unwrap(res), "_raw": res.get("text")}


def get_folder_info(client: GatewayMCPClient, repo: str, path: str = "") -> dict[str, Any]:
    res = client.call_tool("get_folder_info", {"repo": repo, "path": path})
    return {"tool": "get_folder_info", "is_error": res["is_error"], "result": _unwrap(res), "_raw": res.get("text")}


def get_system_info(client: GatewayMCPClient) -> dict[str, Any]:
    res = client.call_tool("get_system_info", {})
    return {"tool": "get_system_info", "is_error": res["is_error"], "result": _unwrap(res), "_raw": res.get("text")}


def get_storage_info(client: GatewayMCPClient) -> dict[str, Any]:
    res = client.call_tool("get_storage_info", {})
    return {"tool": "get_storage_info", "is_error": res["is_error"], "result": _unwrap(res), "_raw": res.get("text")}


def search_artifacts(
    client: GatewayMCPClient,
    intent: SearchIntent,
    settings: Settings = default_settings,
) -> dict[str, Any]:
    """Run a validated, bounded, read-only artifact search.

    The Artifactory MCP `search_artifacts` tool accepts `name`/`repo`. We use the
    validated AQL builder to *derive* those safe arguments from the structured
    intent (and to enforce scope/caps), so the model never controls raw AQL.
    """
    # Build (and validate) the AQL — this raises if the intent violates scope,
    # even though we then translate to the MCP tool's simpler arguments.
    aql = build_items_aql(
        intent,
        allowed_repos=settings.repo_allowlist,
        max_results=settings.aql_max_results,
    )

    repo = intent.repositories[0] if intent.repositories else None
    args: dict[str, Any] = {}
    if intent.name_pattern:
        args["name"] = intent.name_pattern
    if repo:
        args["repo"] = repo

    res = client.call_tool("search_artifacts", args)
    return {
        "tool": "search_artifacts",
        "is_error": res["is_error"],
        "intent": describe_intent(intent),
        "aql": aql,
        "result": _unwrap(res),
        "_raw": res.get("text"),
    }
