"""Representative sample data for cockpit pages whose upstream APIs (Xray, build
promotion, cleanup) are not yet exposed by the Artifactory MCP server.

Everything here is clearly labeled as preview in the UI. Live pages (Home KPIs
that can be computed, Artifact Explorer, Audit) use real data instead.
"""

from __future__ import annotations

HOME_KPIS = [
    {"label": "Critical Xray Issues", "value": "37", "delta": "+4 since yesterday", "direction": "up"},
    {"label": "Blocked Builds", "value": "8", "delta": "-2 this week", "direction": "down"},
    {"label": "Artifacts at Risk", "value": "142", "delta": "+11 this week", "direction": "up"},
    {"label": "Pending Approvals", "value": "5", "delta": "2 high risk", "direction": "flat"},
    {"label": "Storage Reclaimable", "value": "2.4 TB", "delta": "+0.3 TB", "direction": "flat"},
    {"label": "Watch Coverage", "value": "91%", "delta": "+3%", "direction": "down"},
]

SEVERITY_POSTURE = {"Critical": 37, "High": 84, "Medium": 210, "Low": 356}

RECENT_INVESTIGATIONS = [
    {
        "title": "CVE-2026-12345 Impact Analysis",
        "when": "Completed 8 minutes ago",
        "facts": ["18 artifacts affected", "4 production applications affected", "Recommended action available"],
    },
    {
        "title": "Storage reclamation dry-run — docker-dev-local",
        "when": "Completed 26 minutes ago",
        "facts": ["2,418 candidates", "620 GB reclaimable", "Manifest ready for approval"],
    },
    {
        "title": "Build readiness — payment-service/319",
        "when": "Completed 1 hour ago",
        "facts": ["Readiness 86/100", "2 high vulnerabilities", "Promotion gated on approval"],
    },
]

RECOMMENDED_ACTIONS = [
    {"text": "7 production repositories are not covered by an Xray Watch", "risk": "HIGH"},
    {"text": "12 critical violations have fixes available", "risk": "CRITICAL"},
    {"text": "428 GB can be safely reclaimed", "risk": "LOW"},
    {"text": "3 builds are ready for promotion", "risk": "PENDING"},
]

VULNERABILITIES = [
    {"CVE": "CVE-2026-1234", "Severity": "Critical", "Component": "openssl 3.1.2", "Fixed Version": "3.1.7", "Artifacts": 18, "Production Impact": 5},
    {"CVE": "CVE-2026-9821", "Severity": "High", "Component": "lodash 4.17.15", "Fixed Version": "4.17.21", "Artifacts": 31, "Production Impact": 8},
    {"CVE": "CVE-2026-4410", "Severity": "High", "Component": "log4j-core 2.14.1", "Fixed Version": "2.17.1", "Artifacts": 12, "Production Impact": 3},
    {"CVE": "CVE-2026-7782", "Severity": "Medium", "Component": "requests 2.25.1", "Fixed Version": "2.31.0", "Artifacts": 44, "Production Impact": 2},
]

CVE_DETAIL = {
    "CVE-2026-1234": {
        "summary": "Heap buffer overflow in OpenSSL certificate parsing.",
        "exploitability": "High — public PoC available",
        "affected_versions": "3.0.0 – 3.1.6",
        "fixed_versions": "3.1.7",
        "policies": ["production-container-security", "critical-blocking"],
        "repositories": ["docker-prod-local", "docker-stage-local", "libs-release-local"],
        "builds": ["payment-service/319", "checkout-api/205", "auth-core/481"],
        "owners": ["Payments", "Checkout", "Identity"],
        "impact_tree": [
            "CVE-2026-1234",
            "├── openssl 3.1.2",
            "│    ├── payment-api.jar → build payment-service/319 → app Payments",
            "│    └── checkout-svc  → build checkout-api/205  → app Checkout",
            "└── libcrypto.so → auth-core.jar → app Identity",
        ],
        "remediation": {
            "upgrade": "openssl 3.1.2 → 3.1.7",
            "affected_builds": 5,
            "apps_requiring_rebuild": 3,
            "complexity": "Medium",
            "policy_blocking": "Active",
        },
    }
}

BUILD = {
    "name": "payment-service",
    "number": "319",
    "readiness": 86,
    "checks": [
        ("Build metadata published", "PASSED"),
        ("Required properties present", "PASSED"),
        ("No critical violations", "PASSED"),
        ("2 high vulnerabilities", "WARNING"),
        ("License policy passed", "PASSED"),
        ("Artifact checksums verified", "PASSED"),
        ("Staging repository approved", "PASSED"),
    ],
    "stages": [
        {"stage": "Development", "status": "PASSED", "ts": "Jul 17 09:12", "approver": "auto", "xray": "Passed", "policy": "Passed", "artifacts": 7},
        {"stage": "QA", "status": "PASSED", "ts": "Jul 17 14:03", "approver": "ci", "xray": "Passed", "policy": "Passed", "artifacts": 7},
        {"stage": "Staging", "status": "PASSED", "ts": "Jul 18 08:41", "approver": "priya", "xray": "Warning", "policy": "Passed", "artifacts": 7},
        {"stage": "Production", "status": "PENDING", "ts": "—", "approver": "—", "xray": "—", "policy": "—", "artifacts": 7},
    ],
    "change_preview": {
        "Source": "docker-stage-local",
        "Target": "docker-prod-local",
        "Build": "payment-service/319",
        "Artifacts": "7",
        "Total size": "1.8 GB",
        "Xray result": "Passed with warnings",
        "Rollback available": "Yes",
    },
}

