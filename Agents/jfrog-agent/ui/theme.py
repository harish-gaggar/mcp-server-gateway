"""Cockpit visual theme: global CSS + status/severity color helpers.

Workflow-state colors and security-severity colors are kept DELIBERATELY
separate so users never confuse "pending" (a workflow state) with "medium" (a
vulnerability severity).
"""

from __future__ import annotations

import streamlit as st

# Workflow / operation states
WORKFLOW_COLORS = {
    "PASSED": "#22c55e",
    "COMPLETED": "#22c55e",
    "WARNING": "#f59e0b",
    "BLOCKED": "#ef4444",
    "DENIED": "#ef4444",
    "REJECTED": "#ef4444",
    "PENDING": "#3b82f6",
    "APPROVAL": "#a855f7",
    "READ ONLY": "#94a3b8",
    "READ-ONLY": "#94a3b8",
}

# Security severities (distinct palette)
SEVERITY_COLORS = {
    "CRITICAL": "#dc2626",
    "HIGH": "#f97316",
    "MEDIUM": "#eab308",
    "LOW": "#16a34a",
    "UNKNOWN": "#64748b",
}

_CSS = """
<style>
:root {
  --card-bg: #141A2B;
  --card-bg-2: #10182b;
  --border: #24304a;
  --muted: #8b95ab;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
.block-container { padding-top: 1.2rem; padding-bottom: 3rem; max-width: 1500px; }

/* header bar */
.cc-header {
  display:flex; align-items:center; justify-content:space-between;
  background: linear-gradient(90deg,#131a2e 0%, #0e1424 100%);
  border:1px solid var(--border); border-radius:14px;
  padding:14px 20px; margin-bottom:18px;
}
.cc-title { font-size:1.25rem; font-weight:700; letter-spacing:.2px; }
.cc-title .frog { margin-right:8px; }
.cc-meta { display:flex; gap:10px; align-items:center; }

/* generic card */
.cc-card {
  background: var(--card-bg); border:1px solid var(--border);
  border-radius:14px; padding:16px 18px; margin-bottom:14px;
}
.cc-card h4 { margin:0 0 6px 0; font-size:.95rem; }
.cc-sub { color: var(--muted); font-size:.82rem; }

/* metric cards */
.cc-metric {
  background: var(--card-bg); border:1px solid var(--border);
  border-radius:14px; padding:16px 18px; height:100%;
}
.cc-metric .label { color:var(--muted); font-size:.8rem; text-transform:uppercase; letter-spacing:.06em; }
.cc-metric .value { font-size:1.9rem; font-weight:750; margin-top:4px; line-height:1.1; }
.cc-metric .delta { font-size:.8rem; margin-top:6px; }
.delta-up { color:#f87171; } .delta-down { color:#4ade80; } .delta-flat { color:var(--muted); }

/* chips */
.chip {
  display:inline-block; padding:2px 10px; border-radius:999px;
  font-size:.72rem; font-weight:700; letter-spacing:.03em;
  border:1px solid transparent; white-space:nowrap;
}
.mono { font-family: var(--mono); }

/* section title */
.cc-section { font-size:1.05rem; font-weight:700; margin:6px 0 10px 0; }

/* timeline */
.cc-timeline { list-style:none; padding-left:4px; margin:0; }
.cc-timeline li { display:flex; align-items:center; gap:10px; padding:5px 0; font-size:.9rem; }
.cc-dot { width:18px; text-align:center; }
.cc-done { color:#4ade80; } .cc-active { color:#60a5fa; } .cc-todo { color:var(--muted); }

/* right context panel */
.cc-context { position:sticky; top:8px; }
.cc-kv { display:flex; justify-content:space-between; padding:5px 0; border-bottom:1px dashed var(--border); font-size:.85rem; }
.cc-kv .k { color:var(--muted); }
.cc-kv .v { font-weight:650; text-align:right; }

/* small preview banner */
.cc-preview {
  background: rgba(124,108,240,.10); border:1px solid #3a3670;
  color:#c7c0ff; border-radius:10px; padding:8px 12px; font-size:.8rem; margin-bottom:12px;
}
.prompt-hint { color:var(--muted); font-size:.8rem; margin: 2px 0 6px; }
</style>
"""


def inject():
    st.markdown(_CSS, unsafe_allow_html=True)


def chip(label: str, color: str) -> str:
    return (
        f"<span class='chip' style='background:{color}22;color:{color};"
        f"border-color:{color}55'>{label}</span>"
    )


def status_chip(state: str) -> str:
    key = (state or "").upper()
    return chip(key or "—", WORKFLOW_COLORS.get(key, "#94a3b8"))


def severity_chip(sev: str) -> str:
    key = (sev or "UNKNOWN").upper()
    return chip(key, SEVERITY_COLORS.get(key, SEVERITY_COLORS["UNKNOWN"]))
