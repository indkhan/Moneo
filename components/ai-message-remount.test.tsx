import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const seen: unknown[] = [];
vi.mock("react-markdown", () => ({ default: ({ components }: { components: Record<string, unknown> }) => { seen.push(components.pre); return null; } }));
const { AiMessage } = await import("./ai-message");

it("keeps the same markdown components between renders, so cards in a reply are not remounted", async () => {
  renderToStaticMarkup(<AiMessage content="One" />);
  renderToStaticMarkup(<AiMessage content="Two" />);
  expect(seen).toHaveLength(2);
  expect(seen[0]).toBe(seen[1]);
});
