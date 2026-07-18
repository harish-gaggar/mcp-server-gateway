"""Governance: Approval Center, Audit Trail (live), Agent Observability."""

from __future__ import annotations

import datetime as dt

import pandas as pd
import streamlit as st

from .. import sample_data as sd
from .. import state
from ..components import kv, preview_banner, section
from ..theme import severity_chip, status_chip


# ── Approval Center ───────────────────────────────────────────────────────────
def approvals():
    section("Approval Center", "Inbox for human-in-the-loop operations.")

    # live pending approval from the agent (if any)
    pending = st.session_state.get("pending")
    if pending:
        section("Live agent request")
        with st.container(border=True):
            st.markdown(status_chip("APPROVAL"), unsafe_allow_html=True)
            st.json(pending["payload"])
            reason = st.text_input("Approval reason (required for sensitive actions)", key="live_reason")
            c1, c2 = st.columns(2)
            if c1.button("Approve", type="primary", key="gov_appr", disabled=not reason):
                result = state.resume_agent(pending["graph"], pending["config"], "approve")
                st.session_state.pending = None
                st.success(f"Approved. Outcome: {result.get('outcome')}")
            if c2.button("Reject", key="gov_rej"):
                state.resume_agent(pending["graph"], pending["config"], "reject")
                st.session_state.pending = None
                st.warning("Rejected.")

    section("Queue")
    preview_banner("Queue items below are sample approvals. Live agent requests appear above and are fully wired.")
    for i, item in enumerate(sd.APPROVALS_INBOX):
        with st.container(border=True):
            top = st.columns([4, 1])
            top[0].markdown(f"#### {item['operation']}")
            top[1].markdown(severity_chip(item["risk"]), unsafe_allow_html=True)
            kv("Requested by", item["requested_by"])
            kv("Environment", item["environment"])
            kv("Rollback", item["rollback"])
            with st.expander("Review details"):
                st.markdown("**Affected resources / scope**")
                st.json(item["scope"])
                st.markdown("**Risk analysis** · **Policy checks** · **Dry-run result** · **Rollback plan** · **Verification steps**")
                st.caption("Populated from the agent's plan when wired to Phase 2/3 write tools.")
                st.text_input("Reason", key=f"reason_{i}")
            b = st.columns(4)
            b[0].button("Approve", key=f"q_appr_{i}", disabled=True)
            b[1].button("Edit scope", key=f"q_edit_{i}", disabled=True)
            b[2].button("Reject", key=f"q_rej_{i}", disabled=True)
            b[3].button("Assign", key=f"q_assign_{i}", disabled=True)


# ── Audit Trail (live) ────────────────────────────────────────────────────────
def audit_trail():
    section("Audit Trail", "Every agent run, recorded immutably (secrets redacted).")
    records = state.load_audit_records()
    if not records:
        st.info("No audit records yet. Run a query in **Ask JFrog Agent** to generate one.")
        return

    rows = []
    for r in records:
        rows.append(
            {
                "Time": _fmt_ts(r.get("created_at")),
                "User": r.get("user") or "—",
                "Request": (r.get("request") or "")[:70],
                "Outcome": r.get("outcome"),
                "Client": r.get("client_type"),
                "Run ID": r.get("run_id"),
            }
        )
    st.dataframe(pd.DataFrame(rows), width="stretch", hide_index=True)

    section("Execution detail")
    run_ids = [r.get("run_id") for r in records]
    chosen = st.selectbox("Select run", run_ids)
    rec = next((r for r in records if r.get("run_id") == chosen), None)
    if rec:
        _render_run_detail(rec)


def _render_run_detail(rec: dict):
    events = rec.get("events", [])
    kinds = [e.get("kind") for e in events]
    with st.container(border=True):
        kv("Request ID", rec.get("run_id"))
        kv("User", rec.get("user") or "—")
        kv("Outcome", rec.get("outcome"))
        kv("Client type", rec.get("client_type"))
        kv("Tools used", str(sum(1 for k in kinds if k == "tool_call")))
        kv("Duration", _duration(events))

    st.markdown("**Node execution**")
    flow = " → ".join(
        label for label, kind in [
            ("Intent", "interpret"), ("Classify", "classify"), ("Plan", "plan"),
            ("Evidence", "tool_call"), ("Validate", "evidence"), ("Policy", "policy"),
            ("Approval", "approval"), ("Execute", "execute"),
        ] if kind in kinds
    )
    st.markdown(f"`{flow} → Complete`")

    with st.expander("Raw events (redacted)"):
        st.json(events)


# ── Agent Observability ───────────────────────────────────────────────────────
def observability():
    section("Agent Observability", "What did the agent do, and how did it flow through the graph?")
    records = state.load_audit_records()
    if not records:
        st.info("No runs yet.")
        return

    total = len(records)
    completed = sum(1 for r in records if r.get("outcome") == "completed")
    denied = sum(1 for r in records if r.get("outcome") in ("denied", "rejected"))
    tool_calls = sum(sum(1 for e in r.get("events", []) if e.get("kind") == "tool_call") for r in records)

    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Total runs", total)
    c2.metric("Completed", completed)
    c3.metric("Denied / rejected", denied)
    c4.metric("Tool calls", tool_calls)

    section("Traffic by client type")
    by_client: dict[str, int] = {}
    for r in records:
        by_client[r.get("client_type", "unknown")] = by_client.get(r.get("client_type", "unknown"), 0) + 1
    st.bar_chart(pd.DataFrame({"runs": by_client}))
    st.caption(
        "The gateway records the same `client_type` on its OpenTelemetry spans — "
        "see the Grafana MCP Gateway dashboard to compare agent vs coding-assistant traffic."
    )


def _fmt_ts(ts) -> str:
    try:
        return dt.datetime.fromtimestamp(float(ts)).strftime("%m-%d %H:%M")
    except Exception:
        return "—"


def _duration(events) -> str:
    ts = [e.get("ts") for e in events if e.get("ts")]
    if len(ts) < 2:
        return "—"
    try:
        return f"{max(ts) - min(ts):.1f}s"
    except Exception:
        return "—"
