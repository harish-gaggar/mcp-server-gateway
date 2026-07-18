"""Operations: Artifact Explorer (live), Build Promotion, Cleanup, Troubleshooting."""

from __future__ import annotations

import pandas as pd
import streamlit as st

from jfrog_agent.tools import artifactory as art
from jfrog_agent.tools.aql import AQLValidationError, SearchIntent

from .. import sample_data as sd
from .. import state
from ..components import kv, metric_row, preview_banner, section
from ..theme import severity_chip, status_chip


def _gate() -> bool:
    if state.try_connect():
        return True
    st.warning("Not connected. Go to **Ask JFrog Agent** or authorize below.")
    if st.button("🔐 Authorize with gateway", type="primary", key="ops_login"):
        state.do_login()
    return False


# ── Artifact Explorer (live) ──────────────────────────────────────────────────
def artifact_explorer():
    section("Artifact Explorer", "Natural-language search + structured filters over live Artifactory data.")
    if not _gate():
        return

    client = state.get_client()
    s = state.effective_settings()

    with st.sidebar:
        st.markdown("### Filters")
        f_repo = st.text_input("Repository", "")
        f_type = st.selectbox("Package type", ["", "docker", "npm", "maven", "pypi", "helm", "nuget", "go"])
        f_not_dl = st.number_input("Not downloaded for (days)", min_value=0, value=0, step=30)
        f_min_gb = st.number_input("Min size (GB)", min_value=0.0, value=0.0, step=0.5)
        f_name = st.text_input("Name pattern (supports *)", "")
        f_limit = st.slider("Max results", 10, s.aql_max_results, min(100, s.aql_max_results))
        run_filters = st.button("Run filtered search", width="stretch")

    nl = st.text_input(
        "Search by artifact, package, checksum, build, property, or natural language",
        placeholder="Show Maven artifacts not downloaded in the last 180 days",
    )
    c1, c2 = st.columns([1, 3])
    run_nl = c1.button("Search", type="primary")
    if c2.button("List repositories"):
        _repo_list(client)

    rows = None
    if run_nl and nl:
        with st.spinner("Asking the agent…"):
            result, *_ = state.run_agent(nl)
        st.markdown(result.get("answer", ""))
        rows = _rows_from_findings(result.get("findings", []))
    elif run_filters:
        intent = SearchIntent(
            repositories=[f_repo] if f_repo else [],
            package_type=f_type or None,
            name_pattern=f_name or None,
            not_downloaded_for_days=int(f_not_dl) or None,
            min_size_bytes=int(f_min_gb * 1024**3) or None,
            limit=int(f_limit),
        )
        try:
            with st.spinner("Searching…"):
                finding = art.search_artifacts(client, intent, s)
            st.code(finding.get("aql", ""), language="text")
            rows = _rows_from_findings([finding])
        except AQLValidationError as e:
            st.error(f"Blocked by AQL validator: {e}")

    if rows is not None:
        section(f"Results ({len(rows)})")
        if rows:
            st.dataframe(pd.DataFrame(rows), width="stretch", hide_index=True)
        else:
            st.caption("No matching artifacts.")

    with st.expander("Row actions (Phase 2)"):
        st.caption(
            "View metadata · dependency graph · Xray findings · compare versions · "
            "download · copy/promote · prepare deletion — wired as the upstream MCP "
            "exposes these tools."
        )


def _repo_list(client):
    try:
        with st.spinner("Loading repositories…"):
            res = art.list_repositories(client)
        data = res.get("result")
        if isinstance(data, list):
            st.dataframe(pd.DataFrame(data), width="stretch", hide_index=True)
        else:
            st.json(data)
    except Exception as e:  # noqa: BLE001
        st.error(f"Failed: {e}")


def _rows_from_findings(findings) -> list[dict]:
    rows: list[dict] = []
    for f in findings:
        r = f.get("result")
        items = None
        if isinstance(r, dict) and isinstance(r.get("results"), list):
            items = r["results"]
        elif isinstance(r, list):
            items = r
        if items:
            for it in items:
                rows.append(it if isinstance(it, dict) else {"value": it})
    return rows


