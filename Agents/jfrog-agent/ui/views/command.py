"""Command Center: Home dashboard + Ask JFrog Agent."""

from __future__ import annotations

import pandas as pd
import streamlit as st

from .. import sample_data as sd
from .. import state
from ..components import (
    affected_count,
    execution_timeline,
    kv,
    metric_row,
    preview_banner,
    section,
    tool_activity,
)
from ..theme import severity_chip, status_chip

PROMPT_STARTERS = [
    ("🛡️ Investigate a CVE", "Investigate all critical Xray violations affecting production images"),
    ("🔎 Find an artifact", "Find Docker images larger than 2 GB"),
    ("🚦 Check build readiness", "Can build payment-service 319 be promoted to production?"),
    ("💾 Analyze repository storage", "How much storage are we using and what is reclaimable?"),
    ("📜 Explain a policy violation", "Explain why build payment-service/319 was blocked"),
    ("🧰 Troubleshoot download failure", "Why am I unable to download this package from docker-prod-local?"),
]


# ── Home ──────────────────────────────────────────────────────────────────────
def home():
    section("Operations Cockpit", "A live overview of security, storage and workflow health.")

    metric_row(sd.HOME_KPIS[:3])
    metric_row(sd.HOME_KPIS[3:])

    st.write("")
    left, right = st.columns([3, 2])

    with left:
        section("Security posture")
        posture = pd.DataFrame(
            {"severity": list(sd.SEVERITY_POSTURE.keys()), "count": list(sd.SEVERITY_POSTURE.values())}
        ).set_index("severity")
        st.bar_chart(posture, color="#dc2626", height=240)
        fc1, fc2, fc3 = st.columns(3)
        fc1.selectbox("Project", ["All", "payments", "checkout", "identity"])
        fc2.selectbox("Environment", ["All", "prod", "staging", "dev"])
        fc3.selectbox("Package type", ["All", "docker", "maven", "npm"])
        preview_banner()

    with right:
        section("Recent agent investigations")
        for inv in sd.RECENT_INVESTIGATIONS:
            with st.container(border=True):
                st.markdown(f"**{inv['title']}**")
                st.caption(inv["when"])
                for fct in inv["facts"]:
                    st.markdown(f"- {fct}")

    st.write("")
    section("Recommended actions")
    cols = st.columns(2)
    for i, act in enumerate(sd.RECOMMENDED_ACTIONS):
        with cols[i % 2]:
            with st.container(border=True):
                st.markdown(f"{severity_chip(act['risk'])} &nbsp; {act['text']}", unsafe_allow_html=True)
                b1, b2, b3, b4 = st.columns(4)
                b1.button("Investigate", key=f"inv_{i}", disabled=True)
                b2.button("Preview", key=f"prev_{i}", disabled=True)
                b3.button("Assign", key=f"assign_{i}", disabled=True)
                b4.button("Dismiss", key=f"dismiss_{i}", disabled=True)
    preview_banner("Home KPIs and recommendations are illustrative. Artifact search, storage and audit pages use live data.")


# ── Ask JFrog Agent ───────────────────────────────────────────────────────────
def _connection_gate() -> bool:
    if state.try_connect():
        return True
    st.warning("Not connected to the gateway. Authorize once to start (token is cached).")
    if st.button("🔐 Authorize with gateway", type="primary"):
        state.do_login()
    return False


def _summary_from_audit(audit) -> dict:
    kinds = {e["kind"] for e in getattr(audit, "events", [])}
    return {"done_kinds": kinds, "executed": "execute" in kinds}


def agent_chat():
    section("Ask the JFrog Agent", "Conversational, read-only by default, with a transparent execution flow.")
    if not _connection_gate():
        return

    if "chat" not in st.session_state:
        st.session_state.chat = []

    # thread controls (durable memory)
    tid = state.current_thread_id()
    tcol1, tcol2 = st.columns([4, 1])
    with tcol1:
        backend = state.get_backend()
        if backend is None:
            st.caption("⚠️ Memory backend unavailable — this conversation will not be saved.")
        else:
            th = None
            try:
                th = backend.get_thread(tid)
            except Exception:
                pass
            title = (th or {}).get("title") or "New conversation"
            st.caption(f"🧵 Thread: **{title}** · `{tid}`  ·  saved to `{state.effective_settings().memory_backend}`")
    with tcol2:
        if st.button("🆕 New chat", width="stretch"):
            state.new_thread()
            st.rerun()

    # suggested prompt starters
    st.markdown("<div class='prompt-hint'>Try a starter:</div>", unsafe_allow_html=True)
    scols = st.columns(3)
    picked = None
    for i, (label, prompt) in enumerate(PROMPT_STARTERS):
        if scols[i % 3].button(label, key=f"starter_{i}", width="stretch"):
            picked = prompt

    chat_col, ctx_col = st.columns([3, 1.15], gap="large")

    with chat_col:
        for i, m in enumerate(st.session_state.chat):
            with st.chat_message(m["role"]):
                st.markdown(m["content"])
                if m["role"] == "assistant":
                    meta = m.get("meta", {})
                    st.markdown(
                        f"{status_chip(meta.get('outcome','—'))} "
                        f"&nbsp;<span class='cc-sub'>planner: {meta.get('planner','?')} · "
                        f"audit: {meta.get('audit','—')}</span>",
                        unsafe_allow_html=True,
                    )
                    if m.get("findings"):
                        with st.expander("Tool activity"):
                            tool_activity(m["findings"])
                    _feedback_row(i, meta)

    typed = st.chat_input("Ask about repositories, artifacts, storage…  (read-only)")
    prompt = picked or typed

    # pending approval (interrupt) rendered in context panel below
    if prompt:
        st.session_state.chat.append({"role": "user", "content": prompt})
        state.save_message("user", prompt)
        with chat_col:
            with st.chat_message("user"):
                st.markdown(prompt)
            with st.chat_message("assistant"):
                with st.spinner("Working through the graph…"):
                    try:
                        result, graph, config, audit = state.run_agent(prompt)
                    except Exception as e:  # noqa: BLE001
                        st.error(f"Run failed: {e}")
                        st.session_state.connected = False
                        return
                payload = state.interrupt_payload(result, graph, config)
                s = _summary_from_audit(audit)
                if payload is not None:
                    st.session_state.pending = {
                        "graph": graph, "config": config, "payload": payload,
                        "prompt": prompt, "done_kinds": s["done_kinds"],
                    }
                    st.rerun()
                else:
                    _finalize(result, audit, s)
                    st.rerun()

    with ctx_col:
        _context_panel()


