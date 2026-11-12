import { expect, it } from "vitest";
import { investigationCode } from "./investigation-code";

it("calculates exact money beyond Number precision without exposing host capabilities", async () => {
  expect(await investigationCode('return { total: BigInt(data.cost) + 2n, host: [typeof process, typeof require, typeof fetch] };', { cost: "9007199254740993" }))
    .toEqual({ total: "9007199254740995", host: ["undefined", "undefined", "undefined"] });
  await expect(investigationCode("while(true) {}", {})).rejects.toThrow();
  await expect(investigationCode("return new Array(100000000).fill('x');", {})).rejects.toThrow();
  await investigationCode("globalThis.previous = 'private'; return true;", {});
  expect(await investigationCode("return typeof previous;", {})).toBe("undefined");
});