CLEANUP_STORAGE = {
    "Total storage": "42 TB",
    "Potentially reclaimable": "3.8 TB",
    "Safe to delete": "1.9 TB",
    "Requires review": "1.4 TB",
    "Protected": "0.5 TB",
}

CLEANUP_STRATEGIES = [
    {"name": "Unused snapshots", "saving": "420 GB"},
    {"name": "Old Docker images", "saving": "890 GB"},
    {"name": "Remote cache cleanup", "saving": "310 GB"},
    {"name": "Unreferenced build artifacts", "saving": "280 GB"},
]

CLEANUP_EXCLUSIONS = [
    "Production-tagged artifacts excluded",
    "Legal-hold artifacts excluded",
    "Recently downloaded artifacts excluded",
    "Active build references checked",
    "Release Bundles excluded",
]

CLEANUP_PREVIEW = [
    {"Repository": "docker-dev-local", "Candidates": 2418, "Estimated Saving": "620 GB", "Risk": "Low"},
    {"Repository": "libs-snapshot", "Candidates": 8191, "Estimated Saving": "480 GB", "Risk": "Medium"},
    {"Repository": "npm-cache-remote", "Candidates": 5120, "Estimated Saving": "310 GB", "Risk": "Low"},
]

APPROVALS_INBOX = [
    {
        "operation": "Delete 1,842 unused artifacts",
        "requested_by": "Cleanup Agent",
        "environment": "Development",
        "risk": "HIGH",
        "scope": {"repository": "docker-dev-local", "artifact_count": 1842, "estimated_reclaim_gb": 327},
        "rollback": "No",
    },
    {
        "operation": "Promote build payment-service/319 → docker-prod-local",
        "requested_by": "Sam",
        "environment": "Production",
        "risk": "SENSITIVE",
        "scope": {"build": "payment-service/319", "artifacts": 7, "size_gb": 1.8},
        "rollback": "Yes",
    },
    {
        "operation": "Update Xray policy production-container-security",
        "requested_by": "Priya",
        "environment": "Production",
        "risk": "SENSITIVE",
        "scope": {"repositories_affected": 12, "new_action": "fail_build + block_download"},
        "rollback": "Yes",
    },
]

POLICY_COVERAGE = [
    {"Repository": "docker-prod", "Security Watch": "Covered", "License Watch": "Covered", "Critical Block": "Yes", "High Notify": "Yes"},
    {"Repository": "npm-prod", "Security Watch": "Covered", "License Watch": "Missing", "Critical Block": "Yes", "High Notify": "Yes"},
    {"Repository": "maven-dev", "Security Watch": "Missing", "License Watch": "Missing", "Critical Block": "No", "High Notify": "No"},
    {"Repository": "docker-stage", "Security Watch": "Covered", "License Watch": "Covered", "Critical Block": "Yes", "High Notify": "No"},
]

POLICY_RECS = [
    "3 production repositories have no license policy.",
    "2 repositories allow downloads despite critical violations.",
    "1 Xray Watch references a deleted repository.",
]

TROUBLESHOOT_FLOWS = {
    "Docker pull returns 403": [
        ("Validate artifact path", "PASSED"),
        ("Validate virtual repository membership", "PASSED"),
        ("Check token expiration", "PASSED"),
        ("Check repository permission", "BLOCKED"),
        ("Check project assignment", "PASSED"),
        ("Test anonymous access configuration", "PASSED"),
        ("Verify Docker registry endpoint", "PASSED"),
    ],
    "I cannot download a package": [
        ("Resolve package coordinates", "PASSED"),
        ("Validate virtual repo resolution", "PASSED"),
        ("Check remote repository health", "WARNING"),
        ("Check user read permission", "PASSED"),
        ("Check token scope", "PASSED"),
    ],
    "My build scan is missing": [
        ("Check build-info published", "PASSED"),
        ("Check Xray indexing status", "BLOCKED"),
        ("Check Watch covers build", "WARNING"),
        ("Check policy applicability", "PASSED"),
    ],
}

TROUBLESHOOT_FIX = {
    "Docker pull returns 403": "Add the user to group `payments-prod-readers`. This change requires approval.",
    "I cannot download a package": "Remote repository `npm-cache-remote` is degraded; retry or check upstream connectivity.",
    "My build scan is missing": "Xray indexing is backed up for this repo; trigger re-index and re-scan the build.",
}
