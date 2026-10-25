import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatWorkspace } from "./chat-workspace";

const search = vi.hoisted(() => ({ value: "" }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(search.value), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const thread = (id: string, title: string) => ({ id: `00000000-0000-4000-8000-00000000000${id}`, title, created_at: "2026-10-01T00:00:00Z" });
const initial = { threads: [thread("1", "Rent check"), thread("2", "Trip budget")], threadsCursor: "next", selected: thread("1", "Rent check"),
  messages: [{ id: "m1", role: "user", content: "How much rent?", created_at: "2026-10-01T00:00:00Z" }], messagesCursor: "older" };
const render = () => renderToStaticMarkup(<ChatWorkspace initial={initial} newConversationId="00000000-0000-4000-8000-000000000009" selectionKey="key" locale="en-GB" timezone="UTC" scope={null} />);

it("renders the saved chat with client-side paging, search, rename and delete controls", () => {
  search.value = "";
  const html = render();
  expect(html).toContain("<h1 class=\"min-w-0 flex-1 truncate font-display text-2xl font-semibold tracking-tight\">Rent check</h1>");
  expect(html).toContain("How much rent?");
  expect(html).toContain('aria-current="page"');
  expect(html).toContain("Search chats");
  expect(html).toContain("Rename Trip budget");
  expect(html).toContain("Delete Trip budget");
  expect(html).toContain("Older conversations");
  expect(html).toContain("Older messages");
  // The deep review form loads only when opened.
  expect(html).not.toContain("What would you like to investigate?");
});

it("shows an empty new chat when the URL asks for one", () => {
  search.value = "conversation=new";
  const html = render();
  expect(html).toContain("How can I help with your money today?");
  expect(html).not.toContain("How much rent?");
  expect(html).not.toContain('aria-current="page"');
});
