"""JFrog operations copilot — a LangGraph agent that talks to Artifactory/Xray
through an MCP gateway using per-user OAuth.

Design principles (see README):
  * Read-only by default; write/destructive actions require human approval.
  * The LLM never executes unrestricted AQL or shell — a validated builder and a
    typed tool allowlist sit between intent and execution.
  * Authorization is decided by a deterministic policy service, not the LLM.
  * Every run produces an immutable audit record.
"""

__version__ = "0.1.0"
