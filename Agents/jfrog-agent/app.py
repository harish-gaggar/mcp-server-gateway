"""JFrog Agent Command Center — multi-page Streamlit cockpit.

An operations copilot UI on top of the LangGraph agent: investigate artifacts,
run (preview) Xray analysis, approve operational actions and monitor agent
activity from one interface. Per-user OAuth through the MCP gateway; read-only by
default; deterministic authorization; human-in-the-loop approvals; audit trail.

Run:   streamlit run app.py      (or: docker compose up)
"""

from __future__ import annotations

import streamlit as st

st.set_page_config(page_title="JFrog Agent Command Center", page_icon="🐸", layout="wide")

from ui import state, theme  # noqa: E402
from ui.views import command, governance, insights, operations, security  # noqa: E402

theme.inject()


# ── header bar ────────────────────────────────────────────────────────────────
def render_header():
    s = state.effective_settings()
    connected = state.is_connected()
    status = theme.status_chip("PASSED" if connected else "PENDING")
    status_label = "CONNECTED" if connected else "NOT CONNECTED"
    user = st.session_state.get("user") or "—"
    st.markdown(
        f"""
        <div class='cc-header'>
          <div class='cc-title'><span class='frog'>🐸</span>JFrog Agent Command Center</div>
          <div class='cc-meta'>
            {theme.chip('ENV: PROD (trial)', '#3b82f6')}
            {theme.chip('USER: ' + user, '#94a3b8')}
            {theme.status_chip('READ ONLY' if s.read_only else 'WARNING')}
            {status}<span class='cc-sub' style='margin-left:6px'>{status_label}</span>
          </div>
        </div>
        """,
        unsafe_allow_html=True,
    )


# ── sidebar settings + connection ─────────────────────────────────────────────
def render_sidebar():
    s = state.effective_settings()
    with st.sidebar:
        st.divider()
        with st.expander("⚙️ Settings", expanded=not state.is_connected()):
            st.session_state.user = st.text_input("Your name (audit)", st.session_state.get("user", ""))
            gw = st.text_input("Gateway URL (server-side)", s.gateway_url)
            pub = st.text_input("Gateway URL (browser)", s.gateway_public_url)
            ns = st.text_input("MCP namespace", s.namespace)
            ctype = st.text_input("client_type (telemetry)", s.client_type)
            ro = st.toggle("Read-only mode", value=s.read_only)
            prov = st.selectbox(
                "LLM provider", ["openai", "anthropic", "none"],
                index=["openai", "anthropic", "none"].index(s.llm_provider)
                if s.llm_provider in {"openai", "anthropic", "none"} else 2,
            )
            model = st.text_input("LLM model", s.llm_model)
            mem = st.selectbox(
                "Memory backend", ["sqlite", "spanner"],
                index=["sqlite", "spanner"].index(s.memory_backend) if s.memory_backend in {"sqlite", "spanner"} else 0,
                help="sqlite = local file (no services). spanner = Cloud Spanner / local emulator.",
            )
            state.set_override(
                gateway_url=gw, gateway_public_url=pub, namespace=ns,
                client_type=ctype, read_only=ro, llm_provider=prov, llm_model=model,
                memory_backend=mem,
            )

        if state.is_connected():
            st.success("Connected to gateway")
            if st.button("Reset session / re-auth", width="stretch"):
                st.session_state.connected = False
                st.rerun()
        else:
            st.warning("Not connected")
            if st.button("🔐 Authorize with gateway", type="primary", width="stretch"):
                state.do_login()


# ── navigation ────────────────────────────────────────────────────────────────
def build_nav():
    return st.navigation(
        {
            "Command Center": [
                st.Page(command.home, title="Home", icon="🏠", default=True),
                st.Page(command.agent_chat, title="Ask JFrog Agent", icon="💬"),
                st.Page(insights.threads, title="Threads", icon="🧵"),
            ],
            "Operations": [
                st.Page(operations.artifact_explorer, title="Artifact Explorer", icon="🔎"),
                st.Page(operations.build_promotion, title="Build Promotion", icon="🚦"),
                st.Page(operations.cleanup, title="Cleanup Intelligence", icon="🧹"),
                st.Page(operations.troubleshooting, title="Troubleshooting", icon="🧰"),
            ],
            "Security": [
                st.Page(security.xray_security, title="Xray Security Center", icon="🛡️"),
                st.Page(security.policies, title="Policies & Watches", icon="📋"),
                st.Page(security.compliance, title="Compliance Reports", icon="📊"),
            ],
            "Governance": [
                st.Page(governance.approvals, title="Approvals", icon="✅"),
                st.Page(governance.audit_trail, title="Audit Trail", icon="🧾"),
                st.Page(governance.observability, title="Agent Observability", icon="📡"),
                st.Page(insights.llm_eval, title="LLM & Evaluation", icon="🧠"),
            ],
        }
    )


def main():
    state.try_connect()
    render_header()
    render_sidebar()
    build_nav().run()


if __name__ == "__main__":
    main()
