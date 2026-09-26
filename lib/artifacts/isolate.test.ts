import { describe, expect, it } from "vitest";
import { evaluateIsolated } from "./isolate";

describe("QuickJS artifact isolation", () => {
  it("runs bounded code without browser or network globals", async () => {
    expect(await evaluateIsolated("input => input.a + input.b", { a: 2, b: 3 })).toBe(5);
    expect(await evaluateIsolated("() => [typeof window, typeof document, typeof fetch, typeof localStorage]", null))
      .toEqual(["undefined", "undefined", "undefined", "undefined"]);
    await expect(evaluateIsolated("() => { while (true) {} }", null)).rejects.toThrow();
  });
});