# ── Build Promotion Center ────────────────────────────────────────────────────
def build_promotion():
    b = sd.BUILD
    section("Build Promotion Center", f"Release gate for {b['name']} / {b['number']}")
    preview_banner()

    c1, c2 = st.columns([1, 2])
    with c1:
        with st.container(border=True):
            st.markdown("#### Readiness score")
            st.markdown(f"<div style='font-size:2.6rem;font-weight:800'>{b['readiness']} / 100</div>", unsafe_allow_html=True)
            st.progress(b["readiness"] / 100)
    with c2:
        with st.container(border=True):
            st.markdown("#### Readiness checks")
            for label, chk in b["checks"]:
                st.markdown(f"{status_chip(chk)} &nbsp; {label}", unsafe_allow_html=True)

    section("Promotion flow")
    st.markdown("**Development → QA → Staging → Production**")
    st.dataframe(pd.DataFrame(b["stages"]), width="stretch", hide_index=True)

    section("Change preview")
    with st.container(border=True):
        for k, v in b["change_preview"].items():
            kv(k, v)
    a, bb, c, d = st.columns(4)
    a.button("Promote", type="primary", disabled=True)
    bb.button("Request approval", disabled=True)
    c.button("Reject", disabled=True)
    d.button("Compare with previous prod build", disabled=True)


# ── Cleanup Intelligence ──────────────────────────────────────────────────────
def cleanup():
    section("Cleanup Intelligence", "Defensible, dry-run-first storage reclamation.")
    preview_banner()

    metric_row([{"label": k, "value": v} for k, v in list(sd.CLEANUP_STORAGE.items())[:3]])
    metric_row([{"label": k, "value": v} for k, v in list(sd.CLEANUP_STORAGE.items())[3:]])

    section("Cleanup strategies")
    cols = st.columns(4)
    for i, strat in enumerate(sd.CLEANUP_STRATEGIES):
        with cols[i]:
            with st.container(border=True):
                st.markdown(f"**{strat['name']}**")
                st.markdown(f"<div style='font-size:1.4rem;font-weight:750'>{strat['saving']}</div>", unsafe_allow_html=True)
                st.caption("potential saving")

    section("Safety exclusions")
    with st.container(border=True):
        for ex in sd.CLEANUP_EXCLUSIONS:
            st.markdown(f"{status_chip('PASSED')} &nbsp; {ex}", unsafe_allow_html=True)

    section("Deletion preview")
    st.dataframe(pd.DataFrame(sd.CLEANUP_PREVIEW), width="stretch", hide_index=True)
    cols = st.columns(5)
    for i, label in enumerate(["Generate dry run", "Download manifest", "Send for approval", "Delete approved batch", "Schedule proposal"]):
        cols[i].button(label, disabled=True, key=f"cleanup_{i}")
    st.caption("Deletion is never one-click: candidates → exclusions → references → estimate → manifest → approval → bounded batches → verify.")


# ── Troubleshooting Assistant ─────────────────────────────────────────────────
def troubleshooting():
    section("Troubleshooting Assistant", "Guided diagnostics that correlate config, permissions and scope.")
    preview_banner()

    issue = st.selectbox("What's happening?", list(sd.TROUBLESHOOT_FLOWS.keys()))
    if st.button("Run diagnostic", type="primary"):
        st.session_state.ts_issue = issue

    chosen = st.session_state.get("ts_issue")
    if chosen:
        section(f"Diagnostic: {chosen}")
        for step, st_state in sd.TROUBLESHOOT_FLOWS[chosen]:
            icon = "✓" if st_state == "PASSED" else ("✗" if st_state == "BLOCKED" else "⚠")
            st.markdown(f"{status_chip(st_state)} &nbsp; {icon} {step}", unsafe_allow_html=True)
        st.success(f"Recommended fix: {sd.TROUBLESHOOT_FIX[chosen]}")
