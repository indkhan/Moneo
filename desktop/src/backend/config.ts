// config.json in the desktop home: the generated secrets (same generation as scripts/setup.mjs),
// the chosen ports and what has been set up. Written atomically with mode 0600.
import { createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type Secrets = {
  POSTGRES_PASSWORD: string;
  JWT_SECRET: string;
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  BANK_TOKEN_ENCRYPTION_KEY: string;
  CRON_SECRET: string;
  MONEO_OWNER_EMAIL: string;
  MONEO_OWNER_PASSWORD: string;
};

export type Config = {
  version: 1;
  secrets: Secrets;
  // Preferred ports; a busy one is replaced by a free one at start and saved here.
  ports: { api: number; db: number };
  // True once 00-roles.sql/10-schema.sql ran on this cluster.
  bootstrapped: boolean;
  // Latest applied supabase/migrations version and the bundled service versions it ran with.
  schemaVersion?: string;
  services?: Record<string, string>;
  appVersion?: string;
};

export const DEFAULT_PORTS = { api: 54331, db: 54332 };

const secret = (bytes = 32) => randomBytes(bytes).toString("base64url");

// HS256 API keys for anon and service_role, valid ten years, exactly like scripts/setup.mjs.
export function apiKey(role: string, jwtSecret: string) {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = `${part({ alg: "HS256", typ: "JWT" })}.${part({ iss: "supabase", role, iat: now, exp: now + 10 * 365 * 86_400 })}`;
  return `${body}.${createHmac("sha256", jwtSecret).update(body).digest("base64url")}`;
}

export function newConfig(): Config {
  const jwtSecret = secret(48);
  return {
    version: 1,
    secrets: {
      POSTGRES_PASSWORD: secret(24),
      JWT_SECRET: jwtSecret,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: apiKey("anon", jwtSecret),
      SUPABASE_SERVICE_ROLE_KEY: apiKey("service_role", jwtSecret),
      BANK_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      CRON_SECRET: secret(),
      MONEO_OWNER_EMAIL: "owner@moneo.local",
      MONEO_OWNER_PASSWORD: secret(24),
    },
    ports: { ...DEFAULT_PORTS },
    bootstrapped: false,
  };
}

export async function readConfig(file: string): Promise<Config | undefined> {
  if (!existsSync(file)) return undefined;
  const config = JSON.parse(await fs.readFile(file, "utf8")) as Config;
  if (config.version !== 1 || !config.secrets?.POSTGRES_PASSWORD || !config.secrets?.JWT_SECRET)
    throw new Error(`${file} is not a Moneo Desktop configuration`);
  return config;
}

export async function writeConfig(file: string, config: Config) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const partial = `${file}.${process.pid}.partial`;
  await fs.writeFile(partial, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(partial, file);
  await fs.chmod(file, 0o600);
}
