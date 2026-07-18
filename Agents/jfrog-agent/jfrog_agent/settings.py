"""Environment-driven configuration for the JFrog agent."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv()
except Exception:  # pragma: no cover - dotenv is optional
    pass


def _expand(path: str) -> Path:
    return Path(os.path.expanduser(path)).resolve()


def _csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    # Gateway / MCP
    # gateway_url is used for all server-side calls (discovery, DCR, token, MCP).
    # gateway_public_url is only used to build the browser authorization link, so
    # containers can reach the gateway at host.docker.internal while the user's
    # browser still opens localhost. Defaults to gateway_url when unset.
    gateway_url: str = os.getenv("JFROG_AGENT_GATEWAY_URL", "http://localhost:8090")
    gateway_public_url: str = (
        os.getenv("JFROG_AGENT_GATEWAY_PUBLIC_URL")
        or os.getenv("JFROG_AGENT_GATEWAY_URL", "http://localhost:8090")
    )
    namespace: str = os.getenv("JFROG_AGENT_MCP_NAMESPACE", "artifactory")

    # OAuth
    callback_port: int = int(os.getenv("JFROG_AGENT_OAUTH_CALLBACK_PORT", "8777"))
    # Bind host for the local OAuth callback server. Use 0.0.0.0 in a container
    # so the mapped port is reachable; 127.0.0.1 is fine for local runs.
    callback_bind_host: str = os.getenv("JFROG_AGENT_OAUTH_BIND_HOST", "127.0.0.1")
    token_cache: Path = field(
        default_factory=lambda: _expand(
            os.getenv("JFROG_AGENT_TOKEN_CACHE", "~/.jfrog-agent/token.json")
        )
    )
    oauth_scope: str = os.getenv("JFROG_AGENT_OAUTH_SCOPE", "openid email")

    # Client identity (telemetry)
    client_type: str = os.getenv("JFROG_AGENT_CLIENT_TYPE", "agent")
    client_name: str = os.getenv("JFROG_AGENT_CLIENT_NAME", "jfrog-langgraph-agent")

    # LLM
    llm_provider: str = os.getenv("JFROG_AGENT_LLM_PROVIDER", "openai").lower()
    llm_model: str = os.getenv("JFROG_AGENT_LLM_MODEL", "gpt-4o-mini")

    # Safety / scope
    repo_allowlist: list[str] = field(
        default_factory=lambda: _csv(os.getenv("JFROG_AGENT_REPO_ALLOWLIST", ""))
    )
    aql_max_results: int = int(os.getenv("JFROG_AGENT_AQL_MAX_RESULTS", "200"))
    read_only: bool = os.getenv("JFROG_AGENT_READ_ONLY", "true").lower() in {
        "1",
        "true",
        "yes",
    }
    audit_dir: Path = field(
        default_factory=lambda: _expand(
            os.getenv("JFROG_AGENT_AUDIT_DIR", "~/.jfrog-agent/audit")
        )
    )

    # Observability
    otel_endpoint: str | None = os.getenv("JFROG_AGENT_OTEL_ENDPOINT") or None

    # ── Agent memory (durable threads + LangGraph checkpoints) ───────────────
    # backend: "sqlite" (default, local file) or "spanner" (Cloud Spanner /
    # emulator). SQLite needs no services; Spanner gives a shared, queryable
    # store and works against the local emulator.
    memory_backend: str = os.getenv("JFROG_AGENT_MEMORY_BACKEND", "sqlite").lower()
    memory_db: Path = field(
        default_factory=lambda: _expand(
            os.getenv("JFROG_AGENT_MEMORY_DB", "~/.jfrog-agent/memory.db")
        )
    )
    checkpoints_db: Path = field(
        default_factory=lambda: _expand(
            os.getenv("JFROG_AGENT_CHECKPOINTS_DB", "~/.jfrog-agent/checkpoints.db")
        )
    )
    # Spanner (emulator by default). Set SPANNER_EMULATOR_HOST to use the emulator.
    spanner_emulator_host: str | None = os.getenv("SPANNER_EMULATOR_HOST") or None
    spanner_project: str = os.getenv("JFROG_AGENT_SPANNER_PROJECT", "jfrog-agent-local")
    spanner_instance: str = os.getenv("JFROG_AGENT_SPANNER_INSTANCE", "jfrog-agent")
    spanner_database: str = os.getenv("JFROG_AGENT_SPANNER_DATABASE", "agent-memory")

    @property
    def mcp_url(self) -> str:
        return f"{self.gateway_url.rstrip('/')}/{self.namespace}/mcp"

    def client_headers(self, client_instance_id: str | None = None) -> dict[str, str]:
        """Headers that let the gateway attribute this traffic to the agent."""
        headers = {"x-mcp-client-type": self.client_type}
        if client_instance_id:
            headers["x-mcp-client-id"] = client_instance_id
        return headers


settings = Settings()
