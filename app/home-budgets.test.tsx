import { renderToStaticMarkup } from "react-dom/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
import { HomeBudgets } from "./home-budgets";

vi.mock("next/link", () => ({ default: "a" }));
vi.mock("./insights/panel", () => {
  const row = (id: string, name: string, spent: bigint, allowance: bigint, extra: object = {}) => ({ budget: { id, category_id: id, currency_code: "EUR" }, name,
    progress: { spentMinor: spent, allowanceMinor: allowance, remainingMinor: allowance - spent, carriedMinor: 0n, limitation: null, ...extra } });
  return { loadInsightEvidence: async () => ({}), budgetsThisMonth: () => [
    row("groceries", "Groceries", 41200n, 45000n), row("eating", "Eating out", 19800n, 15000n),
    row("transport", "Transport", 6400n, 15800n, { carriedMinor: 3800n }), row("going", "Going out", 9000n, 20000n),
    { ...row("usd", "Abroad", 100n, 200n), budget: { id: "usd", category_id: "usd", currency_code: "USD" } },
  ] };
});

it("shows spent of allowance with what is left, over or rolled over, in the display currency only", async () => {
  const html = renderToStaticMarkup(await HomeBudgets({ db: {} as SupabaseClient, workspaceId: "w", currency: "EUR", today: "2026-10-25", locale: "en" }));
  for (const text of ["EUR 412.00 / EUR 450.00", "EUR 38.00 left for 7 days", "EUR 48.00 over", "includes EUR 38.00 rolled over from September", "On track", "/plan/spending"]) expect(html).toContain(text);
  expect(html).not.toContain("Abroad");
});
