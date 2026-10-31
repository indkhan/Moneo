import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

it("provides an accessible route fallback while workspace data loads", async () => {
  expect(existsSync(new URL("./loading.tsx", import.meta.url))).toBe(true);
  const path = "./loading";
  const { default: Loading } = await import(path);
  const html = renderToStaticMarkup(<Loading />);
  expect(html).toContain('role="status"');
  expect(html).toContain("Loading workspace");
  expect(html).toContain('aria-busy="true"');
});

it.each(["money", "plan", "ai", "ai/agents", "ai/activity", "ai/artifacts", "import"])("shows the fallback when moving between pages under /%s", async section => {
  const path = `./${section}/loading`;
  const { default: Loading } = await import(path);
  expect(renderToStaticMarkup(<Loading />)).toContain("Loading workspace");
});
