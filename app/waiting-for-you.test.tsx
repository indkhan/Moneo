import { renderToStaticMarkup } from "react-dom/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
import { openStandaloneProposals } from "@/lib/ai/open-proposals";
import { WaitingForYou } from "./waiting-for-you";

vi.mock("next/link", () => ({ default: "a" }));
vi.mock("@/app/ai/agents/actions", () => ({ decideAgentProposals: vi.fn() }));
vi.mock("@/app/ai/iou-actions", () => ({ loadIouProposal: vi.fn() }));
vi.mock("@/lib/ai/recurring-proposals", () => ({ syncRecurringProposals: async () => undefined }));
vi.mock("@/lib/ai/open-proposals", () => ({ openStandaloneProposals: vi.fn() }));

const render = async () => renderToStaticMarkup(await WaitingForYou({ supabase: {} as SupabaseClient, workspace: { id: "w", timezone: "UTC", locale: "en" } }));

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
  expect(html).toContain("<details open=\"\" aria-label=\"Waiting for you\">");
  expect(html).toContain("Waiting for you · 2");
  expect(html).toContain("aria-label=\"Transaction proposal\"");
  expect(html).toContain("Spent €12.00 · Lunch");
  expect(html).toContain("Wallet");
  expect(html).toContain("aria-label=\"Balance proposal\"");
  expect(html).toContain("Cash is €40.00");
  expect(html).toMatch(/>All<.*>Transactions<.*>Balances</);
  expect(html).not.toContain(">Loans<");
});
