import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is missing. Add it to .env (see .env.example).");
  if (!_db) {
    const client = postgres(url, { prepare: false });
    _db = drizzle(client, { schema });
  }
  return _db;
}
