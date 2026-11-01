import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ImportPage from "./page";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

it("disables the server-rendered statement picker before its upload handler hydrates", () => {
  const html = renderToStaticMarkup(createElement(ImportPage));
  const picker = html.match(/<input[^>]*aria-label="Financial statement files"[^>]*>/)?.[0];
  expect(picker).toBeDefined();
  expect(picker).toContain("disabled");
});
