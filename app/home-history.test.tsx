import { renderToStaticMarkup } from "react-dom/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
import { HomeHistory } from "./home-history";

vi.mock("next/link", () => ({ default: "a" }));
const db = (tables: Record<string, unknown[]>) => ({ from: (table: string) => {
  const q = { select: () => q, eq: () => q, not: () => q, is: () => q, order: () => q, limit: async () => ({ data: tables[table] ?? [], error: null }) };
  return q;
} }) as unknown as SupabaseClient;
const props = { workspaceId: "w", locale: "en-GB", timeZone: "UTC", names: new Map([["cash", "Cash wallet"]]) };

it("shows the four newest changes from every source, each linking to where it is undone", async () => {
  const html = renderToStaticMarkup(await HomeHistory({ ...props, db: db({
    imports: [{ id: "i", filename: "sparkasse_okt.csv", new_rows: 212, created_at: "2026-10-23T09:00:00Z" }],
    balance_snapshots: [{ id: "b", account_id: "cash", amount_minor: "8500", currency_code: "EUR", created_at: "2026-10-22T09:00:00Z" }],
    wealth_events: [{ id: "x", after: { name: "Old car" }, created_at: "2026-10-01T09:00:00Z" }],
    agent_proposals: [{ id: "a", run_id: "r", title: "Categorized 14 transactions as Groceries", result: { href: "/money/organization?review=v" }, decided_at: "2026-10-26T06:14:00Z" },
      { id: "c", run_id: "r", title: "Confirmed Netflix as a subscription", result: null, decided_at: "2026-10-25T06:14:00Z" }],
  }) }));
  for (const text of ["History", "Every change can be undone.", "Categorized 14 transactions as Groceries", "agent · ", "/money/organization?review=v", "/ai/agents/r",
    "Imported sparkasse_okt.csv · 212 rows", "Set Cash wallet balance to"]) expect(html).toContain(text);
  expect(html).not.toContain("Old car");
});

it("is hidden when nothing has changed yet", async () => {
  expect(await HomeHistory({ ...props, db: db({}) })).toBeNull();
});
