# JFrog Operations Copilot (LangGraph)

A LangGraph agent that acts as a **JFrog Artifactory/Xray operations copilot** —
not an unrestricted chatbot with admin credentials. It authenticates **once** as
a specific human through the **MCP gateway** (per-user OAuth), then answers
operational questions and (in later phases) prepares approval-gated actions.

Two things make this safe and auditable:

1. **Per-user auth through the gateway.** The agent never holds a JFrog admin
   token. It performs the gateway's OAuth flow one time, caches the resulting
   per-user token, and every query is executed *as that authorized user*. The
   gateway forwards the user's id_token upstream for the JFrog OIDC exchange, so
   only that user's queries reach JFrog.
2. **The LLM proposes, deterministic code disposes.** The model never emits raw
   AQL or shell. It produces a *structured intent* that a validated builder and a
   typed tool allowlist turn into safe, bounded, read-only calls. Authorization
   is decided by a deterministic policy service, and every run writes an
   immutable, secret-redacted audit record.

---

## Architecture

```
User request
    │
    ▼
interpret            intent + scope (LLM or offline heuristic planner)
    │
    ▼
classify             read / write / risk
    │
    ▼
plan                 task decomposition + DETERMINISTIC authorization
    │
    ▼
artifactory_subgraph collect evidence via read-only tools
    │
    ▼
evidence             validate findings (no errors, real data)
    │
    ▼
policy               risk engine → route
    │           ╲
    ▼            ╲
execute        approval   ← LangGraph interrupt() for high-risk ops
    ╲            ╱          (persists state, resumes on approve/reject)
     ▼          ╱
     verify
     │
     ▼
audit                immutable record + final answer
```

Layout:

| Path | Responsibility |
|------|----------------|
| `jfrog_agent/mcp_client.py` | **OAuth-through-gateway** client: one-time auth, token cache, MCP session, `x-mcp-client-type` header |
| `jfrog_agent/llm.py` | Planner (LLM or deterministic heuristic) + summarizer |
| `jfrog_agent/tools/aql.py` | **Validated AQL builder** — the only thing that turns intent into AQL |
| `jfrog_agent/tools/artifactory.py` | Small typed tools over MCP calls |
| `jfrog_agent/tools/registry.py` | Tool risk classes (read / reversible / sensitive / destructive) |
| `jfrog_agent/security.py` | Deterministic authorizer + secrets redaction |
| `jfrog_agent/audit_log.py` | Immutable per-run audit trail |
| `jfrog_agent/graph.py` | LangGraph assembly with human-in-the-loop interrupts |
| `run.py` | CLI |

---

## Prerequisites

- Python 3.10+
- The **MCP gateway** and **Artifactory MCP** running (see the repo root README).
  By default the agent expects the gateway at `http://localhost:8090` with the
  `artifactory` namespace.
- (Optional) An OpenAI or Anthropic API key for the LLM planner. Without one, the
  agent uses a deterministic keyword planner and still runs.

## Setup

```bash
cd Agents/jfrog-agent
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env       # then edit as needed
```

Key `.env` values (full list in `.env.example`):

```ini
JFROG_AGENT_GATEWAY_URL=http://localhost:8090
JFROG_AGENT_MCP_NAMESPACE=artifactory
JFROG_AGENT_CLIENT_TYPE=agent            # how monitoring labels this traffic
JFROG_AGENT_READ_ONLY=true               # Phase 1 default
JFROG_AGENT_REPO_ALLOWLIST=              # empty = all repos for READ only
JFROG_AGENT_LLM_PROVIDER=openai          # or: anthropic | none
# OPENAI_API_KEY=sk-...
```

## Usage

```bash
# 1) One-time authorization (opens a browser; token is cached for reuse)
python run.py --login

# 2) See what the upstream MCP actually exposes
python run.py --list-tools

# 3) Ask questions (per-user, read-only)
python run.py "Which local repositories exist?"
python run.py "How much storage are we using?"
python run.py "Show npm packages not downloaded for 180 days"
python run.py "Find Docker images larger than 2 GB"
```

The first run opens your browser for the gateway OAuth consent. After that the
token is cached at `~/.jfrog-agent/token.json` and silently refreshed, so
subsequent runs need **no** browser (this is the "authenticate once" behavior).

Every run prints an answer, an outcome (`completed` / `denied` / `rejected`), and
the path to its audit record under `~/.jfrog-agent/audit/`.

---

## Web UI (Streamlit) — run locally or as a container

A chat UI (`app.py`) wraps the same agent: connect, ask questions, see the
structured findings (AQL, raw results), approve high-risk operations, and view
the audit path — all in the browser.

### Local

```bash
source .venv/bin/activate
streamlit run app.py           # http://localhost:8501
```

### Container

```bash
# optional: pass an LLM key so the planner uses an LLM (else offline heuristic)
export OPENAI_API_KEY=sk-...   JFROG_AGENT_LLM_PROVIDER=openai
docker compose up --build      # http://localhost:8501
```

Then open http://localhost:8501 and click **Authorize with gateway** once. The
token is stored in a Docker volume and reused on every restart.

**How OAuth works from inside the container.** The gateway is reachable under two
names, which the app handles automatically:

- Server-side calls (discovery, token exchange, MCP) use
  `JFROG_AGENT_GATEWAY_URL=http://host.docker.internal:8090`.
- The browser authorization link uses
  `JFROG_AGENT_GATEWAY_PUBLIC_URL=http://localhost:8090` so *your* browser can
  open it.