def _feedback_row(i: int, meta: dict):
    run_id = meta.get("run_id")
    if not run_id:
        return
    fb = st.session_state.setdefault("feedback_given", {})
    if fb.get(run_id):
        st.caption(f"Feedback recorded: {fb[run_id]}")
        return
    c1, c2, _ = st.columns([1, 1, 6])
    if c1.button("👍", key=f"fb_up_{i}_{run_id}", help="Helpful"):
        _record_feedback(run_id, 1)
    if c2.button("👎", key=f"fb_dn_{i}_{run_id}", help="Not helpful"):
        _record_feedback(run_id, -1)


def _record_feedback(run_id: str, rating: int):
    backend = state.get_backend()
    if backend:
        try:
            backend.record_feedback(run_id, state.current_thread_id(), rating)
        except Exception:
            pass
    st.session_state.setdefault("feedback_given", {})[run_id] = "👍" if rating > 0 else "👎"
    st.rerun()


def _finalize(result, audit, s):
    meta = {
        "outcome": result.get("outcome"),
        "planner": result.get("planner_kind"),
        "audit": str(result.get("audit_path", "—")).split("/")[-1],
        "run_id": result.get("run_id"),
        "request_type": result.get("request_type"),
        "needs_approval": bool(result.get("approval_required")),
        "executed": s["executed"],
        "completed": result.get("outcome") == "completed",
        "done_kinds": list(s["done_kinds"]),
        "affected": affected_count(result.get("findings", [])),
        "tools": [f.get("tool") for f in result.get("findings", [])],
    }
    st.session_state.chat.append(
        {
            "role": "assistant",
            "content": result.get("answer", "(no answer)"),
            "findings": result.get("findings", []),
            "meta": meta,
        }
    )
    st.session_state.last_meta = meta
    state.save_message("assistant", result.get("answer", "(no answer)"), meta, result.get("findings", []))


def _context_panel():
    section("Context")

    pending = st.session_state.get("pending")
    last = st.session_state.get("last_meta", {})

    env = state.effective_settings()
    with st.container(border=True):
        kv("Environment", "PROD (trial)")
        kv("Project", "All")
        kv("Namespace", env.namespace)
        kv("Client type", env.client_type)

    # agent execution transparency
    section("Agent execution")
    if pending:
        done = set(pending.get("done_kinds", []))
        execution_timeline(done, needs_approval=True, executed=False, completed=False)
    elif last:
        execution_timeline(
            set(last.get("done_kinds", [])),
            needs_approval=last.get("needs_approval", False),
            executed=last.get("executed", False),
            completed=last.get("completed", False),
        )
    else:
        st.caption("Run a query to see the LangGraph flow.")

    # risk / evidence / activity
    section("Signals")
    with st.container(border=True):
        confidence = {"llm": "High", "heuristic": "Medium"}.get(last.get("planner"), "—")
        kv("Agent confidence", confidence)
        kv("Operation risk", str(last.get("request_type", "—")).upper())
        kv("Affected resources", str(last.get("affected", 0)))
        tools = [t for t in last.get("tools", []) if t]
        kv("API tools used", ", ".join(tools) if tools else "—")
        kv("Approval status", "REQUIRED" if pending else ("NONE" if last else "—"))

    # inline approval
    if pending:
        section("Approval required")
        with st.container(border=True):
            st.markdown(status_chip("APPROVAL"), unsafe_allow_html=True)
            st.json(pending["payload"])
            c1, c2 = st.columns(2)
            if c1.button("✅ Approve", type="primary", key="ctx_appr"):
                result = state.resume_agent(pending["graph"], pending["config"], "approve")
                _post_resume(result, pending)
            if c2.button("🚫 Reject", key="ctx_rej"):
                result = state.resume_agent(pending["graph"], pending["config"], "reject")
                _post_resume(result, pending)


def _post_resume(result, pending):
    kinds = set(pending.get("done_kinds", []))
    kinds.add("approval")
    if result.get("outcome") == "completed":
        kinds.add("execute")
    st.session_state.pending = None
    meta = {
        "outcome": result.get("outcome"),
        "planner": result.get("planner_kind"),
        "audit": str(result.get("audit_path", "—")).split("/")[-1],
        "run_id": result.get("run_id"),
        "request_type": result.get("request_type"),
        "needs_approval": True,
        "executed": "execute" in kinds,
        "completed": result.get("outcome") == "completed",
        "done_kinds": list(kinds),
        "affected": affected_count(result.get("findings", [])),
        "tools": [f.get("tool") for f in result.get("findings", [])],
    }
    st.session_state.chat.append(
        {
            "role": "assistant",
            "content": result.get("answer", "(no answer)"),
            "findings": result.get("findings", []),
            "meta": meta,
        }
    )
    st.session_state.last_meta = meta
    state.save_message("assistant", result.get("answer", "(no answer)"), meta, result.get("findings", []))
    st.rerun()
