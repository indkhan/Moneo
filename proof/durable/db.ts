// E00-S04 proof database lifecycle. The suite owns one disposable database;
// setup (CREATE DATABASE) uses the CREATEDB-capable setup URL, while every
// proof read/write uses the least-privilege app URL pointed at the proof DB.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { withDatabase, type ProofEnv } from "./env.ts";

export function proofPool(env: ProofEnv): Pool {
  return new Pool({ connectionString: withDatabase(env.appUrl, env.proofDb) });
}

/** Create the disposable proof database when absent, owned by the app role. */
export async function ensureProofDatabase(env: ProofEnv): Promise<"created" | "exists"> {
  // Identifiers cannot be parameters; proofDb defaults to a constant and any
  // override is strict-checked here before any server contact.
  if (!/^[a-z_][a-z0-9_]{0,40}$/.test(env.proofDb)) {
    throw new Error("E00-S04 refused: DURABLE_PROOF_DB must match [a-z_][a-z0-9_]{0,40}.");
  }
  // Never let an override point the suite at a shared database: the suite
  // truncates its tables, so it must own the database it touches.
  const appDb = new URL(env.appUrl).pathname.replace("/", "");
  if (env.proofDb === appDb || ["postgres", "template0", "template1"].includes(env.proofDb)) {
    throw new Error(
      "E00-S04 refused: DURABLE_PROOF_DB must be a dedicated disposable database, " +
        "not the app, postgres or template database (name only; never commit values).",
    );
  }
  const appUser = decodeURIComponent(new URL(env.appUrl).username);
  const setup = new Pool({ connectionString: env.setupUrl, connectionTimeoutMillis: 8000 });
  try {
    const found = await setup.query("SELECT 1 FROM pg_database WHERE datname = $1", [env.proofDb]);
    if (found.rowCount === 1) return "exists";
    if (!/^[A-Za-z_][A-Za-z0-9_@$]*$/.test(appUser)) {
      throw new Error("E00-S04 refused: app-role username is not a safe SQL identifier.");
    }
    await setup.query(`CREATE DATABASE "${env.proofDb}" OWNER "${appUser}"`);
    return "created";
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "42501") {
      throw new Error(
        "E00-S04 prerequisite missing: the setup connection cannot CREATE DATABASE. " +
          "Set DATABASE_MIGRATION_URL to a local CREATEDB-capable URL (name only; never commit values).",
      );
    }
    throw e;
  } finally {
    await setup.end();
  }
}

export async function migrate(pool: Pool): Promise<void> {
  const sql = readFileSync(join(process.cwd(), "proof", "durable", "schema.sql"), "utf8");
  await pool.query(sql);
}

/** Cleanup is limited to the proof tables in the proof database. */
export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(
    "TRUNCATE proof_attempts, proof_effects, proof_provider_results, proof_counters, proof_jobs, proof_outbox, proof_commands",
  );
}
