"""Slack Socket Mode front-end for the JFrog supply-chain agent.

The Android emulator (or any phone) runs the normal Slack app. It talks to
Slack's servers. This process opens an outbound Socket Mode connection, so
you do not need a public URL or ngrok for a demo.

  1. Create a Slack app → Socket Mode ON
  2. Bot token scopes: chat:write, app_mentions:read, im:history, im:write, im:read
  3. Event subscriptions: message.im, app_mention
  4. Install to your workspace; copy xoxb- and xapp- tokens into .env
  5. python run.py --slack
  6. On the emulator: install Slack, sign into that workspace, DM the bot
"""

from __future__ import annotations

import logging
import os
import re
import ssl
import threading
import time
from collections import OrderedDict

from .ask import ask
from .settings import Settings, settings as default_settings

logger = logging.getLogger("jfrog_slack")

# Slack redelivers app_mention events when the bot reconnects. Dedupe by event_id
# (or a short hash of channel+text+ts) so one user message → one agent run.
_SEEN_EVENTS: OrderedDict[str, float] = OrderedDict()
_SEEN_LOCK = threading.Lock()
_SEEN_TTL_SEC = 300
_SEEN_MAX = 500

_HELP = (
    "*JFrog Supply-Chain Agent*\n"
    "Your *JFrog Cloud trial* is wired for *Artifactory inventory* (repos, search, storage) "
    "when MCP is connected. Xray/Curation/AppTrust are *not* on the trial API — those "
    "questions run on the agent's supply-chain graph (same engines as the console).\n\n"
    "*Submit these in Slack (work now, no extra JFrog SKU):*\n"
    "• `Is CVE-2024-0727 reachable in production?`\n"
    "• `Scan for typosquat / xz-style package behavior`\n"
    "• `Why is payment-service:319 in prod?`\n"
    "• `Same source, hash mismatch for payment-service`\n"
    "• `GPL exposure in payment-api`\n"
    "• `Optimize retention under regulatory minima`\n\n"
    "*Submit these only if Artifactory MCP is logged in (trial):*\n"
    "• `Which repositories exist?`\n"
    "• `How much storage are we using?`\n"
    "• `Find artifacts not downloaded in 180 days`\n\n"
    "*Do not submit (will be denied on trial):* promote, delete, quarantine, live Xray "
    "watch edits. Approvals stay in Streamlit. Copy a line *without* a leading dash."
)

_MENTION = re.compile(r"<@[^>]+>\s*")


def _event_key(event: dict) -> str:
    if event.get("event_id"):
        return str(event["event_id"])
    return f"{event.get('channel')}:{event.get('ts')}:{(event.get('text') or '')[:120]}"


def _seen_event(event: dict) -> bool:
    """True if this Slack delivery was already handled (replay / duplicate)."""
    key = _event_key(event)
    now = time.time()
    with _SEEN_LOCK:
        stale = [k for k, ts in _SEEN_EVENTS.items() if now - ts > _SEEN_TTL_SEC]
        for k in stale:
            del _SEEN_EVENTS[k]
        if key in _SEEN_EVENTS:
            logger.info("skip duplicate slack event key=%s", key[:80])
            return True
        _SEEN_EVENTS[key] = now
        while len(_SEEN_EVENTS) > _SEEN_MAX:
            _SEEN_EVENTS.popitem(last=False)
    return False


def _to_slack(text: str) -> str:
    text = text.strip() or "(empty answer)"
    if len(text) > 3500:
        text = text[:3400] + "\n…_(truncated — see the console for the full report)_"
    return text


def _footer(result: dict) -> str:
    """One dim line proving memory, tracking and trimming actually ran.

    Slack is where this agent gets demoed, and the platform work is invisible in
    a chat reply unless it is stated: without this the answer looks like a plain
    LLM response with no thread, no eval record and no token accounting.
    """
    bits = []
    turns = result.get("history_turns") or 0
    if turns:
        bits.append(f"memory: {turns} prior turn{'s' if turns != 1 else ''}")
    tokens = result.get("tokens") or {}
    if tokens.get("total_tokens"):
        bits.append(f"{tokens['total_tokens']:,} tokens in {tokens.get('calls', 0)} LLM call(s)")
    ctx = result.get("context_optimizer") or {}
    if ctx.get("saved"):
        before = ctx.get("tokens_before") or 0
        pct = f" ({100 * ctx['saved'] // before}%)" if before else ""
        bits.append(f"trimmed {ctx['saved']:,} tokens{pct}")
    if result.get("run_id"):
        bits.append(f"run `{result['run_id']}`")
    return f"_{' · '.join(bits)}_" if bits else ""


