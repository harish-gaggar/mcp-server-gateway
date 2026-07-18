"""Optional agent-side OpenTelemetry tracing.

The primary agent-vs-tool tracking happens at the GATEWAY (via the
`x-mcp-client-type` header the client sends — see mcp_client.py). This module is
an optional extra: if `JFROG_AGENT_OTEL_ENDPOINT` is set, the agent also exports
its own spans to the same collector so you can correlate a run end-to-end.
"""

from __future__ import annotations

from .settings import Settings, settings as default_settings

_TRACER = None


def maybe_setup_tracing(settings: Settings = default_settings):
    global _TRACER
    if not settings.otel_endpoint:
        return None
    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        resource = Resource.create(
            {
                "service.name": settings.client_name,
                "gateway.client_type": settings.client_type,
            }
        )
        provider = TracerProvider(resource=resource)
        provider.add_span_processor(
            BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{settings.otel_endpoint.rstrip('/')}/v1/traces"))
        )
        trace.set_tracer_provider(provider)
        _TRACER = trace.get_tracer("jfrog-agent")
        return _TRACER
    except Exception:
        return None


def get_tracer():
    return _TRACER
