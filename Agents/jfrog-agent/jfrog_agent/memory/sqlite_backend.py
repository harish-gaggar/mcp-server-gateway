"""SQLite memory backend (default). Local file, no services required."""

from __future__ import annotations

import json
import sqlite3
import time
from typing import Any

from ..settings import Settings, settings as default_settings
from .backend import MemoryBackend


class SqliteBackend(MemoryBackend):
    def __init__(self, settings: Settings = default_settings):
        self.s = settings
        self.s.memory_db.parent.mkdir(parents=True, exist_ok=True)
        self.s.checkpoints_db.parent.mkdir(parents=True, exist_ok=True)
        self._ckpt = None
        self.init_schema()

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.s.memory_db))
        conn.row_factory = sqlite3.Row
        return conn

    def init_schema(self) -> None:
        with self._conn() as c:
            c.executescript(
                """
                CREATE TABLE IF NOT EXISTS threads (
                    thread_id TEXT PRIMARY KEY,
                    title TEXT, "user" TEXT,
                    created_at REAL, updated_at REAL
                );
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    thread_id TEXT, role TEXT, content TEXT,
                    meta TEXT, findings TEXT, ts REAL
                );
                CREATE TABLE IF NOT EXISTS llm_calls (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT, thread_id TEXT, purpose TEXT,
                    provider TEXT, model TEXT,
                    prompt_tokens INTEGER, completion_tokens INTEGER, total_tokens INTEGER,
                    latency_ms REAL, ok INTEGER, cost REAL, ts REAL
                );
                CREATE TABLE IF NOT EXISTS llm_feedback (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT, thread_id TEXT, rating INTEGER, note TEXT, ts REAL
                );
                CREATE INDEX IF NOT EXISTS ix_msg_thread ON messages(thread_id);
                """
            )

    # ── threads / messages ──────────────────────────────────────────────────
    def upsert_thread(self, thread_id: str, title: str, user: str | None) -> None:
        now = time.time()
        with self._conn() as c:
            row = c.execute("SELECT thread_id FROM threads WHERE thread_id=?", (thread_id,)).fetchone()
            if row:
                c.execute("UPDATE threads SET updated_at=?, title=COALESCE(NULLIF(?,''),title) WHERE thread_id=?", (now, title, thread_id))
            else:
                c.execute(
                    'INSERT INTO threads(thread_id,title,"user",created_at,updated_at) VALUES(?,?,?,?,?)',
                    (thread_id, title, user, now, now),
                )

    def list_threads(self, limit: int = 100) -> list[dict[str, Any]]:
        with self._conn() as c:
            rows = c.execute(
                "SELECT t.*, (SELECT COUNT(*) FROM messages m WHERE m.thread_id=t.thread_id) AS msg_count "
                "FROM threads t ORDER BY updated_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [dict(r) for r in rows]

    def get_thread(self, thread_id: str) -> dict[str, Any] | None:
        with self._conn() as c:
            r = c.execute("SELECT * FROM threads WHERE thread_id=?", (thread_id,)).fetchone()
            return dict(r) if r else None

    def add_message(self, thread_id: str, role: str, content: str, meta: dict, findings: list) -> None:
        with self._conn() as c:
            c.execute(
                "INSERT INTO messages(thread_id,role,content,meta,findings,ts) VALUES(?,?,?,?,?,?)",
                (thread_id, role, content, json.dumps(meta, default=str), json.dumps(findings, default=str), time.time()),
            )

    def get_messages(self, thread_id: str) -> list[dict[str, Any]]:
        with self._conn() as c:
            rows = c.execute("SELECT * FROM messages WHERE thread_id=? ORDER BY id", (thread_id,)).fetchall()
            out = []
            for r in rows:
                d = dict(r)
                d["meta"] = json.loads(d.get("meta") or "{}")
                d["findings"] = json.loads(d.get("findings") or "[]")
                out.append(d)
            return out

    def delete_thread(self, thread_id: str) -> None:
        with self._conn() as c:
            c.execute("DELETE FROM messages WHERE thread_id=?", (thread_id,))
            c.execute("DELETE FROM threads WHERE thread_id=?", (thread_id,))

    # ── LLM telemetry / eval ─────────────────────────────────────────────────
    def record_llm_call(self, **kw: Any) -> None:
        with self._conn() as c:
            c.execute(
                "INSERT INTO llm_calls(run_id,thread_id,purpose,provider,model,prompt_tokens,"
                "completion_tokens,total_tokens,latency_ms,ok,cost,ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    kw.get("run_id"), kw.get("thread_id"), kw.get("purpose"), kw.get("provider"),
                    kw.get("model"), kw.get("prompt_tokens", 0), kw.get("completion_tokens", 0),
                    kw.get("total_tokens", 0), kw.get("latency_ms", 0.0), int(bool(kw.get("ok", True))),
                    kw.get("cost", 0.0), time.time(),
                ),
            )

    def list_llm_calls(self, limit: int = 500) -> list[dict[str, Any]]:
        with self._conn() as c:
            rows = c.execute("SELECT * FROM llm_calls ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
            return [dict(r) for r in rows]

    def llm_summary(self) -> dict[str, Any]:
        with self._conn() as c:
            total = c.execute(
                "SELECT COUNT(*) n, COALESCE(SUM(total_tokens),0) tok, COALESCE(SUM(cost),0) cost, "
                "COALESCE(AVG(latency_ms),0) lat FROM llm_calls"
            ).fetchone()
            by_model = c.execute(
                "SELECT model, COUNT(*) calls, COALESCE(SUM(total_tokens),0) tokens, COALESCE(SUM(cost),0) cost, "
                "COALESCE(AVG(latency_ms),0) avg_latency_ms FROM llm_calls GROUP BY model ORDER BY tokens DESC"
            ).fetchall()
            return {
                "calls": total["n"], "tokens": total["tok"], "cost": total["cost"],
                "avg_latency_ms": total["lat"], "by_model": [dict(r) for r in by_model],
            }

    def record_feedback(self, run_id, thread_id, rating: int, note: str = "") -> None:
        with self._conn() as c:
            c.execute(
                "INSERT INTO llm_feedback(run_id,thread_id,rating,note,ts) VALUES(?,?,?,?,?)",
                (run_id, thread_id, rating, note, time.time()),
            )

    def feedback_summary(self) -> dict[str, Any]:
        with self._conn() as c:
            r = c.execute(
                "SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN rating>0 THEN 1 ELSE 0 END),0) up, "
                "COALESCE(SUM(CASE WHEN rating<0 THEN 1 ELSE 0 END),0) down FROM llm_feedback"
            ).fetchone()
            return {"total": r["n"], "up": r["up"], "down": r["down"]}

    # ── checkpointer ──────────────────────────────────────────────────────────
    def checkpointer(self):
        if self._ckpt is None:
            from langgraph.checkpoint.sqlite import SqliteSaver

            conn = sqlite3.connect(str(self.s.checkpoints_db), check_same_thread=False)
            saver = SqliteSaver(conn)
            saver.setup()
            self._ckpt = saver
        return self._ckpt
