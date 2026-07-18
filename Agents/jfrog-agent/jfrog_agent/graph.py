r"""LangGraph assembly for the JFrog operations copilot.

    User request
        v
    interpret            (intent + scope)
        v
    classify             (read / write / risk)
        v
    plan                 (task decomposition + deterministic authorization)
        v
    artifactory_subgraph (collect evidence via read tools)
        v
    evidence             (validate findings)
        v
    policy               (risk engine -> route)
        v         \
    execute        approval  (LangGraph interrupt for high-risk ops)
        \         /
        verify
        v
    audit                (immutable record + final answer)

Human-in-the-loop uses LangGraph `interrupt`, so a high-risk operation pauses
the graph, persists state via the checkpointer, and resumes on approve/reject.
"""

from __future__ import annotations

from typing import Any

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

from .audit_log import AuditTrail
from .llm import Plan, PlannedAction, make_plan, summarize
from .mcp_client import GatewayMCPClient, MCPError
from .security import Authorizer
from .settings import Settings, settings as default_settings
from .state import AgentState
from .tools import artifactory as art
from .tools.aql import AQLValidationError, describe_intent
from .tools.registry import RiskClass, get_spec


def build_graph(
    client: GatewayMCPClient,
    audit: AuditTrail,
    settings: Settings = default_settings,
    checkpointer=None,
):
    authorizer = Authorizer(settings)

    # ── interpret ────────────────────────────────────────────────────────────
    def interpret(state: AgentState) -> dict[str, Any]:
        plan, kind = make_plan(state["request"], settings)
        audit.record("interpret", {"planner": kind, "summary": plan.summary, "actions": [a.tool for a in plan.actions]})
        return {"plan": plan, "planner_kind": kind, "request_type": plan.request_type}

    # ── classify ──────────────────────────────────────────────────────────────
    def classify(state: AgentState) -> dict[str, Any]:
        plan: Plan = state["plan"]
        # Elevate request_type from the highest-risk action present.
        rank = {RiskClass.READ: 0, RiskClass.REVERSIBLE_WRITE: 1, RiskClass.SENSITIVE_WRITE: 2, RiskClass.DESTRUCTIVE: 3}
        highest = RiskClass.READ
        for a in plan.actions:
            spec = get_spec(a.tool)
            if spec and rank[spec.risk] > rank[highest]:
                highest = spec.risk
        rt = "read" if highest == RiskClass.READ else ("risk" if highest == RiskClass.DESTRUCTIVE else "write")
        audit.record("classify", {"request_type": rt, "highest_risk": highest.value})
        return {"request_type": rt}

    # ── plan (decompose + authorize) ──────────────────────────────────────────
    def plan_node(state: AgentState) -> dict[str, Any]:
        plan: Plan = state["plan"]
        notes: list[dict[str, Any]] = []
        approval_required = False
        approval_payload: dict[str, Any] | None = None

        if not plan.actions:
            notes.append({"tool": None, "allowed": False, "reason": "no executable read action derived from request"})

        for a in plan.actions:
            spec = get_spec(a.tool)
            if spec is None:
                notes.append({"tool": a.tool, "allowed": False, "reason": "unknown tool"})
                continue
            repos = list(a.search_intent.repositories) if a.search_intent else (
                [a.args["repository"]] if a.args.get("repository") else (
                    [a.args["repo"]] if a.args.get("repo") else []
                )
            )
            decision = authorizer.decide(spec, repos)
            note = {"tool": a.tool, "risk": spec.risk.value, "allowed": decision.allowed,
                    "needs_approval": decision.needs_approval, "reason": decision.reason, "repositories": repos}
            notes.append(note)
            if decision.allowed and decision.needs_approval:
                approval_required = True
                approval_payload = {
                    "operation": a.tool,
                    "risk": spec.risk.value,
                    "scope": {"repositories": repos},
                    "rationale": a.rationale,
                    "approval_options": ["approve", "reject", "edit"],
                }

        audit.record("plan", {"authz_notes": notes, "approval_required": approval_required})
        return {"authz_notes": notes, "approval_required": approval_required, "approval_payload": approval_payload}

    # ── artifactory subgraph (collect evidence) ───────────────────────────────
    def artifactory_subgraph(state: AgentState) -> dict[str, Any]:
        plan: Plan = state["plan"]
        notes = {n["tool"]: n for n in state.get("authz_notes", [])}
        findings: list[dict[str, Any]] = []

        # Only READ actions that were authorized run automatically here.
        for a in plan.actions:
            spec = get_spec(a.tool)
            note = notes.get(a.tool, {})
            if not spec or spec.risk != RiskClass.READ or not note.get("allowed") or note.get("needs_approval"):
                continue
            try:
                finding = _run_read_action(client, a, settings)
            except AQLValidationError as e:
                finding = {"tool": a.tool, "is_error": True, "result": f"blocked by AQL validator: {e}"}
            except (MCPError, Exception) as e:  # noqa: BLE001 - surface upstream errors as findings
                finding = {"tool": a.tool, "is_error": True, "result": f"{type(e).__name__}: {e}"}
            audit.record("tool_call", {"tool": a.tool, "is_error": finding.get("is_error"), "intent": finding.get("intent")})
            findings.append(finding)

        return {"findings": findings}

    # ── evidence validator ─────────────────────────────────────────────────────
    def evidence(state: AgentState) -> dict[str, Any]:
        findings = state.get("findings", [])
        errored = [f for f in findings if f.get("is_error")]
        verified = len(findings) > 0 and len(errored) == 0
        audit.record("evidence", {"findings": len(findings), "errors": len(errored), "verified": verified})
        return {"verified": verified}

    # ── policy / risk engine (route) ───────────────────────────────────────────
    def policy(state: AgentState) -> dict[str, Any]:
        audit.record("policy", {"approval_required": state.get("approval_required", False)})
        return {}

    def route_after_policy(state: AgentState) -> str:
        return "approval" if state.get("approval_required") else "audit"

    # ── approval (human-in-the-loop interrupt) ─────────────────────────────────
    def approval(state: AgentState) -> dict[str, Any]:
        payload = state.get("approval_payload") or {"operation": "unknown"}
        # Pauses the graph; resume with Command(resume="approve"|"reject").
        decision = interrupt({"type": "approval_request", **payload})
        decision = (decision or "reject").lower() if isinstance(decision, str) else "reject"
        audit.record("approval", {"decision": decision, "operation": payload.get("operation")})
        return {"approval_decision": decision}

    def route_after_approval(state: AgentState) -> str:
        return "execute" if state.get("approval_decision") == "approve" else "audit"

    # ── execute + verify (write/destructive; Phase 2+) ─────────────────────────
    def execute(state: AgentState) -> dict[str, Any]:
        # Write/destructive execution is intentionally not wired to live MCP tools
        # yet (the upstream Artifactory MCP exposes read tools only). We record the
        # approved intent so the audit trail is complete and return a clear note.
        payload = state.get("approval_payload") or {}
        audit.record("execute", {"operation": payload.get("operation"), "status": "not_implemented"})
        findings = list(state.get("findings", []))
        findings.append({
            "tool": payload.get("operation"),
            "is_error": True,
            "result": "Approved, but write execution is not enabled in this build (Phase 1 is read-only).",
        })
        return {"findings": findings}

    # ── audit + respond ─────────────────────────────────────────────────────────
    def audit_node(state: AgentState) -> dict[str, Any]:
        findings = state.get("findings", [])
        notes = state.get("authz_notes", [])
        denials = [n for n in notes if not n.get("allowed")]

        if state.get("approval_decision") == "reject":
            outcome = "rejected"
            answer = "The requested operation was rejected at the approval step. No changes were made."
        elif not findings and denials:
            outcome = "denied"
            reasons = "; ".join(n.get("reason", "") for n in denials if n.get("reason"))
            answer = f"I could not run this request under the current policy.\n\nReason(s): {reasons}"
        else:
            outcome = "completed"
            answer = summarize(state["request"], findings, settings)

        path = audit.finalize(state.get("user"), state["request"], outcome)
        return {"answer": answer, "outcome": outcome, "audit_path": str(path)}

    # ── assemble ────────────────────────────────────────────────────────────────
    g = StateGraph(AgentState)
    g.add_node("interpret", interpret)
    g.add_node("classify", classify)
    g.add_node("plan", plan_node)
    g.add_node("artifactory_subgraph", artifactory_subgraph)
    g.add_node("evidence", evidence)
    g.add_node("policy", policy)
    g.add_node("approval", approval)
    g.add_node("execute", execute)
    g.add_node("audit", audit_node)

    g.add_edge(START, "interpret")
    g.add_edge("interpret", "classify")
    g.add_edge("classify", "plan")
    g.add_edge("plan", "artifactory_subgraph")
    g.add_edge("artifactory_subgraph", "evidence")
    g.add_edge("evidence", "policy")
    g.add_conditional_edges("policy", route_after_policy, {"approval": "approval", "audit": "audit"})
    g.add_conditional_edges("approval", route_after_approval, {"execute": "execute", "audit": "audit"})
    g.add_edge("execute", "audit")
    g.add_edge("audit", END)

    return g.compile(checkpointer=checkpointer or MemorySaver())


def _run_read_action(client: GatewayMCPClient, action: PlannedAction, settings: Settings) -> dict[str, Any]:
    tool = action.tool
    args = action.args
    if tool == "search_artifacts":
        return art.search_artifacts(client, action.search_intent, settings)
    if tool == "list_repositories":
        return art.list_repositories(client, args.get("type"))
    if tool == "get_repository_info":
        return art.get_repository_info(client, args["repository"])
    if tool == "get_artifact_info":
        return art.get_artifact_info(client, args["repo"], args["path"])
    if tool == "get_folder_info":
        return art.get_folder_info(client, args["repo"], args.get("path", ""))
    if tool == "get_system_info":
        return art.get_system_info(client)
    if tool == "get_storage_info":
        return art.get_storage_info(client)
    raise MCPError(f"no read handler for tool '{tool}'")
