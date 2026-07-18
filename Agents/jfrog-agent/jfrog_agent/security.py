"""Deterministic security controls.

Authorization is decided HERE, not by the LLM. The model proposes; this module
disposes. Also handles secrets redaction so tokens never reach logs, traces or
the audit trail.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .settings import Settings, settings as default_settings
from .tools.registry import RiskClass, ToolSpec, requires_approval


@dataclass
class AuthzDecision:
    allowed: bool
    needs_approval: bool
    reason: str


class Authorizer:
    """Deterministic policy service. Given the authenticated user, the target
    tool and its scope, decides allow / deny / needs-approval."""

    def __init__(self, settings: Settings = default_settings):
        self.s = settings

    def in_scope(self, repositories: list[str]) -> bool:
        if not self.s.repo_allowlist:
            return True
        return all(r in self.s.repo_allowlist for r in repositories)

    def decide(self, spec: ToolSpec, repositories: list[str]) -> AuthzDecision:
        # Read-only mode is a hard gate on anything that mutates state.
        if self.s.read_only and spec.risk != RiskClass.READ:
            return AuthzDecision(
                allowed=False,
                needs_approval=False,
                reason=(
                    f"'{spec.name}' is a {spec.risk.value} operation but the agent "
                    "is running in read-only mode (JFROG_AGENT_READ_ONLY=true)."
                ),
            )

        # Tools that aren't backed by a live MCP tool cannot execute yet.
        if spec.risk == RiskClass.READ and spec.mcp_tool is None:
            return AuthzDecision(False, False, f"'{spec.name}' is not yet available upstream.")

        scoped = self.in_scope(repositories)
        if not scoped and repositories:
            return AuthzDecision(
                allowed=False,
                needs_approval=False,
                reason=f"repositories outside allowlist: {repositories}",
            )

        needs_approval = requires_approval(spec.risk, in_scope=scoped)
        return AuthzDecision(True, needs_approval, "authorized by policy")


# ── Redaction ────────────────────────────────────────────────────────────────

_SECRET_PATTERNS = [
    re.compile(r"(Bearer\s+)[A-Za-z0-9._~+/\-]{12,}=*", re.IGNORECASE),
    re.compile(r"(eyJ[A-Za-z0-9._\-]{20,})"),  # JWT-ish
    re.compile(r"([A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{8,})"),
    re.compile(r'("?(?:access_token|refresh_token|client_secret|password|api_key)"?\s*[:=]\s*)"?[^",\s]+"?', re.IGNORECASE),
]


def redact(text: str) -> str:
    """Remove tokens / credentials from any string before it is logged, traced
    or written to the audit trail."""
    if not text:
        return text
    out = text
    out = _SECRET_PATTERNS[0].sub(r"\1[REDACTED]", out)
    out = _SECRET_PATTERNS[1].sub("[REDACTED_JWT]", out)
    out = _SECRET_PATTERNS[3].sub(r"\1[REDACTED]", out)
    return out


def redact_obj(obj):
    """Recursively redact secrets in dict/list/str structures."""
    if isinstance(obj, str):
        return redact(obj)
    if isinstance(obj, dict):
        return {k: ("[REDACTED]" if k.lower() in _SENSITIVE_KEYS else redact_obj(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [redact_obj(v) for v in obj]
    return obj


_SENSITIVE_KEYS = {
    "access_token",
    "refresh_token",
    "client_secret",
    "authorization",
    "password",
    "api_key",
    "token",
}
