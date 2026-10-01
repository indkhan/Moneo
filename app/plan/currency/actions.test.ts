import { afterEach, expect, it, vi } from "vitest";
import { addFxRate } from "./actions";
const insert = vi.hoisted(() => vi.fn(async () => ({ error: null })));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "workspace", timezone: "Europe/Berlin" }, supabase: { from: () => ({ insert }) } }) }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("REDIRECT"); } }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
it("accepts today's FX evidence at the Berlin midnight boundary and rejects tomorrow", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-30T22:30:00Z"));
  const form = new FormData();
  for (const [name, value] of Object.entries({ from: "EUR", to: "USD", rate: "1.1", rateDate: "2026-10-01", source: "manual" })) form.set(name, value);
  await expect(addFxRate(form)).rejects.toThrow("REDIRECT");
  expect(insert).toHaveBeenCalledWith(expect.objectContaining({ rate_date: "2026-10-01" }));
  form.set("rateDate", "2026-10-02");
  await expect(addFxRate(form)).rejects.toThrow("Rate date cannot be in the future");
  expect(insert).toHaveBeenCalledOnce();
});
