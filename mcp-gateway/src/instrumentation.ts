import { NodeSDK } from '@opentelemetry/sdk-node'
import {
  TraceIdRatioBasedSampler,
  ParentBasedSampler,
  ConsoleSpanExporter,
} from '@opentelemetry/sdk-trace-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'
import {
  PeriodicExportingMetricReader,
  InstrumentType,
  AggregationType,
  ConsoleMetricExporter,
} from '@opentelemetry/sdk-metrics'
import {
  defaultResource,
  resourceFromAttributes,
} from '@opentelemetry/resources'
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions'
import { METRIC_MCP_CLIENT_OPERATION_DURATION } from '@opentelemetry/semantic-conventions/incubating'

import pkg from '../package.json' with { type: 'json' }

const resource = defaultResource().merge(
  resourceFromAttributes({
    [ATTR_SERVICE_NAME]: pkg.name,
    [ATTR_SERVICE_VERSION]: pkg.version,
  })
)

const nrLicenseKey = process.env.NEW_RELIC_LICENSE_KEY
// Any OTLP-compatible backend (OpenTelemetry Collector, Grafana Alloy, etc.).
// When set, it takes precedence over New Relic and the local console exporters.
// The proto/http exporters read OTEL_EXPORTER_OTLP_ENDPOINT (base URL) directly
// and append the signal path (/v1/traces, /v1/metrics) automatically.
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
const isLocalDev = process.env.NODE_ENV !== 'production'

async function agentFactory() {
  // use dynamic import to ensure the file is imported after otel has the chance
  // to instrument the http/https modules
  const { ProxyAgent } = await import('proxy-agent')
  return new ProxyAgent()
}

const httpAgentOptions = process.env.HTTPS_PROXY ? agentFactory : undefined

function getTraceExporter() {
  // Generic OTLP collector (local monitoring stack or any vendor).
  if (otlpEndpoint) return new OTLPTraceExporter()

  if (nrLicenseKey) {
    return new OTLPTraceExporter({
      url: 'https://otlp.nr-data.net:443/v1/traces',
      headers: { 'api-key': nrLicenseKey },
      httpAgentOptions,
    })
  }

  if (isLocalDev) return new ConsoleSpanExporter()
}

function getMetricExporter() {
  if (otlpEndpoint) return new OTLPMetricExporter()

  if (nrLicenseKey) {
    return new OTLPMetricExporter({
      url: 'https://otlp.nr-data.net:443/v1/metrics',
      headers: { 'api-key': nrLicenseKey },
      httpAgentOptions,
    })
  }

  if (isLocalDev) return new ConsoleMetricExporter()
}

const traceExporter = getTraceExporter()
const metricExporter = getMetricExporter()

const sdk = new NodeSDK({
  traceExporter,
  metricReaders: metricExporter
    ? [new PeriodicExportingMetricReader({ exporter: metricExporter })]
    : [],
  views: [
    // see spec https://opentelemetry.io/docs/specs/semconv/gen-ai/mcp/#metrics
    {
      instrumentType: InstrumentType.HISTOGRAM,
      instrumentName: METRIC_MCP_CLIENT_OPERATION_DURATION,
      aggregation: {
        type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
        options: {
          boundaries: [
            0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300,
          ],
        },
      },
    },
  ],
  resource,
  sampler: new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(1),
  }),
})

sdk.start()
