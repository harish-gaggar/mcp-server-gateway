"""LangGraph shared state."""

from __future__ import annotations

from typing import Any, Optional, TypedDict

from .llm import Plan


class AgentState(TypedDict, total=False):
    # inputs
    request: str
    user: Optional[str]
    run_id: str

    # planning
    plan: Plan
    planner_kind: str          # "llm" | "heuristic"
    request_type: str          # read | write | risk | unknown

    # authorization
    authz_notes: list[dict[str, Any]]
    approval_required: bool
    approval_payload: Optional[dict[str, Any]]
    approval_decision: Optional[str]   # approve | reject | edit

    # execution
    findings: list[dict[str, Any]]
    verified: bool

    # output
    answer: str
    outcome: str               # completed | denied | rejected | error
    audit_path: Optional[str]
