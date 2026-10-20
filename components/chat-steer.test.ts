import { expect, it } from "vitest";
import { applyChatEvent } from "./chat-messages";

it("shows steered messages as user messages in the running exchange", () => {
  const pending = applyChatEvent({ question: "Why did spending rise?", tools: [] }, { type: "steered", messages: ["Only look at groceries"] });
  expect(applyChatEvent(pending, { type: "steered", messages: ["And June"] }).steers).toEqual(["Only look at groceries", "And June"]);
  expect(applyChatEvent(pending, { type: "steered", messages: [] })).toBe(pending);
});
