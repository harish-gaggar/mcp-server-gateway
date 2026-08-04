"""Server-side safe AQL construction for the Artifactory MCP server.

Every caller of the ``search_artifacts`` tool -- LangGraph agents, IDE
assistants (Cursor, Claude Desktop), scripts, and direct MCP clients -- goes
through this builder. It is the single, server-owned boundary that guarantees
each search is:

  * restricted to the ``items`` domain,
  * scoped to an optional repository allowlist,
  * free of raw AQL / quote / brace injection,
  * bounded by a hard result cap and read-only by construction,
  * stripped of denied output fields (checksums).

The builder NEVER accepts a raw AQL string. It accepts a small set of typed,
validated arguments and emits the final AQL with ``json.dumps``, so caller
input is always a JSON string literal and can never change the query's
structure. Because this lives in the MCP server rather than in one agent, a
client that bypasses the agent and calls the server directly still receives the
same guarantees.
"""

from __future__ import annotations

import json
import os
import re
from typing import Optional

# Only the items domain is exposed by this tool.
_ALLOWED_DOMAIN = "items"

# Output fields the tool returns. Sensitive fields (checksums) are never
# included, even if a caller could somehow request them.
_DEFAULT_INCLUDE_FIELDS = [
    "name",
    "repo",
    "path",
    "type",
    "size",
    "created",
    "modified",
    "stat.downloaded",
]
_DENIED_OUTPUT_FIELDS = {"actual_sha1", "sha1", "sha256", "md5", "original_sha1"}

# Conservative patterns for artifact names and repository keys. Real Artifactory
# names use letters, digits, and . _ - / plus the * and ? wildcards. Anything
# else (quotes, braces, colons, commas, whitespace, control characters) is an
# attempt to break out of the JSON string literal or inject AQL structure, and
# is rejected before a query is built.
_NAME_RE = re.compile(r"^[A-Za-z0-9._\-/*?]+$")
_REPO_RE = re.compile(r"^[A-Za-z0-9._\-]+$")

_MAX_NAME_LEN = 200
_DEFAULT_MAX_RESULTS = 100
# Even an operator misconfiguration cannot raise the cap above this ceiling.
_HARD_CEILING = 1000


class SafeAQLError(ValueError):
    """Raised when arguments cannot be turned into a safe, bounded query."""


def repo_allowlist() -> list[str]:
    """Repositories the tool may search, from ``ARTIFACTORY_REPO_ALLOWLIST``
    (comma-separated). An empty value means no allowlist is configured: searches
    are still bounded by the hard result cap, but are not restricted by
    repository."""
    raw = os.getenv("ARTIFACTORY_REPO_ALLOWLIST", "")
    return [r.strip() for r in raw.split(",") if r.strip()]


def max_results() -> int:
    """The hard result cap from ``ARTIFACTORY_MAX_RESULTS``, clamped to the
    built-in ceiling so configuration can lower it but never remove it."""
    try:
        configured = int(
            os.getenv("ARTIFACTORY_MAX_RESULTS", str(_DEFAULT_MAX_RESULTS))
        )
    except ValueError:
        configured = _DEFAULT_MAX_RESULTS
    return max(1, min(configured, _HARD_CEILING))


def _validate_name(name: str) -> str:
    name = name.strip()
    if not name:
        raise SafeAQLError("name pattern is empty")
    if len(name) > _MAX_NAME_LEN:
        raise SafeAQLError(
            f"name pattern is too long (max {_MAX_NAME_LEN} characters)"
        )
    if not _NAME_RE.match(name):
        raise SafeAQLError(
            "name pattern contains unsupported characters; only letters, "
            "digits, and . _ - / * ? are allowed"
        )
    return name


def _validate_repo(repo: str, allowed: list[str]) -> str:
    repo = repo.strip()
    if not _REPO_RE.match(repo):
        raise SafeAQLError(
            "repository name contains unsupported characters; only letters, "
            "digits, and . _ - are allowed"
        )
    if allowed and repo not in allowed:
        raise SafeAQLError(f"repository '{repo}' is not in the allowlist")
    return repo


def build_search_aql(
    name: Optional[str] = None,
    repo: Optional[str] = None,
    limit: Optional[int] = None,
    *,
    allowed_repos: Optional[list[str]] = None,
    cap: Optional[int] = None,
) -> str:
    """Return a safe, bounded AQL ``items.find(...)`` query string.

    Raises :class:`SafeAQLError` for any input that would broaden the query
    beyond the tool's contract: raw AQL, quote/brace injection, a repository
    outside the allowlist, or a non-positive limit. Caller values are only ever
    embedded via ``json.dumps`` as string literals, so they cannot alter the
    query's structure.
    """
    allowed = repo_allowlist() if allowed_repos is None else allowed_repos
    ceiling = max_results() if cap is None else max(1, min(cap, _HARD_CEILING))

    conditions: list[dict] = []

    if repo:
        repo = _validate_repo(repo, allowed)
        conditions.append({"repo": {"$eq": repo}})
    elif allowed:
        # No repository requested but an allowlist exists: scope to it, never to
        # every repository on the instance.
        conditions.append({"$or": [{"repo": {"$eq": r}} for r in allowed]})

    if name:
        name = _validate_name(name)
        conditions.append({"name": {"$match": name}})
    elif not conditions:
        # Empty filters would otherwise match every item. Bound the query with a
        # match-all name so it is valid, and rely on the hard limit below.
        conditions.append({"name": {"$match": "*"}})

    find_clause: dict = {"$and": conditions} if len(conditions) > 1 else conditions[0]

    include = [f for f in _DEFAULT_INCLUDE_FIELDS if f not in _DENIED_OUTPUT_FIELDS]

    requested = ceiling if limit is None else limit
    if not isinstance(requested, int) or isinstance(requested, bool) or requested < 1:
        raise SafeAQLError("limit must be a positive integer")
    effective = min(requested, ceiling)

    query = (
        f"items.find({json.dumps(find_clause)})"
        f".include({', '.join(json.dumps(f) for f in include)})"
        f".sort({{\"$desc\": [\"created\"]}})"
        f".limit({effective})"
    )
    return query
