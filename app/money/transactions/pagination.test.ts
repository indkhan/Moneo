import { describe, expect, it } from "vitest";
import { pageWindow } from "./pagination";

describe("ledger page numbers", () => {
  it("keeps five numbers around the current page and shifts at the ends", () => {
    expect(pageWindow(1, 20)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(10, 20)).toEqual([8, 9, 10, 11, 12]);
    expect(pageWindow(20, 20)).toEqual([16, 17, 18, 19, 20]);
    expect(pageWindow(2, 3)).toEqual([1, 2, 3]);
  });
});
