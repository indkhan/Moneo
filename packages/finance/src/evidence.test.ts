import { describe, expect, it } from "vitest";
import { resolveEvidenceRef } from "./evidence.js";

describe("evidence references", () => {
  it("resolves filters and contributing rows without exposing excluded ids", () => {
    const result = resolveEvidenceRef("ev_eyJmaWx0ZXJzIjp7ImNhdGVnb3J5IjoiUmVzdGF1cmFudHMifSwiaWRzIjpbIjEiXX0", new Set(["1"]));
    expect(result).toEqual({ filters: { category: "Restaurants" }, transactionIds: ["1"] });
  });
});
