import { trace, context } from "@opentelemetry/api";
import pino, { type Logger } from "pino";
import type { AppEnv } from "./env.js";

export interface LogBase {
  service: string;
  environment: string;
  release: string;
}

let logger: Logger | undefined;

/**
 * Structured JSON logger. Every line carries service/environment/release
 * plus the active trace_id/span_id/request_id when available.
 */
export function createLogger(options: {
  service: string;
  env: Pick<AppEnv, "APP_ENV" | "APP_RELEASE" | "LOG_LEVEL">;
  requestId?: string;
}): Logger {
  const base: LogBase & { request_id?: string } = {
    service: options.service,
    environment: options.env.APP_ENV,
    release: options.env.APP_RELEASE,
  };
  if (options.requestId) base.request_id = options.requestId;

  return pino({
    level: options.env.LOG_LEVEL,
    base,
    formatters: {
      level: (label) => ({ level: label }),
    },
    mixin() {
      const span = trace.getSpan(context.active());
      const spanContext = span?.spanContext();
      if (!spanContext) return {};
      return {
        trace_id: spanContext.traceId,
        span_id: spanContext.spanId,
      };
    },
  });
}

export function getLogger(): Logger {
  if (!logger) {
    logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
  }
  return logger;
}
