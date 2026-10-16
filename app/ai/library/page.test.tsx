import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Library from "./page";
import { requireWorkspace } from "@/lib/auth";

vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), redirect: vi.fn() }));

it("renders a searchable gallery with pin state, template previews and blank kinds", async () => {
  const rows: Record<string, unknown[]> = {
    artifacts: [{ id: "a1", kind: "custom_tracker", name: "Groceries budget", updated_at: "2026-10-15T10:00:00Z", active_version_id: "v1" },
      { id: "a2", kind: "trip_planner", name: "Lisbon", updated_at: "2026-10-14T10:00:00Z", active_version_id: "v2" }],
    dashboard_items: [{ artifact_id: "a1" }],
    artifact_versions: [{ id: "v1", version: 3, manifest: { kind: "custom_tracker", runtime: "quickjs-calculator-v1", sdk: ["spending"], params: { monthlyBudgetMinor: { type: "number", default: 1, label: "Monthly budget" } } } },
      { id: "v2", version: 1, manifest: { kind: "trip_planner", runtime: "trusted" } }],
  };
  const from = (table: string) => {
    const result = Promise.resolve({ data: rows[table], error: null });
    const query = { select: () => query, eq: () => query, in: () => result, order: () => result, then: result.then.bind(result) };
    return query;
  };
  vi.mocked(requireWorkspace).mockResolvedValue({ supabase: { from }, workspace: { id: "w", display_currency: "EUR", locale: undefined } } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
  const html = renderToStaticMarkup(await Library());
  expect(html).toContain("Groceries budget");
  expect(html).toContain("Unpin Groceries budget from Home");
  expect(html).toContain("Pin Lisbon to Home");
  expect(html).toContain("1 input: Monthly budget");
  expect(html).toContain("host view");
  expect(html).toContain("Search saved tools");
  for (const name of ["Budget tracker", "Trip planner", "Subscription audit", "Savings-rate calculator"]) expect(html).toContain(name);
  // Budget tracker preview ran in QuickJS against synthetic fixtures.
  expect(html).toContain("EUR 700.00");
  expect(html).toMatch(/<label[^>]*for="custom_comparison"[^>]*>Custom Comparison<\/label>/);
});
