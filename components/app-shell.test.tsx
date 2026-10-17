import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { filterCommands, type Command } from "@/components/command-palette";

const path = vi.hoisted(() => ({ current: "/money/transactions" }));
vi.mock("next/navigation", () => ({ usePathname: () => path.current, useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/ai-panel", () => ({ AiPanel: () => <button>Ask Moneo</button> }));
const { AppShell, activeItem } = await import("./app-shell");

it("marks the most specific nav item active", () => {
  expect(activeItem("/")?.label).toBe("Home");
  expect(activeItem("/ai/activity/123")?.label).toBe("Activity");
  expect(activeItem("/ai/evidence/9")?.label).toBe("Chat");
  expect(activeItem("/plan/spending")?.label).toBe("Spending");
  expect(activeItem("/import/abc/review")?.label).toBe("Import");
  expect(activeItem("/planner")).toBeUndefined();
});

it("filters commands by every typed word", () => {
  const command = (label: string, group: string, keywords?: string): Command => ({ id: label, label, group, keywords, run: () => {} });
  const commands = [command("Transactions", "Pages", "Money"), command("Checking", "Accounts", "account transactions"), command("New AI chat", "Actions")];
  expect(filterCommands(commands, "").length).toBe(3);
  expect(filterCommands(commands, "TRANS").map(c => c.id)).toEqual(["Transactions", "Checking"]);
  expect(filterCommands(commands, "account check").map(c => c.id)).toEqual(["Checking"]);
  expect(filterCommands(commands, "zzz")).toEqual([]);
});

it("renders the sectioned desktop and mobile navigation, and skips the frame on login", () => {
  const html = renderToStaticMarkup(<AppShell shell={Promise.resolve(null)}><h1>Page</h1></AppShell>);
  expect(html).toContain('aria-label="Main"');
  expect(html).toContain('aria-label="Main mobile"');
  expect(html).toMatch(/aria-current="page"[^>]*href="\/money\/transactions"/);
  expect(html).toContain("Skip to content");
  path.current = "/login";
  expect(renderToStaticMarkup(<AppShell shell={Promise.resolve(null)}><h1>Page</h1></AppShell>)).toBe("<h1>Page</h1>");
});
