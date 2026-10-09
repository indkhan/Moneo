import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ChatForm } from "./chat-form";
import { AiPanelDialog } from "@/components/ai-panel-dialog";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/money/transactions" }));
it("offers visible removable context controls in full chat", () => {
  const markup = renderToStaticMarkup(<ChatForm conversationId="00000000-0000-4000-8000-000000000001" selectionKey="moneo-conversation-owned" />);
  expect(markup).toContain("Context for this request");
  expect(markup).toContain("Remove earlier dialogue");
  expect(markup).toContain("Remove page context");
});
it("offers the same context controls in the side panel", () => {
  const markup = renderToStaticMarkup(<AiPanelDialog open={false} onClose={() => {}} />);
  expect(markup).toContain("Context for this request");
  expect(markup).toContain("Earlier requests and permitted dialogue");
});
