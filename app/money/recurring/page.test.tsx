import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./detected", () => ({ DetectedPatterns: () => null }));
vi.mock("./occurrences", () => ({ OccurrenceReview: () => null }));
const schedules = [
  { id: "a", name: "Streaming", account_id: "acc", amount_minor: "-1299", currency_code: "EUR", cadence: "monthly", starts_on: "2026-01-20", ends_on: null, schedule_anchor_on: null, source: "recurring_confirmed" },
  { id: "b", name: "Gym", account_id: "acc", amount_minor: "-1000", currency_code: "EUR", cadence: "weekly", starts_on: "2026-10-12", ends_on: null, schedule_anchor_on: null, source: "user" },
  { id: "c", name: "Old plan", account_id: null, amount_minor: "-500", currency_code: "EUR", cadence: "monthly", starts_on: "2025-01-01", ends_on: "2025-06-01", schedule_anchor_on: null, source: "user" },
];
const query = (data: unknown[]) => { const q = { select: () => q, eq: () => q, is: () => q, in: () => q, order: () => q, limit: () => q, then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve) }; return q; };
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "w", locale: "en-US", timezone: "UTC" },
  supabase: { from: (table: string) => query(table === "accounts" ? [{ id: "acc", name: "Checking" }] : schedules) } }) }));

it("lists confirmed schedules by next date with exact monthly totals", async () => {
  vi.useFakeTimers({ now: new Date("2026-10-16T12:00:00Z"), toFake: ["Date"] });
  const { default: RecurringPage } = await import("./page");
  const html = renderToStaticMarkup(await RecurringPage());
  vi.useRealTimers();
  expect(html.indexOf("Gym")).toBeLessThan(html.indexOf("Streaming"));
  expect(html).toContain("2026-10-19");
  expect(html).toContain("2026-10-20");
  expect(html).toContain("Ended");
  // -12.99 + (-10.00 * 52 / 12 = -43.33) per month; ended schedule excluded.
  expect(html).toContain("−EUR 56.32");
  // Next 30 days: one streaming payment and four weekly gym payments (19, 26 Oct; 2, 9 Nov).
  expect(html).toContain("Next 30 days: −EUR 52.99");
});
