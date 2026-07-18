#!/usr/bin/env python3
"""JFrog operations copilot — CLI entrypoint.

Examples:
    python run.py --login
    python run.py --list-tools
    python run.py "Which local repositories exist?"
    python run.py "Show npm packages not downloaded for 180 days"
    python run.py "How much storage are we using?"
"""

from __future__ import annotations

import argparse
import sys

from jfrog_agent.audit_log import AuditTrail, new_run_id
from jfrog_agent.graph import build_graph
from jfrog_agent.mcp_client import AuthError, GatewayMCPClient
from jfrog_agent.observability import maybe_setup_tracing
from jfrog_agent.settings import settings

try:
    from langgraph.types import Command
except Exception:  # pragma: no cover
    Command = None


def _print_banner():
    print("=" * 68)
    print(" JFrog Operations Copilot (LangGraph, per-user OAuth via MCP gateway)")
    print(f"   gateway : {settings.gateway_url}  ns={settings.namespace}")
    print(f"   client  : {settings.client_name}  type={settings.client_type}")
    print(f"   mode    : {'READ-ONLY' if settings.read_only else 'read+write'}")
    print("=" * 68)


def cmd_login(client: GatewayMCPClient) -> int:
    client.authenticate(force=True)
    print("Authenticated. Token cached at:", settings.token_cache)
    return 0


def cmd_list_tools(client: GatewayMCPClient) -> int:
    client.connect()
    tools = client.list_tools()
    print(f"Upstream MCP exposes {len(tools)} tool(s):")
    for t in tools:
        print(f"  - {t.get('name')}: {t.get('description', '')[:80]}")
    return 0


def cmd_ask(client: GatewayMCPClient, request: str, user: str | None) -> int:
    run_id = new_run_id()
    audit = AuditTrail(run_id, settings)
    graph = build_graph(client, audit, settings)
    config = {"configurable": {"thread_id": run_id}}

    # ensure the MCP session is live before the graph starts calling tools
    client.connect()

    state = {"request": request, "user": user, "run_id": run_id}
    result = graph.invoke(state, config)

    # Handle a human-approval interrupt, if any.
    while "__interrupt__" in result or _pending_interrupt(graph, config):
        payload = _interrupt_payload(result, graph, config)
        print("\n─── APPROVAL REQUIRED ───────────────────────────────────────")
        for k, v in payload.items():
            if k != "type":
                print(f"  {k}: {v}")
        if Command is None:
            print("langgraph Command unavailable; auto-rejecting.")
            result = graph.invoke(Command(resume="reject"), config) if Command else result
            break
        choice = input("Approve this operation? [approve/reject]: ").strip().lower() or "reject"
        result = graph.invoke(Command(resume=choice), config)

    print("\n─── ANSWER ──────────────────────────────────────────────────")
    print(result.get("answer", "(no answer)"))
    print("\noutcome:", result.get("outcome"))
    print("audit  :", result.get("audit_path"))
    return 0


def _pending_interrupt(graph, config) -> bool:
    try:
        snapshot = graph.get_state(config)
        return bool(snapshot.next) and "approval" in snapshot.next
    except Exception:
        return False


def _interrupt_payload(result, graph, config) -> dict:
    intr = result.get("__interrupt__")
    if intr:
        item = intr[0] if isinstance(intr, (list, tuple)) else intr
        return getattr(item, "value", item) if not isinstance(item, dict) else item
    try:
        snapshot = graph.get_state(config)
        tasks = getattr(snapshot, "tasks", [])
        for task in tasks:
            for it in getattr(task, "interrupts", []) or []:
                return getattr(it, "value", {}) or {}
    except Exception:
        pass
    return {"operation": "unknown"}


def main() -> int:
    parser = argparse.ArgumentParser(description="JFrog operations copilot")
    parser.add_argument("request", nargs="*", help="natural-language request")
    parser.add_argument("--login", action="store_true", help="run one-time OAuth and cache the token")
    parser.add_argument("--list-tools", action="store_true", help="list upstream MCP tools")
    parser.add_argument("--user", default=None, help="requester identity for the audit record")
    parser.add_argument("--quiet", action="store_true", help="suppress MCP client logs")
    args = parser.parse_args()

    _print_banner()
    maybe_setup_tracing(settings)
    client = GatewayMCPClient(settings, verbose=not args.quiet)

    try:
        if args.login:
            return cmd_login(client)
        if args.list_tools:
            return cmd_list_tools(client)
        if not args.request:
            parser.print_help()
            return 1
        return cmd_ask(client, " ".join(args.request), args.user)
    except AuthError as e:
        print(f"\nAuthentication error: {e}", file=sys.stderr)
        print("Tip: run `python run.py --login` to (re)authorize.", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
