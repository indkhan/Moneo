import { describe, expect, it } from "vitest";
import { runBoundedAssistant } from "./bounded-loop.js";

describe("bounded assistant loop", () => {
  it("stops before a model can exceed its tool-call budget", async () => {
    let calls = 0;
    const result = await runBoundedAssistant(
      { maxModelTurns: 3, maxToolCalls: 1, maxWallTimeMs: 1_000, maxResultBytes: 100 },
      async () => ({
        toolCalls: [
          async () => {
            calls++;
            return "one";
          },
          async () => {
            calls++;
            return "two";
          },
        ],
      }),
    );
    expect(result.status).toBe("limit");
    expect(calls).toBe(1);
  });
});
