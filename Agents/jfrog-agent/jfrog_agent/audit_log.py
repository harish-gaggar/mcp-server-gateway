"""Immutable audit trail.

Every run appends one JSON record capturing requester, intent, generated plan,
authorization decision, approvals, tool calls, results and verification. Secrets
are redacted before writing.
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any

from .security import redact_obj
from .settings import Settings, settings as default_settings


class AuditTrail:
    def __init__(self, run_id: str, settings: Settings = default_settings):
        self.run_id = run_id
        self.s = settings
        self.events: list[dict[str, Any]] = []
        self._path: Path | None = None

    def record(self, kind: str, payload: dict[str, Any]) -> None:
        self.events.append(
            {
                "ts": time.time(),
                "kind": kind,
                "payload": redact_obj(payload),
            }
        )

    def finalize(self, user: str | None, request: str, outcome: str) -> Path:
        self.s.audit_dir.mkdir(parents=True, exist_ok=True)
        record = {
            "run_id": self.run_id,
            "user": user,
            "request": request,
            "outcome": outcome,
            "client_type": self.s.client_type,
            "client_name": self.s.client_name,
            "created_at": time.time(),
            "events": self.events,
        }
        # append-only: one file per run keeps records tamper-evident and simple.
        self._path = self.s.audit_dir / f"{self.run_id}.json"
        self._path.write_text(json.dumps(redact_obj(record), indent=2))
        return self._path

    @property
    def path(self) -> Path | None:
        return self._path


def new_run_id() -> str:
    return f"run-{uuid.uuid4().hex[:12]}"
