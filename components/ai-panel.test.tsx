import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AiPanel } from "./ai-panel";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
const { useChatRequest } = vi.hoisted(() => ({ useChatRequest: vi.fn(() => ({ busy: false, error: "", status: "idle" })) }));
vi.mock("@/lib/ai/use-chat-request", () => ({ useChatRequest }));

it("renders the assistant launcher without mounting the unused chat workspace", () => {
  const html = renderToStaticMarkup(<AiPanel />);
  expect(html).toContain("Ask Moneo");
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("<dialog");
  expect(useChatRequest).not.toHaveBeenCalled();
});
