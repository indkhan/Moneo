import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import type { AppEnv } from "@moneo/shared/env";

let sdk: NodeSDK | undefined;

/** Start OpenTelemetry tracing for the worker (pg + ioredis auto-instrumented). */
export function startTelemetry(env: AppEnv): void {
  if (sdk) return;
  sdk = new NodeSDK({
    serviceName: `${env.OTEL_SERVICE_NAME}-worker`,
    traceExporter: new OTLPTraceExporter({ url: `${env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` }),
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });
  sdk.start();
}

export async function shutdownTelemetry(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = undefined;
  }
}
