import { describe, expect, it } from "vitest";
import { allPages } from "./all-pages";

function table(total: number, grow = 0) {
  const calls: { from: number; to: number; count?: string }[] = [];
  let rows = Array.from({ length: total }, (_, index) => index);
  const page = async (from: number, to: number, count?: "exact") => {
    calls.push({ from, to, count });
    const result = { data: rows.slice(from, to + 1), error: null, count: count ? rows.length : null };
    // Rows added after the count was taken.
    if (grow) { rows = [...rows, ...Array.from({ length: grow }, (_, index) => total + index)]; grow = 0; }
    return result;
  };
  return { page, calls };
}

describe("allPages", () => {
  it("reads one short page with a single request", async () => {
    const { page, calls } = table(3);
    expect(await allPages(page, 5)).toEqual([0, 1, 2]);
    expect(calls).toEqual([{ from: 0, to: 4, count: "exact" }]);
  });

  it("loads the counted pages after the first together, in order", async () => {
    const { page, calls } = table(12);
    expect(await allPages(page, 5)).toEqual(Array.from({ length: 12 }, (_, index) => index));
    expect(calls.map(call => call.from)).toEqual([0, 5, 10]);
    expect(calls.slice(1).every(call => call.count === undefined)).toBe(true);
  });

  it("keeps at most six page reads in flight", async () => {
    let active = 0, peak = 0;
    const rows = Array.from({ length: 100 }, (_, index) => index);
    const page = async (from: number, to: number, count?: "exact") => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      return { data: rows.slice(from, to + 1), error: null, count: count ? rows.length : null };
    };
    expect(await allPages(page, 5)).toEqual(rows);
    expect(peak).toBe(6);
  });

  it("keeps reading while pages come back full, so rows added after the count are kept", async () => {
    const { page } = table(10, 7);
    expect(await allPages(page, 5)).toHaveLength(17);
  });

  it("throws the query error", async () => {
    const failure = new Error("denied");
    await expect(allPages(async () => ({ data: null, error: failure }), 5)).rejects.toBe(failure);
  });
});