- The OAuth redirect (`http://127.0.0.1:8777/callback`) is caught by the
  callback server bound to `0.0.0.0` in the container, with port `8777` mapped to
  the host.

> The gateway itself must be running and reachable from the host at
> `http://localhost:8090` (start it from `mcp-gateway/`). If you changed the
> gateway telemetry (the `x-mcp-client-type` support), rebuild it:
> `docker compose up -d --build gateway`.

Prefer to skip in-app login? Run `python run.py --login` on the host once and
mount `~/.jfrog-agent` into the container instead of the named volume.

## Agent vs. coding-assistant tracking (monitoring)

The gateway records who and *what kind of client* made each call:

- The agent sends **`x-mcp-client-type: agent`** (configurable) and an
  `x-mcp-client-id` per session on every MCP request.
- The gateway writes these onto the OpenTelemetry span/metric as
  **`gateway.client_type`** and `gateway.client_instance_id`, alongside the
  existing `user_id`, `gen_ai.tool.name`, and `gateway.oauth_client_id`.
- Grafana's *MCP Gateway* dashboard has a **Client type** variable and two panels
  ("Tool calls / sec by client type" and "Calls by user / client type / tool")
  that split agent traffic from interactive tools like Cursor. Cursor/other tools
  that don't send the header appear as `unset`.

So you can answer "did this user's request come from the JFrog agent or from a
coding assistant?" directly in monitoring, per user and per tool.

---

## Durable memory & LLM evaluation

The gateway's Grafana dashboard only sees **MCP tool traffic** — it never sees
LLM calls (the agent calls the LLM directly). So the agent keeps its own,
agent-side stores:

- **LLM & Evaluation** (Governance → *LLM & Evaluation*): every planner/summarizer
  call is recorded with **provider, model, prompt/completion tokens, latency,
  estimated cost**, plus **human 👍/👎 feedback** on answers and structural
  quality signals. Rate answers on *Ask JFrog Agent* to grow the eval dataset.
- **Threads** (Command Center → *Threads*): conversations and their messages are
  persisted, so you can close the app and **resume past threads tomorrow**.
  LangGraph **checkpoints** are persisted too, so an interrupted run awaiting
  approval survives a restart.

Both use a pluggable backend selected by `JFROG_AGENT_MEMORY_BACKEND`:

| Backend | Setup | Where data lives |
| --- | --- | --- |
| `sqlite` *(default)* | none | `~/.jfrog-agent/memory.db` + `checkpoints.db` (the `/data` volume in Docker) |
| `spanner` | run the emulator (below) or point at real Cloud Spanner | Spanner tables in `agent-memory` |

### Use the local Spanner emulator

`docker compose up` starts a `spanner-emulator` service (gRPC on host **9110**).
To use it:

```bash
export JFROG_AGENT_MEMORY_BACKEND=spanner
export SPANNER_EMULATOR_HOST=localhost:9110   # container: spanner-emulator:9010
```

The instance/database/schema are created automatically on first use. Emulator
data is in-memory and resets when its container restarts.

### Verify memory works

```bash
# sqlite
PYTHONPATH=. python scripts/verify_memory.py
# spanner emulator
JFROG_AGENT_MEMORY_BACKEND=spanner SPANNER_EMULATOR_HOST=localhost:9110 \
  PYTHONPATH=. python scripts/verify_memory.py
```

This proves threads/messages/telemetry round-trip and that a LangGraph
checkpoint **resumes across a simulated restart** for the selected backend.

---

## Safety model (why this isn't a foot-gun)

- **Read-only by default.** `JFROG_AGENT_READ_ONLY=true` hard-blocks any
  write/destructive tool. Phase 1 is discovery, explanation and recommendations
  only.
- **No raw AQL / no `run_shell`.** The LLM fills a `SearchIntent`; the validated
  builder enforces allowed domains, a hard result cap, mandatory pagination,
  repository scope, and denied sensitive fields.
- **Deterministic authorization.** `security.Authorizer` — not the LLM — decides
  allow / deny / needs-approval, using the tool's risk class and the repo
  allowlist.
- **Human-in-the-loop.** Sensitive/destructive operations trigger a LangGraph
  `interrupt()` with a structured approval payload; the graph persists and
  resumes only on explicit approval.
- **Secrets redaction + immutable audit.** Tokens are stripped from logs, traces
  and the audit trail; each run is recorded with requester, plan, decisions and
  results.
- **Prompt-injection isolation.** Artifact names/properties/scan text are treated
  as untrusted data in the summarizer prompt, never as instructions.

---

## Roadmap (phased, matching the vision)

- **Phase 1 — Read-only intelligence (implemented):** artifact search (validated
  AQL), repository inspection, storage/system info, structured answers, audit.
- **Phase 2 — Controlled workflows:** property updates, copy/move, build scans,
  build promotion — all approval-gated (specs already declared in
  `tools/registry.py`; wire to upstream MCP tools as they land).
- **Phase 3 — Administrative:** permissions, Watches/Policies, retention,
  bulk cleanup with dry-run manifests + two-step approval.
- **Phase 4 — Proactive:** event-driven investigations (new critical CVE, quota
  exceeded, unscanned production artifact) that prepare approval-ready plans.

> Xray, build-intelligence and admin subgraphs are part of Phases 2–4. The
> current upstream Artifactory MCP server exposes read tools only, so those tools
> are declared with their risk classes and authorization is enforced, but their
> execution is intentionally not wired until the corresponding MCP tools exist.
```
