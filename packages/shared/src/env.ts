import { z } from "zod";

const envSchema = z.object({
  APP_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  APP_RELEASE: z.string().min(1).default("dev"),
  GIT_SHA: z.string().min(1).default("local"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1).default("postgres://moneo:moneo@localhost:5432/moneo"),
  DATABASE_MIGRATION_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  S3_ENDPOINT: z.string().min(1).default("http://localhost:9000"),
  S3_REGION: z.string().min(1).default("eu-west-1"),
  S3_BUCKET: z.string().min(1).default("moneo-quarantine"),
  S3_ACCESS_KEY: z.string().min(1).default("minio"),
  S3_SECRET_KEY: z.string().min(1).default("minio123"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().min(1).default("http://localhost:4318"),
  OTEL_SERVICE_NAME: z.string().min(1).default("moneo"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type AppEnv = z.infer<typeof envSchema>;

/**
 * Parse and validate process.env once at service boot.
 * Throws a descriptive error when required configuration is missing.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}
