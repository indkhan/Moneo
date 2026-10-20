import { describe, expect, it } from "vitest";
import { nextQueued, requeueAfterRun, type QueuedMessage } from "./use-chat-queue";

const item = (id: string, conversationId = "a", steering = false): QueuedMessage => ({ id, conversationId, message: id, steering });

describe("requeueAfterRun", () => {
  it("puts the failed send, then untaken steers, ahead of the waiting queue", () => {
    expect(requeueAfterRun([item("x"), item("s", "a", true), item("y")], item("f")).map(entry => [entry.id, entry.steering]))
      .toEqual([["f", false], ["s", false], ["x", false], ["y", false]]);
  });
  it("keeps order when nothing went back", () => {
    expect(requeueAfterRun([item("x"), item("y")], null).map(entry => entry.id)).toEqual(["x", "y"]);
  });
});

describe("nextQueued", () => {
  it("sends only this conversation's waiting messages", () => {
    expect(nextQueued([item("s", "a", true), item("o", "b"), item("x")], "a")?.id).toBe("x");
    expect(nextQueued([item("o", "b")], "a")).toBeNull();
  });
});
