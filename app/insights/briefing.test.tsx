import { renderToStaticMarkup } from "react-dom/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, expect, it, vi } from "vitest";
import { buildSourceCoverage } from "@/lib/finance/source-coverage";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import type { Insight } from "@/lib/finance/insights";
import { WeeklyBriefing } from "./panel";

const fixture = vi.hoisted(() => ({ insights: [] as unknown[], wording: new Map<string, string>() }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock("./actions", () => ({ dismissInsight: "dismiss", dismissInsights: "dismiss-all", muteInsightType: "mute" }));
vi.mock("@/lib/ai/provider", () => ({ getModel: () => ({}), modelIdFor: () => "model" }));
vi.mock("@/lib/ai/briefing", async original => ({ ...await original<typeof import("@/lib/ai/briefing")>(), rephraseFindings: async () => fixture.wording }));
vi.mock("@/lib/finance/insights", async original => ({ ...await original<typeof import("@/lib/finance/insights")>(), buildInsights: () => fixture.insights }));
beforeEach(() => { fixture.insights = []; fixture.wording = new Map(); });

const db = { from: () => {
  const query = { select: () => query, eq: () => query, order: () => query, lte: () => query, gte: () => query, in: () => query,
    range: async () => ({ data: [], error: null }), maybeSingle: async () => ({ data: null, error: null }) };
  return query;
} } as unknown as SupabaseClient;
const props = { db, workspaceId: "w", currency: "EUR", today: "2026-10-25", settings: DEFAULT_SETTINGS, missingInputs: [], wealth: [],
  projection: { input: { events: [] }, available: { status: "unavailable" }, sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-25" }, []) } } as unknown as Parameters<typeof WeeklyBriefing>[0];
const insight = (key: string, type: Insight["type"], title: string, detail: string): Insight => ({ key: key.repeat(64), type, priority: "important", title, detail, href: "/plan", asOf: "2026-10-25",
  sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-25" }, []) });

it("shows big findings in checked AI wording, falling back to the computed text when a number changes", async () => {
  fixture.insights = [
    insight("a", "cash_shortfall", "Forecast cash shortfall", "-€88.00 at the conservative limiting date 2026-11-03. Review confirmed obligations."),
    insight("b", "budget_pressure", "Eating out budget pressure", "€198.00 spent against €150.00 allowance in 2026-10, including supported rollover."),
    insight("c", "upcoming_obligations", "Rent is upcoming", "€1,150.00 confirmed for 2026-11-01."),
  ];
  fixture.wording = new Map([["a".repeat(64), "Your main account dips to -€88.00 around 3 Nov."], ["b".repeat(64), "Eating out is 32% over budget."]]);
  const html = renderToStaticMarkup(await WeeklyBriefing(props));
  for (const text of ["Weekly briefing", "Insight writer · from 2 verified findings", "Your main account dips to -€88.00 around 3 Nov.", "Eating out budget pressure. €198.00 spent against €150.00 allowance in 2026-10, including supported rollover.", "E1 · forecast", "E2 · budget", "Dismiss all", "Mute type"]) expect(html).toContain(text);
  expect(html).not.toContain("32%");
  expect(html).not.toContain("Rent is upcoming");
});

it("is hidden when nothing big happened", async () => {
  fixture.insights = [insight("c", "upcoming_obligations", "Rent is upcoming", "€1,150.00 confirmed for 2026-11-01.")];
  expect(await WeeklyBriefing(props)).toBeNull();
});
