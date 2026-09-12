import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { fileURLToPath } from "node:url";
import { loadEnv } from "@moneo/shared/env";

/**
 * Release-time migration runner. Uses DATABASE_MIGRATION_URL (falls back to
 * DATABASE_URL locally). NEVER runs from ordinary app boot — only from the
 * release pipeline (`pnpm db:migrate`) or explicit local invocation.
 */
export async function runMigrations(): Promise<void> {
  const env = loadEnv();
  const url = env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL;
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
  } finally {
    await client.end();
  }
}
