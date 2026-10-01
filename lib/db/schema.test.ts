import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema";

const tables = Object.values(schema).map((table) => getTableConfig(table as PgTable));
const table = (name: string) => tables.find((item) => item.name === name)!;

describe("Drizzle migration contract", () => {
  it("represents every migrated public table and original column", () => {
    const migrations = readdirSync("supabase/migrations").sort()
      .map((file) => readFileSync(`supabase/migrations/${file}`, "utf8")).join("\n");
    for (const match of migrations.matchAll(/create table public\.(\w+)\s*\(([\s\S]*?)\n\);/g)) {
      expect(table(match[1]), match[1]).toBeDefined();
      const columns = [...match[2].matchAll(/^\s{2}(\w+) (?:uuid|text|bigint|integer|boolean|jsonb|date|timestamptz)\b/gm)]
        .map((column) => column[1]);
      expect(table(match[1]).columns.map((column) => column.name)).toEqual(expect.arrayContaining(columns));
    }
  });

  it("preserves deletion behavior for nullable links and recurring evidence", () => {
    for (const [name, column, action] of [
      ["transactions", "merchant_id", "set null"],
      ["transactions", "transfer_id", "set null"],
      ["transactions", "refund_of_id", "set null"],
      ["recurring_series", "assumption_id", "set null"],
      ["recurring_series_transactions", "series_id", "cascade"],
      ["recurring_series_transactions", "transaction_id", "cascade"],
      ["spending_plans", "category_id", "cascade"],
      ["transaction_views", "workspace_id", "cascade"],
    ]) {
      const fk = table(name).foreignKeys.find((key) => key.reference().columns[0].name === column);
      expect(fk?.onDelete, `${name}.${column}`).toBe(action);
    }
  });

  it("preserves deduplication and safety constraints", () => {
    expect(table("fx_rates").uniqueConstraints.map((constraint) => constraint.name))
      .toContain("fx_rates_workspace_pair_date_unique");
    expect(table("messages").indexes.filter((index) => index.config.unique && index.config.where)
      .map((index) => index.config.name)).toEqual(["messages_request_unique", "messages_reply_unique"]);
    for (const [name, constraint] of [
      ["transactions", "transactions_no_self_transfer"],
      ["transactions", "transactions_no_self_refund"],
      ["recurring_series", "recurring_series_amounts"],
      ["spending_plans", "spending_plans_limit_positive"],
      ["transaction_views", "transaction_views_filters_object"],
    ]) expect(table(name).checks.map((check) => check.name)).toContain(constraint);
  });
});
