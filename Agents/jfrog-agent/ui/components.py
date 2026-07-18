"""Reusable UI components rendered as styled HTML cards."""

from __future__ import annotations

from typing import Any

import streamlit as st

from .theme import chip, severity_chip, status_chip


def section(title: str, sub: str | None = None):
    st.markdown(f"<div class='cc-section'>{title}</div>", unsafe_allow_html=True)
    if sub:
        st.markdown(f"<div class='cc-sub' style='margin-top:-8px'>{sub}</div>", unsafe_allow_html=True)


def preview_banner(text: str = "Preview — sample data. Wire to the JFrog Xray/Build APIs in Phase 2."):
    st.markdown(f"<div class='cc-preview'>🧪 {text}</div>", unsafe_allow_html=True)


def metric_card(label: str, value: str, delta: str | None = None, direction: str = "flat"):
    d = ""
    if delta:
        d = f"<div class='delta delta-{direction}'>{delta}</div>"
    st.markdown(
        f"<div class='cc-metric'><div class='label'>{label}</div>"
        f"<div class='value'>{value}</div>{d}</div>",
        unsafe_allow_html=True,
    )


def metric_row(cards: list[dict]):
    cols = st.columns(len(cards))
    for col, c in zip(cols, cards):
        with col:
            metric_card(c["label"], c["value"], c.get("delta"), c.get("direction", "flat"))


def kv(label: str, value: str):
    st.markdown(
        f"<div class='cc-kv'><span class='k'>{label}</span>"
        f"<span class='v'>{value}</span></div>",
        unsafe_allow_html=True,
    )


# ── LangGraph execution timeline ──────────────────────────────────────────────
# canonical steps and the audit "kind" that marks each done
TIMELINE_STEPS = [
    ("Understand request", "interpret"),
    ("Classify risk", "classify"),
    ("Plan & authorize", "plan"),
    ("Collect evidence", "tool_call"),
    ("Validate evidence", "evidence"),
    ("Risk evaluation", "policy"),
    ("Approval", "approval"),
    ("Execute", "execute"),
    ("Audit & respond", None),  # always last
]


def execution_timeline(done_kinds: set[str], *, needs_approval: bool, executed: bool, completed: bool):
    html = ["<ul class='cc-timeline'>"]
    for label, kind in TIMELINE_STEPS:
        if label == "Approval" and not needs_approval:
            state = "skip"
        elif label == "Execute" and not executed:
            state = "skip"
        elif label == "Audit & respond":
            state = "done" if completed else "todo"
        elif kind and kind in done_kinds:
            state = "done"
        else:
            state = "todo"
        icon = {"done": "✓", "active": "●", "todo": "○", "skip": "–"}[state]
        cls = {"done": "cc-done", "active": "cc-active", "todo": "cc-todo", "skip": "cc-todo"}[state]
        html.append(f"<li><span class='cc-dot {cls}'>{icon}</span><span>{label}</span></li>")
    html.append("</ul>")
    st.markdown("".join(html), unsafe_allow_html=True)


def tool_activity(findings: list[dict[str, Any]]):
    if not findings:
        st.caption("No tools were called.")
        return
    for f in findings:
        name = f.get("tool", "tool")
        ok = not f.get("is_error")
        status = status_chip("COMPLETED" if ok else "BLOCKED")
        records = _record_count(f.get("result"))
        with st.container(border=True):
            st.markdown(
                f"<span class='mono'>{name}</span> &nbsp; {status} "
                f"&nbsp; <span class='cc-sub'>records: {records}</span>",
                unsafe_allow_html=True,
            )
            if f.get("aql"):
                st.code(f["aql"], language="text")


def _record_count(result: Any) -> int:
    if isinstance(result, list):
        return len(result)
    if isinstance(result, dict):
        for key in ("results", "children", "repositories"):
            if isinstance(result.get(key), list):
                return len(result[key])
        return len(result)
    return 0 if result is None else 1


def affected_count(findings: list[dict[str, Any]]) -> int:
    return sum(_record_count(f.get("result")) for f in findings if not f.get("is_error"))


# ── approval card ─────────────────────────────────────────────────────────────
def approval_card(payload: dict[str, Any], key: str, *, on_approve=None, on_reject=None):
    op = payload.get("operation", "operation")
    risk = str(payload.get("risk", "unknown")).upper()
    with st.container(border=True):
        st.markdown(
            f"#### {op}  &nbsp; {chip(risk, '#a855f7')}",
            unsafe_allow_html=True,
        )
        scope = payload.get("scope", {})
        for k, v in scope.items():
            kv(k, str(v))
        if payload.get("rationale"):
            st.caption(payload["rationale"])
        c1, c2, c3 = st.columns(3)
        approved = c1.button("✅ Approve", key=f"appr_{key}", type="primary")
        rejected = c2.button("🚫 Reject", key=f"rej_{key}")
        c3.button("✏️ Edit scope", key=f"edit_{key}", disabled=True)
        if approved and on_approve:
            on_approve()
        if rejected and on_reject:
            on_reject()


def dataframe(rows: list[dict], severity_col: str | None = None, status_col: str | None = None):
    """Render a dense table; chips are handled by the caller via st.dataframe styling
    fallback (Streamlit can't embed HTML in st.dataframe, so we use st.table for chip
    rendering only when needed)."""
    import pandas as pd

    if not rows:
        st.caption("No results.")
        return
    df = pd.DataFrame(rows)
    st.dataframe(df, width="stretch", hide_index=True)
