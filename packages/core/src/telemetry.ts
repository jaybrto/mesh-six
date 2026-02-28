/**
 * Shared OpenTelemetry initialization for mesh-six services.
 *
 * Call `initTelemetry()` BEFORE importing any other modules to ensure
 * automatic instrumentation captures all HTTP traffic.
 *
 * Exports OTLP traces to the Grafana LGTM cluster, maintaining a single
 * distributed trace spanning k3s and macOS workers.
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_SERVICE_INSTANCE_ID,
} from "@opentelemetry/semantic-conventions";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";

export interface TelemetryConfig {
  serviceName: string;
  serviceVersion?: string;
  instanceId?: string;
  /** OTLP HTTP endpoint. Defaults to OTEL_EXPORTER_OTLP_ENDPOINT env or http://localhost:4318 */
  otlpEndpoint?: string;
}

let sdk: NodeSDK | null = null;

export function initTelemetry(config: TelemetryConfig): NodeSDK {
  if (sdk) return sdk;

  const endpoint =
    config.otlpEndpoint ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    "http://localhost:4318";

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion || "0.1.0",
    [ATTR_SERVICE_INSTANCE_ID]:
      config.instanceId || process.env.HOSTNAME || "unknown",
  });

  sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
    }),
    instrumentations: [new HttpInstrumentation()],
  });

  sdk.start();

  // Graceful shutdown
  const shutdownHandler = () => {
    sdk
      ?.shutdown()
      .then(() => console.log("[otel] Telemetry SDK shut down"))
      .catch((err) => console.error("[otel] Shutdown error:", err));
  };
  process.on("SIGTERM", shutdownHandler);
  process.on("SIGINT", shutdownHandler);

  console.log(
    `[otel] Initialized ${config.serviceName} → ${endpoint}/v1/traces`,
  );
  return sdk;
}

export { sdk as telemetrySdk };
