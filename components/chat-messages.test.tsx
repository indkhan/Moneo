import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMessages, applyChatEvent } from "./chat-messages";

vi.mock("next/dynamic", () => ({ default: () => ({ content }: { content: string }) => <p>{content}</p> }));

it("shows the investigation plan while tools run and one-click next steps after the answer", () => {
  const pending = applyChatEvent({ question: "Why did I spend more in September?", tools: [] }, { type: "plan", steps: ["Compare September with August", "Rank categories by change"] });
  const live = renderToStaticMarkup(<ChatMessages messages={[]} pending={applyChatEvent(pending, { type: "tool", id: "1", name: "finance_investigate", state: "running" })} />);
  expect(live).toContain("Investigation plan");
  expect(live).toContain("Rank categories by change");
  expect(live).toContain("Investigate transactions");
  const done = renderToStaticMarkup(<ChatMessages messages={[{ id: "a", role: "assistant", content: "Dining rose EUR 84.00.", created_at: "t",
    followUps: [{ label: "Break this down by merchant", prompt: "…" }, { label: "Let the agent team dig deeper", href: "/ai/agents" }] }]} />);
  expect(done).toContain("Break this down by merchant</button>");
  expect(done).toContain('href="/ai/agents"');
});

it("renders streamed answer text progressively and only shows saving once the answer is final", () => {
  let pending = applyChatEvent({ question: "Spending?", tools: [] }, { type: "delta", text: "You spent " });
  pending = applyChatEvent(pending, { type: "delta", text: "**EUR 12.00**" });
  const streaming = renderToStaticMarkup(<ChatMessages messages={[]} pending={pending} />);
  expect(streaming).toContain("You spent **EUR 12.00**");
  expect(streaming).not.toContain("Saving to history");
  expect(renderToStaticMarkup(<ChatMessages messages={[]} pending={applyChatEvent(pending, { type: "answer", answer: "You spent **EUR 12.00**" })} />)).toContain("Saving to history");
});
