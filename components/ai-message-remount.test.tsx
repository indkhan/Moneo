import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const seen: unknown[] = [];
vi.mock("react-markdown", () => ({ default: ({ components }: { components: Record<string, unknown> }) => { seen.push(components.pre); return null; } }));

// New component functions on each render make React remount everything inside: a tapped card would flash
// "Loading…" and lose its place in the chat whenever the page refreshes.
it("keeps the same markdown components between renders, so cards in a reply are not remounted", async () => {
  const { AiMessage } = await import("./ai-message");
  renderToStaticMarkup(<AiMessage content="One" />);
  renderToStaticMarkup(<AiMessage content="Two" />);
  expect(seen).toHaveLength(2);
  expect(seen[0]).toBe(seen[1]);
});
