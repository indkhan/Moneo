import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { loadEnv } from "@moneo/shared/env";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

let pool: Pool | undefined;
let db: Db | undefined;

export function getPool(): Pool {
  if (!pool) {
    const env = loadEnv();
    pool = new Pool({ connectionString: env.DATABASE_URL, max: 10 });
  }
  return pool;
}

export function getDb(): Db {
  if (!db) {
    db = drizzle(getPool(), { schema });
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    db = undefined;
  }
}
