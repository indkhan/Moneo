import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactChat } from "./artifact-chat";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/ai/chat-form", () => ({ ChatForm: () => null }));
vi.mock("../actions", () => ({ claimFirstPrompt: vi.fn() }));

it("offers older artifact messages only when the saved history has another page", () => {
  const props = { conversationId: "00000000-0000-4000-8000-000000000001", initial: [], running: null };
  expect(renderToStaticMarkup(<ArtifactChat {...props} messagesCursor="older" />)).toContain("Older messages");
  expect(renderToStaticMarkup(<ArtifactChat {...props} messagesCursor={null} />)).not.toContain("Older messages");
});
