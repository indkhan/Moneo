// E00-S04 proof environment. Reads connection inputs from process.env,
// falling back to the repo .env file. Values are never logged; failures name
// only the missing variable and the local prerequisite that provides it.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ProofEnv = {
  // PG connection string for the app role (used for all proof runtime I/O).
  appUrl: string;
  // PG connection string for a CREATEDB-capable role (used once to create the
  // disposable proof database). Falls back to appUrl and then fails closed.
  setupUrl: string;
  // Name of the disposable proof database owned by this suite.
  proofDb: string;
  // Redis connection string of the LOCAL dev server (flush guard below).
  redisUrl: string;
  // Disposable logical Redis DB owned by this suite. Only this DB is ever
  // flushed, and only when its host is loopback.
  redisDb: number;
};

function parseDotEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  return out;
}

const fileEnv = parseDotEnvFile(join(process.cwd(), ".env"));
const get = (name: string): string | undefined => process.env[name] ?? fileEnv[name];

function requireVar(name: string, hint: string): string {
  const v = get(name);
  if (!v) throw new Error(`E00-S04 prerequisite missing: ${name}. ${hint}`);
  return v;
}

export function loadProofEnv(): ProofEnv {
  const appUrl = requireVar(
    "DATABASE_URL",
    "Set it to the local PostgreSQL app-role URL (see README prerequisites).",
  );
  const setupUrl = get("DATABASE_MIGRATION_URL") ?? appUrl;
  const redisUrl = requireVar(
    "REDIS_URL",
    "Start the local disposable Redis (WSL: redis-server) and set REDIS_URL to it.",
  );
  const proofDb = get("DURABLE_PROOF_DB") ?? "moneo_durable_proof";
  const redisDb = Number(get("DURABLE_PROOF_REDIS_DB") ?? "15");
  if (!Number.isInteger(redisDb) || redisDb < 0 || redisDb > 15) {
    throw new Error("E00-S04 misconfigured: DURABLE_PROOF_REDIS_DB must be an integer 0-15.");
  }
  let redisHost = "";
  try {
    redisHost = new URL(redisUrl).hostname;
  } catch {
    throw new Error("E00-S04 misconfigured: REDIS_URL is not a valid URL.");
  }
  if (redisHost !== "localhost" && redisHost !== "127.0.0.1" && redisHost !== "::1") {
    throw new Error(
      "E00-S04 refused: REDIS_URL must point at the local disposable Redis " +
        "(localhost). The suite flushes its dedicated Redis DB and never runs " +
        "fault injection against a shared service.",
    );
  }
  return { appUrl, setupUrl, proofDb, redisUrl, redisDb };
}

/** Same connection inputs pointed at a different database name. */
export function withDatabase(connectionString: string, dbName: string): string {
  const u = new URL(connectionString);
  u.pathname = `/${dbName}`;
  return u.toString();
}
