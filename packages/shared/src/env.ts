import { z } from "zod";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const envSchema = z.object({
  APP_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  APP_RELEASE: z.string().min(1).default("dev"),
  GIT_SHA: z.string().min(1).default("local"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1).default("postgres://moneo:moneo@localhost:5432/moneo"),
  DATABASE_MIGRATION_URL: z.string().min(1).optional(),
  OUTBOX_DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  S3_ENDPOINT: z.string().min(1).default("http://localhost:9000"),
  S3_REGION: z.string().min(1).default("eu-west-1"),
  S3_BUCKET: z.string().min(1).default("moneo-quarantine"),
  S3_ACCESS_KEY: z.string().min(1).default("minio"),
  S3_SECRET_KEY: z.string().min(1).default("minio123"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().min(1).default("http://localhost:4318"),
  OTEL_SERVICE_NAME: z.string().min(1).default("moneo"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  // --- Epoch 1 auth (optional until the Auth0 EU tenant is wired up) ---
  APP_BASE_URL: z.string().min(1).default("http://localhost:3000"),
  AUTH0_DOMAIN: z.string().min(1).optional(),
  AUTH0_CLIENT_ID: z.string().min(1).optional(),
  AUTH0_CLIENT_SECRET: z.string().min(1).optional(),
  /** Encrypts Auth0 SDK's server-side session cookie. */
  AUTH0_SECRET: z.string().min(1).optional(),
  /** Public login hostname (e.g. login.moneo.example); canonical EU domain stays the token issuer. */
  AUTH0_CUSTOM_DOMAIN: z.string().min(1).optional(),
  /** Legacy fallback for transaction-search cursor signing. */
  SESSION_SECRET: z.string().min(1).optional(),
  // --- Epoch 4, Issue 4.6/4.7: HMAC secret for opaque transaction cursors ---
  /** Signs keyset pagination cursors. Defaults to SESSION_SECRET when unset; one must be set in server environments. */
  SEARCH_CURSOR_SECRET: z.string().min(1).optional(),
  // --- Epoch 1, Issue 1.8: provider-backed strong authentication ---
  /** Management API credentials for live MFA verification. Default to the base pair when unset. */
  AUTH0_MANAGEMENT_CLIENT_ID: z.string().min(1).optional(),
  AUTH0_MANAGEMENT_CLIENT_SECRET: z.string().min(1).optional(),
  /** Passkey enrollment offered when anything but an explicit opt-out. */
  AUTH0_PASSKEYS_ENABLED: z.string().min(1).optional(),
  /** Local-only 32-byte base64 KEK for envelope-encrypted AI credentials. */
  AI_CREDENTIAL_ENCRYPTION_KEY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  AI_CREDENTIAL_KMS_KEY_ID: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
});

export type AppEnv = z.infer<typeof envSchema>;

/** Find the closest workspace `.env`, including when bundled by Next.js. */
export function findWorkspaceEnvFile(cwd = process.cwd()): string | undefined {
  let directory = resolve(cwd);
  for (;;) {
    const candidate = resolve(directory, ".env");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

function loadLocalEnv(): void {
  const localEnvFile = findWorkspaceEnvFile();
  if (localEnvFile) {
    process.loadEnvFile(localEnvFile);
  }
}

/**
 * Parse and validate process.env once at service boot.
 * Throws a descriptive error when required configuration is missing.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  if (source === process.env) {
    loadLocalEnv();
  }
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}
