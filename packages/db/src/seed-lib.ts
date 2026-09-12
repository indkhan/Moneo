import { sql } from "drizzle-orm";
import { getDb, closeDb } from "./client.js";
import { currencies } from "./schema.js";
import { CURRENCIES } from "./currencies.js";

/** Idempotent currency seed: upserts the full ISO 4217 dataset. */
export async function seedCurrencies(): Promise<{ upserted: number }> {
  const db = getDb();
  await db
    .insert(currencies)
    .values(CURRENCIES.map((c) => ({ code: c.code, name: c.name, minorDigits: c.minorDigits })))
    .onConflictDoUpdate({
      target: currencies.code,
      set: {
        name: sql`excluded.name`,
        minorDigits: sql`excluded.minor_digits`,
      },
    });
  return { upserted: CURRENCIES.length };
}

export async function seed(): Promise<void> {
  const { upserted } = await seedCurrencies();
  console.log(`seeded ${upserted} currencies`);
  await closeDb();
}
