import { expect, it, vi } from "vitest";
import { listRecurring } from "@/lib/ai/recurring-proposals";

vi.mock("@/app/money/recurring/suggestions", async importOriginal => ({ ...await importOriginal<object>(), loadSuggestions: async () => ({ superseded: [], pending: [{ related: [],
  series: { runAnchorId: "s1", label: "Uni sport", cadence: "monthly", amountMinMinor: -2000n, amountMaxMinor: -1500n, currencyCode: "EUR", occurrences: 3 } }] }) }));

it("gives pending suggestions the same exact fields as schedules, so pages never parse formatted money", async () => {
  const query: Record<string, unknown> = {};
  for (const name of ["select", "eq", "is", "in", "order", "limit", "or", "range"]) query[name] = () => query;
  query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
  const result = await listRecurring({ supabase: { from: () => query }, workspace: { id: "w", timezone: "Europe/Berlin", locale: "en-IE" } } as never);
  expect(result.suggestions[0]).toMatchObject({ amount_min_minor: "-2000", amount_max_minor: "-1500", currency_code: "EUR", direction: "out", occurrences: 3 });
});
