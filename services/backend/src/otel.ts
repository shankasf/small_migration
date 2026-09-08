/**
 * OpenTelemetry bootstrap. Must be imported before any other module so
 * auto-instrumentation can patch http/express/pg.
 *
 * Instrumentation is always on; the export destination is config-led:
 * spans go to OTEL_EXPORTER_OTLP_ENDPOINT when set (an OTel Collector),
 * otherwise they are recorded but not exported (no-op exporter).
 */
import dotenv from 'dotenv';
dotenv.config();

import { NodeSDK } from '@opentelemetry/sdk-node';
// Explicit instrumentations rather than auto-instrumentations-node: the
// meta-package loads adapters for dozens of services this app never touches
// (GCP, AWS, Redis, Mongo, ...), and its GCP resource detector dragged in the
// gcp-metadata -> gaxios -> rimraf -> glob -> minimatch -> brace-expansion
// chain that accounted for every outstanding high-severity advisory here.
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { trace, Tracer } from '@opentelemetry/api';

const enabled = (process.env.OTEL_ENABLED || 'true').toLowerCase() !== 'false';
const serviceName = process.env.OTEL_SERVICE_NAME || 'circini-backend';
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (enabled) {
  const sdk = new NodeSDK({
    serviceName,
    ...(otlpEndpoint
      ? { traceExporter: new OTLPTraceExporter({ url: `${otlpEndpoint.replace(/\/$/, '')}/v1/traces` }) }
      : {}),
    instrumentations: [
      new HttpInstrumentation({
        // OAuth callbacks contain short-lived authorization codes in their query.
        ignoreIncomingRequestHook: req => !!req.url?.includes('/callback'),
        ignoreOutgoingRequestHook: req => String(req.path || '').includes('?'),
      }),
      new ExpressInstrumentation(),
    ],
  });

  try {
    sdk.start();
    console.log(`[OTEL] Started (service=${serviceName}, exporter=${otlpEndpoint || 'none'})`);
  } catch (err) {
    console.error('[OTEL] Failed to start:', err);
  }

  process.on('SIGTERM', () => {
    sdk.shutdown().catch(() => undefined);
  });
}

export function getTracer(): Tracer {
  return trace.getTracer('circini-backend');
}