def _ssl_context() -> ssl.SSLContext:
    """Corporate proxies / Python 3.14 often fail Slack's default CA check."""
    if os.getenv("SLACK_SSL_INSECURE", "").strip().lower() in {"1", "true", "yes"}:
        return ssl._create_unverified_context()
    try:
        import truststore

        return truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    except Exception:
        try:
            import certifi

            return ssl.create_default_context(cafile=certifi.where())
        except Exception:
            return ssl.create_default_context()


def start_bot(settings: Settings = default_settings) -> None:
    try:
        from slack_bolt import App
        from slack_bolt.adapter.socket_mode import SocketModeHandler
        from slack_sdk import WebClient
        from slack_sdk.socket_mode import SocketModeClient
        from slack_sdk.web import WebClient as _Web  # noqa: F401
    except ImportError as exc:
        raise SystemExit(
            "slack-bolt is not installed. In the venv: pip install slack-bolt"
        ) from exc

    bot_token = settings.slack_bot_token
    app_token = settings.slack_app_token
    if not bot_token or not app_token:
        raise SystemExit(
            "Set SLACK_BOT_TOKEN (xoxb-…) and SLACK_APP_TOKEN (xapp-…) in .env"
        )

    try:
        import truststore

        truststore.inject_into_ssl()
    except Exception:
        pass
    ssl_ctx = _ssl_context()
    web = WebClient(token=bot_token, ssl=ssl_ctx)
    app = App(token=bot_token, client=web, logger=logger)

    @app.middleware
    def _log_inbound(body, next):
        ev = body.get("event") if isinstance(body, dict) else None
        kind = (ev or {}).get("type") if isinstance(ev, dict) else body.get("type")
        logger.info("slack inbound type=%s", kind)
        next()

    def _reply(channel: str, text: str, say) -> None:
        try:
            say(text)
        except Exception:
            logger.exception("say() failed; falling back to chat_postMessage")
            web.chat_postMessage(channel=channel, text=text)

    def _handle(text: str, user: str, channel: str, say) -> None:
        text = _MENTION.sub("", text or "").strip()
        text = re.sub(r"^[-–—]+\s*", "", text)
        if not text or text.lower() in {"help", "hi", "hello", "?"}:
            _reply(channel, _HELP, say)
            return
        logger.info("ask start user=%s channel=%s text=%r", user, channel, text[:80])
        _reply(channel, f"_Working `{text[:80]}`…_", say)
        try:
            # Key memory on the Slack conversation, so a DM or channel keeps its
            # thread across turns and across restarts of this process — the same
            # continuity the Streamlit thread list gives.
            result = ask(
                text, user=user, settings=settings, thread_id=f"slack-{channel}"
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("ask failed")
            _reply(channel, f"Agent error: `{type(exc).__name__}: {exc}`", say)
            return
        outcome = result.get("outcome") or "—"
        logger.info("ask done outcome=%s run_id=%s", outcome, result.get("run_id"))
        _reply(
            channel,
            f"*outcome:* `{outcome}`\n{_to_slack(result['answer'])}\n{_footer(result)}",
            say,
        )

    @app.event("app_mention")
    def on_mention(event, say):
        if _seen_event(event):
            return
        logger.info("app_mention from %s", event.get("user"))
        _handle(
            event.get("text", ""), event.get("user", "slack"),
            event.get("channel", "unknown"), say,
        )

    @app.event("message")
    def on_message(event, say):
        if event.get("subtype") or event.get("bot_id"):
            return
        # Channel @mentions are handled by app_mention; only DMs here.
        if event.get("channel_type") != "im":
            return
        if _seen_event(event):
            return
        text = event.get("text") or ""
        logger.info("message channel_type=%s", event.get("channel_type"))
        _handle(text, event.get("user", "slack"), event.get("channel", "unknown"), say)

    auth = web.auth_test()
    logger.info(
        "Slack Socket Mode starting as @%s in %s — mention the bot or DM it",
        auth.get("user"),
        auth.get("team"),
    )
    try:
        SocketModeHandler(app, app_token).start()
    except Exception:
        logger.exception("slack bot crashed")
        raise
    finally:
        logger.warning("slack bot stopped")
