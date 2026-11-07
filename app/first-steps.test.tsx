import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FirstSteps } from "./first-steps";

vi.mock("next/link", () => ({ default: "a" }));

it("starts a new workspace with AI, then money, then the agent team", () => {
  const html = renderToStaticMarkup(<FirstSteps ai={false} />);
  const order = ["Turn on AI", "Connect your bank", "Run the agent team"].map(text => html.indexOf(text));
  expect(order.every(index => index >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  for (const href of ['href="/settings#ai-access"', 'href="/settings#banks"', 'href="/import"', 'href="/money/accounts"', 'href="/ai/agents"']) expect(html).toContain(href);
  expect(html).not.toContain("AI is on");
});

it("marks AI as done once it is set up", () => {
  expect(renderToStaticMarkup(<FirstSteps ai />)).toContain("AI is on");
});
