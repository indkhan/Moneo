import { renderToStaticMarkup } from "react-dom/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
import { openStandaloneProposals } from "@/lib/ai/open-proposals";
import { syncRecurringProposals } from "@/lib/ai/recurring-proposals";
import { RecurringDetection, WaitingForYou, loadWaitingForYou } from "./waiting-for-you";

vi.mock("next/link", () => ({ default: "a" }));
vi.mock("@/app/ai/agents/actions", () => ({ decideAgentProposals: vi.fn() }));
vi.mock("@/app/ai/iou-actions", () => ({ loadIouProposal: vi.fn() }));
vi.mock("./home-review-actions", () => ({ loadUncategorizedGroups: vi.fn(), categorizeGroups: vi.fn() }));
vi.mock("@/lib/ai/recurring-proposals", () => ({ syncRecurringProposals: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/ai/open-proposals", () => ({ openStandaloneProposals: vi.fn() }));

const render = async () => renderToStaticMarkup(WaitingForYou({ proposals: await loadWaitingForYou({} as SupabaseClient, { id: "w", timezone: "UTC", locale: "en" }) }));

it("is hidden when nothing is waiting", async () => {
  vi.mocked(openStandaloneProposals).mockResolvedValue([]);
  expect(await render()).toBe("");
});

it("lists transaction and balance cards with their count, open and filterable", async () => {
  vi.mocked(openStandaloneProposals).mockResolvedValue([
    { id: "t", kind: "transaction_create", title: "Spent €12.00 · Lunch", detail: "Today", status: "proposed", accounts: [{ id: "a", name: "Wallet" }], selected: "a", needsCash: false },
    { id: "b", kind: "balance_set", title: "Cash is €40.00", detail: "", status: "failed" },
  ]);
  const html = await render();
  expect(html).toMatch(/<details open="" aria-label="Waiting for you"/);
  expect(html).toMatch(/Waiting for you<\/span><span[^>]*>2<\/span>/);
  expect(html).toContain("aria-label=\"Transaction proposal\"");
  expect(html).toContain("Spent €12.00 · Lunch");
  expect(html).toContain("Wallet");
  expect(html).toContain("aria-label=\"Balance proposal\"");
  expect(html).toContain("Cash is €40.00");
  expect(html).toMatch(/>All<.*>Transactions<.*>Balances</);
  expect(html).not.toContain(">Loans<");
});

it("lists stored cards without running detection", async () => {
  vi.mocked(syncRecurringProposals).mockClear();
  vi.mocked(openStandaloneProposals).mockResolvedValue([]);
  await render();
  expect(syncRecurringProposals).not.toHaveBeenCalled();
});

it("asks the page to reload only when detection changed a card", async () => {
  const detect = (changed: boolean) => { vi.mocked(syncRecurringProposals).mockResolvedValue(changed); return RecurringDetection({ supabase: { id: `s${changed}` } as unknown as SupabaseClient, workspace: { id: `w${changed}`, timezone: "UTC", locale: "en" } }); };
  expect(await detect(false)).toBeNull();
  expect(await detect(true)).not.toBeNull();
});

it("folds recurring cards, uncategorized rows and findings into one summary card each", () => {
  const html = renderToStaticMarkup(WaitingForYou({
    proposals: [{ id: "r1", kind: "recurring_edit", title: "Gym: €30.00 monthly, confirm as recurring?", detail: "", status: "proposed" },
      { id: "r2", kind: "recurring_edit", title: "Rent went up", detail: "", status: "proposed" }, { id: "b", kind: "balance_set", title: "Cash is €40.00", detail: "", status: "proposed" }],
    review: { uncategorized: 310, findings: [{ ids: ["f1", "f2"], title: "Possible duplicate", detail: "", href: null, transactions: [] }] },
  }));
  expect(html).toMatch(/Waiting for you<\/span><span[^>]*>314<\/span>/);
  expect(html).toContain("310 transactions need a category");
  expect(html).toContain("2 recurring changes to confirm");
  expect(html).toContain("1 thing looks off");
  expect(html).toContain("Cash is €40.00");
  expect(html).not.toContain("Gym: €30.00");
});

it("shows summary cards even when no single card waits", () => {
  expect(renderToStaticMarkup(WaitingForYou({ proposals: [], review: { uncategorized: 0, findings: [] } }))).toBe("");
  expect(renderToStaticMarkup(WaitingForYou({ proposals: [], review: { uncategorized: 1, findings: [] } }))).toContain("1 transaction needs a category");
});
