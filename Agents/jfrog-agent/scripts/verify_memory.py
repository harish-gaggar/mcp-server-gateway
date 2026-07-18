"""Verify durable agent memory + LLM telemetry for the active backend.

Usage:
    python scripts/verify_memory.py                 # sqlite (default)
    JFROG_AGENT_MEMORY_BACKEND=spanner \
      SPANNER_EMULATOR_HOST=localhost:9010 \
      python scripts/verify_memory.py               # spanner emulator

It proves:
  1. threads/messages/LLM-calls/feedback persist and read back,
  2. data survives a "restart" (a brand-new backend instance sees prior data),
  3. LangGraph checkpoints are durable: an interrupted graph resumes from a
     fresh checkpointer instance (simulating tomorrow's session).
"""

from __future__ import annotations

import dataclasses
import sys
import uuid
from typing import TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

from jfrog_agent.memory import get_backend
from jfrog_agent.settings import settings as base


def _fresh_settings():
    # keep sqlite tests isolated from the user's real db
    if base.memory_backend != "spanner":
        import tempfile
        from pathlib import Path

        d = Path(tempfile.gettempdir()) / f"jfrog-verify-{uuid.uuid4().hex[:8]}"
        d.mkdir(parents=True, exist_ok=True)
        return dataclasses.replace(base, memory_db=d / "memory.db", checkpoints_db=d / "ckpt.db")
    return base


OK = "\033[92m✓\033[0m"
FAIL = "\033[91m✗\033[0m"


def check(name: str, cond: bool):
    print(f"  {OK if cond else FAIL} {name}")
    if not cond:
        raise SystemExit(f"FAILED: {name}")


def test_threads(settings):
    print(f"\n[1] threads/messages/telemetry round-trip  (backend={settings.memory_backend})")
    b = get_backend(settings)
    tid = "conv-" + uuid.uuid4().hex[:10]
    b.upsert_thread(tid, "How many repos do we have?", "verify-user")
    b.add_message(tid, "user", "How many repos do we have?", {}, [])
    b.add_message(tid, "assistant", "You have 2 repositories.", {"outcome": "completed", "run_id": "run-1"}, [{"tool": "list_repositories"}])
    b.record_llm_call(run_id="run-1", thread_id=tid, purpose="plan", provider="openai", model="gpt-4o",
                      prompt_tokens=120, completion_tokens=40, total_tokens=160, latency_ms=812.0, ok=True, cost=0.0007)
    b.record_llm_call(run_id="run-1", thread_id=tid, purpose="summarize", provider="openai", model="gpt-4o",
                      prompt_tokens=300, completion_tokens=90, total_tokens=390, latency_ms=640.0, ok=True, cost=0.0016)
    b.record_feedback("run-1", tid, 1, "great")

    # simulate a RESTART: brand new backend instance, same store
    b2 = get_backend(settings)
    threads = b2.list_threads(50)
    check("thread persisted after restart", any(t["thread_id"] == tid for t in threads))
    msgs = b2.get_messages(tid)
    check("2 messages persisted", len(msgs) == 2)
    check("assistant findings persisted", msgs[1]["findings"][0]["tool"] == "list_repositories")
    summ = b2.llm_summary()
    check("llm token total >= 550", summ["tokens"] >= 550)
    check("llm cost tracked", summ["cost"] > 0)
    check("by-model has gpt-4o", any(m["model"] == "gpt-4o" for m in summ["by_model"]))
    fb = b2.feedback_summary()
    check("feedback up counted", fb["up"] == 1)
    return tid


class _S(TypedDict):
    count: int
    note: str


def _build(checkpointer):
    def step1(s: _S):
        decision = interrupt({"operation": "delete", "risk": "high"})
        return {"count": s["count"] + 1, "note": f"decided:{decision}"}

    def step2(s: _S):
        return {"note": s["note"] + "|done"}

    g = StateGraph(_S)
    g.add_node("step1", step1)
    g.add_node("step2", step2)
    g.add_edge(START, "step1")
    g.add_edge("step1", "step2")
    g.add_edge("step2", END)
    return g.compile(checkpointer=checkpointer)


def test_checkpoint_resume(settings):
    print("\n[2] durable LangGraph checkpoint resume across a simulated restart")
    thread_id = "run-" + uuid.uuid4().hex[:10]
    config = {"configurable": {"thread_id": thread_id}}

    # session 1: run until interrupt, then "shut down"
    b1 = get_backend(settings)
    graph1 = _build(b1.checkpointer())
    res1 = graph1.invoke({"count": 0, "note": ""}, config)
    check("graph interrupted (awaiting approval)", "__interrupt__" in res1)

    # session 2 (tomorrow): fresh backend + fresh graph, resume from durable store
    b2 = get_backend(settings)
    graph2 = _build(b2.checkpointer())
    snap = graph2.get_state(config)
    check("checkpoint recovered after restart", bool(snap.next) and "step1" in snap.next)
    res2 = graph2.invoke(Command(resume="approve"), config)
    check("resumed and completed", res2.get("count") == 1)
    check("resume decision persisted", res2.get("note") == "decided:approve|done")


def main():
    settings = _fresh_settings()
    print(f"Backend: {settings.memory_backend}")
    if settings.memory_backend == "spanner":
        print(f"Spanner: {settings.spanner_project}/{settings.spanner_instance}/{settings.spanner_database} "
              f"emulator={settings.spanner_emulator_host}")
    test_threads(settings)
    test_checkpoint_resume(settings)
    print(f"\n{OK} ALL MEMORY CHECKS PASSED ({settings.memory_backend})")


if __name__ == "__main__":
    sys.exit(main())
