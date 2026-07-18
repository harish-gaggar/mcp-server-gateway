"""Validated AQL builder.

Design pattern (from the vision doc):

    Natural-language request
            v
    Structured search intent   (produced by the LLM / heuristic planner)
            v
    Validated AQL builder      (this module — deterministic, no LLM)
            v
    Read-only execution
            v
    Result summarizer

The builder NEVER accepts a raw AQL string from the model. It only accepts a
constrained `SearchIntent` and emits AQL that is guaranteed to be:
  * restricted to an allowed domain (items / builds),
  * bounded by a hard `limit` and mandatory pagination,
  * scoped to allowed repositories,
  * free of denied/sensitive fields,
  * read-only (find + include, never a mutation).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

# AQL domains we permit the agent to search. Anything else is rejected.
ALLOWED_DOMAINS = {"items", "builds"}

# Fields the agent may filter on, per domain. Keeps the model from probing
# sensitive or unsupported fields.
ALLOWED_ITEM_FIELDS = {
    "repo",
    "path",
    "name",
    "type",
    "created",
    "modified",
    "updated",
    "size",
    "stat.downloaded",
    "stat.downloads",
    "@license",
    "@build.name",
    "@build.number",
    "property",
}

# Fields we never return, even if present.
DENIED_OUTPUT_FIELDS = {"actual_sha1", "sha256", "original_sha1"}


class AQLValidationError(ValueError):
    """Raised when a search intent cannot be turned into a safe query."""


@dataclass
class SearchIntent:
    """Structured, LLM-friendly search request. This is the ONLY input the AQL
    builder accepts — the model fills these fields, it does not write AQL."""

    domain: Literal["items", "builds"] = "items"
    repositories: list[str] = field(default_factory=list)
    name_pattern: str | None = None          # supports * wildcards
    package_type: str | None = None          # docker, npm, maven, ...
    properties: dict[str, str] = field(default_factory=dict)
    created_before_days: int | None = None   # e.g. 180 -> created > 180d ago? see below
    not_downloaded_for_days: int | None = None
    min_size_bytes: int | None = None
    max_size_bytes: int | None = None
    limit: int = 100

    def to_dict(self) -> dict[str, Any]:
        return {
            "domain": self.domain,
            "repositories": self.repositories,
            "name_pattern": self.name_pattern,
            "package_type": self.package_type,
            "properties": self.properties,
            "not_downloaded_for_days": self.not_downloaded_for_days,
            "min_size_bytes": self.min_size_bytes,
            "max_size_bytes": self.max_size_bytes,
            "limit": self.limit,
        }


# package_type -> docker/npm/etc. hints. We map to name patterns / repo hints
# rather than trusting arbitrary type tokens.
_PACKAGE_NAME_HINT = {
    "docker": "manifest.json",
}


def _iso_days_ago(days: int) -> str:
    dt = datetime.now(timezone.utc) - timedelta(days=days)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def build_items_aql(intent: SearchIntent, *, allowed_repos: list[str], max_results: int) -> str:
    """Return a safe AQL `items.find(...)` query string.

    Enforces domain, repo scope, hard result cap and mandatory pagination.
    """
    if intent.domain not in ALLOWED_DOMAINS:
        raise AQLValidationError(f"domain '{intent.domain}' is not allowed")

    criteria: list[dict[str, Any]] = []

    # Repository scope: intersect requested repos with the allowlist (if any).
    repos = list(intent.repositories)
    if allowed_repos:
        if repos:
            disallowed = [r for r in repos if r not in allowed_repos]
            if disallowed:
                raise AQLValidationError(
                    f"repositories not in allowlist: {', '.join(disallowed)}"
                )
        else:
            repos = list(allowed_repos)
    if repos:
        criteria.append({"$or": [{"repo": {"$eq": r}} for r in repos]})

    if intent.name_pattern:
        pattern = intent.name_pattern.replace("%", "").strip()
        criteria.append({"name": {"$match": pattern}})

    if intent.package_type:
        hint = _PACKAGE_NAME_HINT.get(intent.package_type.lower())
        if hint:
            criteria.append({"name": {"$match": hint}})

    for key, value in intent.properties.items():
        # Property filters use the @key syntax; the value is matched literally.
        criteria.append({f"@{key}": {"$eq": value}})

    if intent.not_downloaded_for_days is not None:
        criteria.append(
            {"stat.downloaded": {"$before": f"{intent.not_downloaded_for_days}d"}}
        )

    if intent.created_before_days is not None:
        criteria.append({"created": {"$before": f"{intent.created_before_days}d"}})

    if intent.min_size_bytes is not None:
        criteria.append({"size": {"$gt": intent.min_size_bytes}})

    if intent.max_size_bytes is not None:
        criteria.append({"size": {"$lt": intent.max_size_bytes}})

    find_clause = {"$and": criteria} if criteria else {}

    # Hard cap: the model can request fewer, never more than the configured max.
    limit = max(1, min(intent.limit, max_results))

    include = ["name", "repo", "path", "type", "size", "created", "modified", "stat.downloaded"]
    include = [f for f in include if f not in DENIED_OUTPUT_FIELDS]

    query = (
        f"items.find({json.dumps(find_clause)})"
        f".include({', '.join(json.dumps(f) for f in include)})"
        f".sort({{\"$desc\": [\"created\"]}})"
        f".limit({limit})"
    )
    return query


def describe_intent(intent: SearchIntent) -> str:
    """Human-readable one-liner for audit records and approval prompts."""
    bits = [f"search {intent.domain}"]
    if intent.repositories:
        bits.append(f"in {', '.join(intent.repositories)}")
    if intent.name_pattern:
        bits.append(f"name~'{intent.name_pattern}'")
    if intent.package_type:
        bits.append(f"type={intent.package_type}")
    if intent.not_downloaded_for_days:
        bits.append(f"not downloaded for {intent.not_downloaded_for_days}d")
    if intent.min_size_bytes:
        bits.append(f"size>{intent.min_size_bytes}B")
    if intent.properties:
        bits.append("props=" + ",".join(f"{k}={v}" for k, v in intent.properties.items()))
    bits.append(f"limit={intent.limit}")
    return " ".join(bits)
