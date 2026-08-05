"""Negative and positive tests for the server-side safe AQL builder.

These run directly against the MCP server's own boundary
(``artifactory/safe_aql.py``), not the agent, proving that any caller reaching
the server -- including IDE assistants and direct MCP clients -- is bounded.

Run from the ``artifactory/`` directory:

    pip install -r requirements-dev.txt
    pytest -q
"""

import json
import os
import sys

import pytest

# Make ``safe_aql`` importable when running pytest from anywhere.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from safe_aql import build_search_aql, SafeAQLError, max_results  # noqa: E402

ALLOW = ["libs-release", "docker-local"]


def _find_clause(query: str) -> dict:
    """Extract and parse the JSON passed to items.find(...)."""
    assert query.startswith("items.find(")
    inner = query[len("items.find(") : query.index(").include(")]
    return json.loads(inner)


# --- Positive test ---------------------------------------------------------

def test_valid_search_is_bounded_and_read_only():
    q = build_search_aql(
        name="log4j*", repo="libs-release", allowed_repos=ALLOW, cap=200
    )
    assert q.startswith("items.find(")
    assert ".limit(200)" in q          # bounded
    assert ".include(" in q            # explicit field list
    # Read-only by construction: only find/include/sort/limit, no mutation verbs.
    for verb in (".set(", ".delete(", ".update(", ".move(", ".copy("):
        assert verb not in q
    # Denied output fields never appear.
    for denied in ("sha256", "actual_sha1", "md5"):
        assert denied not in q


# --- Quote and wildcard manipulation --------------------------------------

@pytest.mark.parametrize(
    "malicious_name",
    [
        '*"}]},{"repo":{"$match":"*"}}',   # break out of the JSON string
        'log4j","$or":[{"name":"*"}',       # inject an extra clause
        'a" }) .delete() //',                # attempt a trailing mutation
        "name with spaces",                  # whitespace is not a valid name
    ],
)
def test_quote_and_structure_injection_rejected(malicious_name):
    with pytest.raises(SafeAQLError):
        build_search_aql(name=malicious_name, allowed_repos=ALLOW, cap=200)


# --- Raw AQL / unsupported fields -----------------------------------------

def test_raw_aql_as_name_is_rejected():
    with pytest.raises(SafeAQLError):
        build_search_aql(
            name='items.find({"repo":"secret"})', allowed_repos=ALLOW, cap=200
        )


def test_unsupported_field_probe_in_repo_rejected():
    # Trying to smuggle a field/operator through the repo argument.
    with pytest.raises(SafeAQLError):
        build_search_aql(
            repo='libs-release","path":{"$match":"*"', allowed_repos=ALLOW, cap=200
        )


# --- Repository allowlist bypass ------------------------------------------

def test_repository_allowlist_bypass_rejected():
    with pytest.raises(SafeAQLError) as exc:
        build_search_aql(repo="secret-repo", allowed_repos=ALLOW, cap=200)
    assert "allowlist" in str(exc.value)


def test_empty_repo_with_allowlist_scopes_to_allowlist():
    q = build_search_aql(name="*", allowed_repos=ALLOW, cap=200)
    clause = _find_clause(q)
    # The query must be scoped to the allowed repos, not every repository.
    text = json.dumps(clause)
    assert "libs-release" in text and "docker-local" in text


# --- Extremely large requested limits -------------------------------------

def test_huge_limit_is_clamped_to_cap():
    q = build_search_aql(name="*", allowed_repos=ALLOW, cap=200, limit=100000)
    assert ".limit(200)" in q
    assert ".limit(100000)" not in q


def test_non_positive_limit_rejected():
    with pytest.raises(SafeAQLError):
        build_search_aql(name="*", allowed_repos=ALLOW, cap=200, limit=0)
    with pytest.raises(SafeAQLError):
        build_search_aql(name="*", allowed_repos=ALLOW, cap=200, limit=-5)


# --- Empty filters that would search everything ---------------------------

def test_empty_filters_are_bounded_without_allowlist():
    q = build_search_aql(allowed_repos=[], cap=50)
    # No allowlist, no name: still a valid, capped, match-all query.
    assert '"name": {"$match": "*"}' in q or '"$match": "*"' in q
    assert ".limit(50)" in q


# --- Configured hard ceiling ----------------------------------------------

def test_env_cap_cannot_exceed_hard_ceiling(monkeypatch):
    monkeypatch.setenv("ARTIFACTORY_MAX_RESULTS", "999999")
    assert max_results() == 1000  # clamped to the built-in ceiling
    q = build_search_aql(name="*", allowed_repos=ALLOW)
    assert ".limit(1000)" in q
