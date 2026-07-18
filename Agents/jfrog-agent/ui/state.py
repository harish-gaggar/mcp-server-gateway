"""Shared UI state: settings, gateway client lifecycle, auth, agent execution."""

from __future__ import annotations

import dataclasses
import glob
import json
import os
import uuid
from pathlib import Path

import streamlit as st

from jfrog_agent import telemetry
from jfrog_agent.audit_log import AuditTrail, new_run_id
from jfrog_agent.graph import build_graph
from jfrog_agent.mcp_client import AuthError, GatewayMCPClient, MCPError
from jfrog_agent.memory import get_backend as _memory_get_backend
from jfrog_agent.settings import settings as base_settings

try:
    from langgraph.types import Command
except Exception:  # pragma: no cover
    Command = None


# ── settings ──────────────────────────────────────────────────────────────────
def effective_settings():
    """Settings with any sidebar overrides applied (stored in session_state)."""
    o = st.session_state.get("overrides", {})
    return dataclasses.replace(base_settings, **o) if o else base_settings


def set_override(**kwargs):
    o = dict(st.session_state.get("overrides", {}))
    o.update(kwargs)
    st.session_state.overrides = o


def _sig(s) -> str:
    return f"{s.gateway_url}|{s.gateway_public_url}|{s.namespace}|{s.client_type}"


# ── client / connection ───────────────────────────────────────────────────────
def get_client() -> GatewayMCPClient:
    s = effective_settings()
    if st.session_state.get("client_sig") != _sig(s):
        old = st.session_state.get("client")
        if old is not None:
            old.close()
        st.session_state.client = GatewayMCPClient(s, verbose=False)
        st.session_state.client_sig = _sig(s)
        st.session_state.connected = False
    return st.session_state.client


def try_connect() -> bool:
    if st.session_state.get("connected"):
        return True
    client = get_client()
    try:
        if client.has_valid_token():
            client.connect()
            st.session_state.connected = True
            return True
    except (AuthError, MCPError, Exception):
        st.session_state.connected = False
    return False


def do_login():
    client = get_client()
    link = st.empty()

    def show_url(url: str):
        link.markdown(
            f"### [Click here to authorize in your browser →]({url})\n"
            "After approving, this page finishes connecting automatically."
        )

    with st.status("Waiting for browser authorization…", expanded=True):
        try:
            client.authenticate(force=True, open_browser=False, url_callback=show_url)
            client.connect()
            st.session_state.connected = True
            link.empty()
            st.success("Authenticated and connected.")
            st.rerun()
        except AuthError as e:
            st.error(f"Authentication failed: {e}")


def is_connected() -> bool:
    return bool(st.session_state.get("connected"))


# ── durable memory backend ────────────────────────────────────────────────────
def get_backend():
    s = effective_settings()
    sig = f"{s.memory_backend}|{s.memory_db}|{s.spanner_emulator_host}|{s.spanner_database}"
    if st.session_state.get("backend_sig") != sig:
        try:
            backend = _memory_get_backend(s)
            telemetry.set_sink(backend)
            st.session_state.backend = backend
            st.session_state.backend_sig = sig
            st.session_state.backend_error = None
        except Exception as e:  # noqa: BLE001
            st.session_state.backend = None
            st.session_state.backend_error = str(e)
    return st.session_state.get("backend")


def current_thread_id() -> str:
    if not st.session_state.get("thread_id"):
        st.session_state.thread_id = "conv-" + uuid.uuid4().hex[:12]
    return st.session_state.thread_id


def new_thread():
    st.session_state.thread_id = "conv-" + uuid.uuid4().hex[:12]
    st.session_state.chat = []
    st.session_state.pending = None
    st.session_state.last_meta = {}


def load_thread(thread_id: str):
    backend = get_backend()
    st.session_state.thread_id = thread_id
    st.session_state.pending = None
    st.session_state.chat = []
    if backend:
        for m in backend.get_messages(thread_id):
            st.session_state.chat.append(
                {"role": m["role"], "content": m["content"], "meta": m.get("meta", {}), "findings": m.get("findings", [])}
            )
    st.session_state.last_meta = st.session_state.chat[-1].get("meta", {}) if st.session_state.chat else {}


def save_message(role: str, content: str, meta: dict | None = None, findings: list | None = None):
    backend = get_backend()
    if not backend:
        return
    tid = current_thread_id()
    title = content[:60] if role == "user" else ""
    try:
        backend.upsert_thread(tid, title, st.session_state.get("user"))
        backend.add_message(tid, role, content, meta or {}, findings or [])
    except Exception:
        pass


# ── agent execution ───────────────────────────────────────────────────────────
def run_agent(request: str):
    """Run the LangGraph agent. Returns (result, graph, config, audit)."""
    s = effective_settings()
    client = get_client()
    backend = get_backend()
    run_id = new_run_id()
    thread_id = current_thread_id()
    telemetry.set_context(run_id=run_id, thread_id=thread_id)
    audit = AuditTrail(run_id, s)
    checkpointer = backend.checkpointer() if backend else None
    graph = build_graph(client, audit, s, checkpointer=checkpointer)
    # each message is an independent graph run -> unique checkpoint thread_id
    config = {"configurable": {"thread_id": run_id}}
    result = graph.invoke(
        {"request": request, "user": st.session_state.get("user"), "run_id": run_id}, config
    )
    return result, graph, config, audit


def resume_agent(graph, config, decision: str):
    if Command is None:
        return {}
    return graph.invoke(Command(resume=decision), config)


def interrupt_payload(result, graph, config):
    intr = result.get("__interrupt__")
    if intr:
        item = intr[0] if isinstance(intr, (list, tuple)) else intr
        return getattr(item, "value", item) if not isinstance(item, dict) else item
    try:
        snap = graph.get_state(config)
        if snap.next and "approval" in snap.next:
            for task in getattr(snap, "tasks", []):
                for it in getattr(task, "interrupts", []) or []:
                    return getattr(it, "value", {}) or {"operation": "unknown"}
    except Exception:
        pass
    return None


# ── audit trail (real, from disk) ─────────────────────────────────────────────
def load_audit_records(limit: int = 200) -> list[dict]:
    s = effective_settings()
    d = s.audit_dir
    if not Path(d).exists():
        return []
    files = sorted(glob.glob(os.path.join(str(d), "*.json")), key=os.path.getmtime, reverse=True)
    out = []
    for f in files[:limit]:
        try:
            out.append(json.loads(Path(f).read_text()))
        except Exception:
            continue
    return out
