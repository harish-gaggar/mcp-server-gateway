"""Security: Xray Security Center, Policies & Watches, Compliance Reports."""

from __future__ import annotations

import pandas as pd
import streamlit as st

from .. import sample_data as sd
from ..components import kv, preview_banner, section
from ..theme import severity_chip, status_chip


def xray_security():
    section("Xray Security Center", "Vulnerabilities, CVE impact and remediation planning.")
    preview_banner()

    df = pd.DataFrame(sd.VULNERABILITIES)
    section("Vulnerabilities")
    st.dataframe(df, width="stretch", hide_index=True)

    cve = st.selectbox("Investigate CVE", [v["CVE"] for v in sd.VULNERABILITIES])
    detail = sd.CVE_DETAIL.get(cve)
    if not detail:
        st.info("Detailed impact analysis available for CVE-2026-1234 in this preview.")
        return

    section(f"CVE investigation — {cve}")
    left, right = st.columns([1, 1])
    with left:
        with st.container(border=True):
            st.markdown(f"**Summary** — {detail['summary']}")
            kv("Exploitability", detail["exploitability"])
            kv("Affected versions", detail["affected_versions"])
            kv("Fixed versions", detail["fixed_versions"])
            kv("Policies triggered", ", ".join(detail["policies"]))
            kv("Repositories", ", ".join(detail["repositories"]))
            kv("Builds", ", ".join(detail["builds"]))
            kv("Owners", ", ".join(detail["owners"]))
    with right:
        with st.container(border=True):
            st.markdown("**Impact graph**")
            st.code("\n".join(detail["impact_tree"]), language="text")

    section("Remediation")
    rem = detail["remediation"]
    with st.container(border=True):
        st.markdown(f"**Recommended upgrade:** {rem['upgrade']}")
        kv("Affected builds", str(rem["affected_builds"]))
        kv("Applications requiring rebuild", str(rem["apps_requiring_rebuild"]))
        kv("Estimated complexity", rem["complexity"])
        kv("Policy blocking status", rem["policy_blocking"])
    cols = st.columns(6)
    for i, label in enumerate(["Generate plan", "Assign to team", "Create ticket", "Request exception", "Re-scan", "Export report"]):
        cols[i].button(label, disabled=True, key=f"xray_{i}")


def policies():
    section("Policies & Watch Coverage", "Where are the coverage gaps?")
    preview_banner()
    df = pd.DataFrame(sd.POLICY_COVERAGE)
    st.dataframe(df, width="stretch", hide_index=True)

    section("Agent recommendations")
    for rec in sd.POLICY_RECS:
        with st.container(border=True):
            st.markdown(f"{status_chip('WARNING')} &nbsp; {rec}", unsafe_allow_html=True)
    cols = st.columns(5)
    for i, label in enumerate(["Generate Watch proposal", "Compare policies", "Preview impact", "Request approval", "Apply approved config"]):
        cols[i].button(label, disabled=True, key=f"pol_{i}")


def compliance():
    section("Compliance Reports", "License and vulnerability reporting.")
    preview_banner()
    c1, c2, c3 = st.columns(3)
    c1.metric("GPL components in prod", "14")
    c2.metric("New criticals (7d)", "9")
    c3.metric("Overdue violations", "23")
    st.markdown("Useful reports:")
    for r in [
        "GPL-licensed components in production",
        "Critical vulnerabilities introduced in the last 7 days",
        "Xray exposure by business application",
        "Teams with the highest number of overdue violations",
    ]:
        with st.container(border=True):
            cc1, cc2 = st.columns([4, 1])
            cc1.markdown(r)
            cc2.button("Generate", key=f"rep_{r[:10]}", disabled=True)
