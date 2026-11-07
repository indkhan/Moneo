import { describe, expect, it, vi } from "vitest";
import type { ScalableMcp } from "@/lib/scalable/client";

// Every Scalable call made through the chat tools is recorded, so the test can prove none of them submits.
const calls: string[] = [];
const mcp = { connect: async () => {}, listTools: async () => [], callTool: vi.fn(async (name: string) => { calls.push(name); return {}; }) } as unknown as ScalableMcp;
vi.mock("@/lib/scalable/server", () => ({ withScalable: (_: string, __: string, work: (client: ScalableMcp) => Promise<unknown>) => work(mcp) }));
const { investmentTools, TRADE_INTENT } = await import("./investment-tools");

const build = (message: string, priorUserText: string[] = []) => investmentTools({ connectionId: "c", message, priorUserText, onCard: () => {},
  evidence: read => read({ workspace: { id: "ws" } } as never), context: async () => ({ workspace: { id: "ws" } }) as never });

describe("Scalable chat tools", () => {
  it("never gives the model a tool that submits or cancels on Scalable", () => {
    const names = Object.keys(build("buy 2 shares of Alphabet and cancel my open order"));
    expect(names.sort()).toEqual(["investments_cancelOrder", "investments_order", "investments_portfolio", "investments_security", "investments_transactions", "investments_watchlist"]);
    expect(names.some(name => /submit|cancel_order|place/.test(name))).toBe(false);
  });

  it("offers order cards only when the user asked to trade, here or just before", () => {
    expect(build("How is my portfolio doing?")).not.toHaveProperty("investments_order");
    expect(build("ok do it, 2 shares", ["Should I buy more silver?"])).toHaveProperty("investments_order");
    expect(TRADE_INTENT.test("Verkaufe meine Alphabet Aktie")).toBe(true);
  });

  it("reads Scalable without ever calling a write tool", async () => {
    calls.length = 0;
    const tools = build("show my portfolio") as unknown as Record<string, { execute: (input: unknown) => Promise<unknown> }>;
    await Promise.allSettled([tools.investments_portfolio.execute({}), tools.investments_transactions.execute({}), tools.investments_watchlist.execute({}),
      tools.investments_security.execute({ action: "search", query: "MSCI World" })]);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some(name => /^(submit|cancel|preview|create|add|remove|upsert)_/.test(name))).toBe(false);
  });
});
