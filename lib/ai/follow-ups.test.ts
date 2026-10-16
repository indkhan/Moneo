import { expect, it } from "vitest";
import { chatFollowUps, planInput } from "./follow-ups";

it("puts the model's questions first, then deterministic app actions, at most four", () => {
  const items = chatFollowUps("Why did I spend more in September?", ["finance_investigate"], ["Which merchant grew most?"]);
  expect(items.map(item => item.label)).toEqual(["Which merchant grew most?", "Break this down by merchant", "Compare with the same period last year", "Start a deep review"]);
  expect(items.every(item => item.prompt)).toBe(true);
});

it("links instead of acting, and validates the visible plan", () => {
  expect(chatFollowUps("List my subscriptions", [])).toEqual([{ label: "Review recurring payments", href: "/money/recurring" }, { label: "Let the agent team dig deeper", href: "/ai/agents" }]);
  expect(planInput.safeParse({ steps: ["Compare September with August", "Rank categories by change"] }).success).toBe(true);
  expect(planInput.safeParse({ steps: [] }).success).toBe(false);
  expect(planInput.safeParse({ steps: ["x".repeat(121)] }).success).toBe(false);
});
