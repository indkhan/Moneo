import { describe, expect, it } from "vitest";
import { QUEUE_NAME } from "./runtime.js";

describe("worker runtime", () => {
  it("declares a stable maintenance queue name", () => {
    expect(QUEUE_NAME).toBe("moneo-maintenance");
  });
});
