"""Insights pages: Threads (durable memory) and LLM & Evaluation.

These are the *agent-side* observability surfaces. The gateway's Grafana
dashboard tracks MCP tool traffic; LLM model/token/cost/quality live here
because the gateway never sees LLM calls.
"""

from __future__ import annotations

import datetime as dt

import pandas as pd
import streamlit as st

from .. import state
from ..components import metric_card, section
from ..theme import chip


def _ts(v) -> str:
    try:
        return dt.datetime.fromtimestamp(float(v)).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return "—"


# ── Threads (durable conversation memory) ─────────────────────────────────────
def threads():
    section("Threads", "Past conversations persisted to durable memory. Resume where you left off.")
    backend = state.get_backend()
    if backend is None:
        st.error(
            "Memory backend unavailable: "
            + str(st.session_state.get("backend_error", "unknown error"))
        )
        return

    s = state.effective_settings()
    st.caption(f"Backend: **{s.memory_backend}**" + (f" · emulator `{s.spanner_emulator_host}`" if s.memory_backend == "spanner" and s.spanner_emulator_host else ""))

    c1, c2 = st.columns([1, 5])
    if c1.button("🆕 New chat", width="stretch"):
        state.new_thread()
        st.rerun()

    try:
        rows = backend.list_threads(200)
    except Exception as e:  # noqa: BLE001
        st.error(f"Could not list threads: {e}")
        return

    if not rows:
        st.info("No saved conversations yet. Ask the agent something to start a thread.")
        return

    current = state.current_thread_id()
    for t in rows:
        with st.container(border=True):
            cc1, cc2, cc3, cc4 = st.columns([5, 2, 2, 2])
            is_cur = t["thread_id"] == current
            title = t.get("title") or "(untitled)"
            with cc1:
                st.markdown(f"**{title}** {chip('CURRENT', '#22c55e') if is_cur else ''}", unsafe_allow_html=True)
                st.caption(f"`{t['thread_id']}` · {t.get('msg_count', 0)} messages")
            cc2.caption(f"created\n{_ts(t.get('created_at'))}")
            cc3.caption(f"updated\n{_ts(t.get('updated_at'))}")
            with cc4:
                if st.button("Open", key=f"open_{t['thread_id']}", width="stretch"):
                    state.load_thread(t["thread_id"])
                    st.success(f"Loaded {t['msg_count']} messages. Go to 'Ask JFrog Agent'.")
                if st.button("Delete", key=f"del_{t['thread_id']}", width="stretch"):
                    try:
                        backend.delete_thread(t["thread_id"])
                        if is_cur:
                            state.new_thread()
                        st.rerun()
                    except Exception as e:  # noqa: BLE001
                        st.error(str(e))


# ── LLM & Evaluation ──────────────────────────────────────────────────────────
def llm_eval():
    section("LLM & Evaluation", "Model, token usage, latency, cost and response quality — tracked agent-side.")
    backend = state.get_backend()
    if backend is None:
        st.error(
            "Memory backend unavailable: "
            + str(st.session_state.get("backend_error", "unknown error"))
        )
        return

    try:
        summary = backend.llm_summary()
        fb = backend.feedback_summary()
        calls = backend.list_llm_calls(500)
    except Exception as e:  # noqa: BLE001
        st.error(f"Could not read LLM telemetry: {e}")
        return

    total_fb = fb.get("total", 0)
    sat = f"{(fb.get('up', 0) / total_fb * 100):.0f}%" if total_fb else "—"

    cols = st.columns(5)
    with cols[0]:
        metric_card("LLM calls", f"{summary.get('calls', 0):,}")
    with cols[1]:
        metric_card("Total tokens", f"{int(summary.get('tokens', 0)):,}")
    with cols[2]:
        metric_card("Est. cost", f"${summary.get('cost', 0):.4f}")
    with cols[3]:
        metric_card("Avg latency", f"{summary.get('avg_latency_ms', 0):.0f} ms")
    with cols[4]:
        metric_card("Satisfaction", sat, delta=f"{fb.get('up',0)}▲ / {fb.get('down',0)}▼")

    st.write("")
    left, right = st.columns(2)
    with left:
        section("Usage by model")
        bm = summary.get("by_model", [])
        if bm:
            df = pd.DataFrame(bm)
            df = df.rename(columns={"avg_latency_ms": "avg_latency_ms"})
            st.dataframe(df, width="stretch", hide_index=True)
            chart = df[["model", "tokens"]].set_index("model")
            st.bar_chart(chart, height=200)
        else:
            st.caption("No model usage recorded yet.")

    with right:
        section("Quality signals")
        with st.container(border=True):
            _kv("Human feedback", f"{fb.get('up',0)} 👍 · {fb.get('down',0)} 👎 (of {total_fb})")
            plan_calls = [c for c in calls if c.get("purpose") == "plan"]
            sum_calls = [c for c in calls if c.get("purpose") == "summarize"]
            _kv("Planner LLM calls", str(len(plan_calls)))
            _kv("Summarizer LLM calls", str(len(sum_calls)))
            err = sum(1 for c in calls if not c.get("ok"))
            _kv("Failed LLM calls", str(err))
            if calls:
                avg_out = sum(int(c.get("completion_tokens") or 0) for c in calls) / len(calls)
                _kv("Avg output tokens", f"{avg_out:.0f}")
        st.caption(
            "Quality = human 👍/👎 on answers plus structural signals. Rate answers on the "
            "'Ask JFrog Agent' page to grow this dataset."
        )

    st.write("")
    section("Recent LLM calls")
    if calls:
        rows = [
            {
                "time": _ts(c.get("ts")),
                "purpose": c.get("purpose"),
                "provider": c.get("provider"),
                "model": c.get("model"),
                "in": c.get("prompt_tokens"),
                "out": c.get("completion_tokens"),
                "total": c.get("total_tokens"),
                "latency_ms": round(float(c.get("latency_ms") or 0)),
                "cost": round(float(c.get("cost") or 0), 5),
                "ok": bool(c.get("ok")),
            }
            for c in calls[:200]
        ]
        st.dataframe(pd.DataFrame(rows), width="stretch", hide_index=True)
    else:
        st.info("No LLM calls recorded yet. Ask the agent something (with an LLM provider configured).")


def _kv(label: str, value: str):
    from ..components import kv

    kv(label, value)
