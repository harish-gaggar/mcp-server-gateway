"""Tool registry: risk classification and execution policy per tool.

Every tool the agent can invoke is declared here with a risk class. The policy
engine (jfrog_agent/nodes.py) uses this to decide execution vs. human approval.
There is deliberately NO generic `run_shell` / `run_aql(raw)` tool.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class RiskClass(str, Enum):
    READ = "read"                    # automatic execution
    REVERSIBLE_WRITE = "reversible_write"   # approval based on scope
    SENSITIVE_WRITE = "sensitive_write"     # always approve
    DESTRUCTIVE = "destructive"      # two-step approval


@dataclass(frozen=True)
class ToolSpec:
    name: str
    risk: RiskClass
    description: str
    # The underlying MCP tool this maps to (None = composed/virtual tool).
    mcp_tool: str | None = None


# Phase 1 = read-only intelligence. These map onto the Artifactory MCP server
# tools that exist today. Higher-risk specs are declared so the policy engine
# and roadmap are explicit, even before the upstream MCP exposes them.
TOOLS: dict[str, ToolSpec] = {
    # ── Read (automatic) ─────────────────────────────────────────────────────
    "list_repositories": ToolSpec(
        "list_repositories", RiskClass.READ,
        "List Artifactory repositories, optionally filtered by type.",
        mcp_tool="list_repositories",
    ),
    "get_repository_info": ToolSpec(
        "get_repository_info", RiskClass.READ,
        "Get configuration/details for a single repository.",
        mcp_tool="get_repository_info",
    ),
    "search_artifacts": ToolSpec(
        "search_artifacts", RiskClass.READ,
        "Search artifacts via the validated AQL builder (read-only).",
        mcp_tool="search_artifacts",
    ),
    "get_artifact_info": ToolSpec(
        "get_artifact_info", RiskClass.READ,
        "Get metadata/properties for a specific artifact path.",
        mcp_tool="get_artifact_info",
    ),
    "get_folder_info": ToolSpec(
        "get_folder_info", RiskClass.READ,
        "List the contents/metadata of a repository folder.",
        mcp_tool="get_folder_info",
    ),
    "get_system_info": ToolSpec(
        "get_system_info", RiskClass.READ,
        "Get Artifactory system/version information.",
        mcp_tool="get_system_info",
    ),
    "get_storage_info": ToolSpec(
        "get_storage_info", RiskClass.READ,
        "Get storage summary (used space, repo sizes).",
        mcp_tool="get_storage_info",
    ),
    # ── Higher-risk (declared for roadmap + policy; require approval) ─────────
    "set_artifact_properties": ToolSpec(
        "set_artifact_properties", RiskClass.REVERSIBLE_WRITE,
        "Add/update properties on an artifact.", mcp_tool=None,
    ),
    "copy_artifact": ToolSpec(
        "copy_artifact", RiskClass.REVERSIBLE_WRITE,
        "Copy an artifact between staging repositories.", mcp_tool=None,
    ),
    "promote_build": ToolSpec(
        "promote_build", RiskClass.SENSITIVE_WRITE,
        "Promote a build to a target repository/status.", mcp_tool=None,
    ),
    "delete_artifacts": ToolSpec(
        "delete_artifacts", RiskClass.DESTRUCTIVE,
        "Delete artifacts (requires dry-run manifest + two-step approval).",
        mcp_tool=None,
    ),
}


def get_spec(name: str) -> ToolSpec | None:
    return TOOLS.get(name)


def read_only_tools() -> list[str]:
    return [name for name, spec in TOOLS.items() if spec.risk == RiskClass.READ]


# Which risk classes require a human approval interrupt before execution.
APPROVAL_REQUIRED = {
    RiskClass.SENSITIVE_WRITE,
    RiskClass.DESTRUCTIVE,
}


def requires_approval(risk: RiskClass, *, in_scope: bool) -> bool:
    if risk in APPROVAL_REQUIRED:
        return True
    if risk == RiskClass.REVERSIBLE_WRITE:
        # reversible writes are auto only when fully within the repo allowlist
        return not in_scope
    return False
