import { sql } from "drizzle-orm";
import { systemCategories } from "./schema.js";
import type { CommandStoreDb } from "./command-store.js";

/**
 * Issue 5.1 — global system category taxonomy.
 *
 * Workspace categories (Issue 5.3) optionally root in one of these rows via
 * `categories.system_category_code`. The list is global reference data like
 * `currencies`: seeded idempotently (upsert by code), readable by the app
 * role, never tenant-scoped. Workspaces remain free to create their own
 * categories without any system root.
 */

export interface SystemCategorySeed {
  code: string;
  name: string;
  kind: "expense" | "income" | "transfer";
  sortOrder: number;
}

export const SYSTEM_CATEGORIES: readonly SystemCategorySeed[] = [
  { code: "groceries", name: "Groceries", kind: "expense", sortOrder: 10 },
  { code: "dining", name: "Dining & Cafés", kind: "expense", sortOrder: 20 },
  { code: "transport", name: "Transport", kind: "expense", sortOrder: 30 },
  { code: "housing", name: "Housing & Rent", kind: "expense", sortOrder: 40 },
  { code: "utilities", name: "Utilities", kind: "expense", sortOrder: 50 },
  { code: "health", name: "Health", kind: "expense", sortOrder: 60 },
  { code: "entertainment", name: "Entertainment", kind: "expense", sortOrder: 70 },
  { code: "shopping", name: "Shopping", kind: "expense", sortOrder: 80 },
  { code: "travel", name: "Travel", kind: "expense", sortOrder: 90 },
  { code: "education", name: "Education", kind: "expense", sortOrder: 100 },
  { code: "gifts", name: "Gifts & Donations", kind: "expense", sortOrder: 110 },
  { code: "pets", name: "Pets", kind: "expense", sortOrder: 120 },
  { code: "fees", name: "Fees & Charges", kind: "expense", sortOrder: 130 },
  { code: "income-salary", name: "Salary & Wages", kind: "income", sortOrder: 200 },
  { code: "income-other", name: "Other Income", kind: "income", sortOrder: 210 },
  { code: "savings", name: "Savings & Investments", kind: "transfer", sortOrder: 300 },
  { code: "transfer", name: "Transfers", kind: "transfer", sortOrder: 310 },
  { code: "other", name: "Other", kind: "expense", sortOrder: 900 },
];

/** Idempotent taxonomy seed: re-running updates names/kinds in place, never duplicates. */
export async function seedSystemCategories(db: CommandStoreDb): Promise<{ upserted: number }> {
  await db
    .insert(systemCategories)
    .values(
      SYSTEM_CATEGORIES.map((c) => ({
        code: c.code,
        name: c.name,
        kind: c.kind,
        sortOrder: c.sortOrder,
      })),
    )
    .onConflictDoUpdate({
      target: systemCategories.code,
      set: {
        name: sql`excluded.name`,
        kind: sql`excluded.kind`,
        sortOrder: sql`excluded.sort_order`,
      },
    });
  return { upserted: SYSTEM_CATEGORIES.length };
}
