import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CommandPalette } from "./CommandPalette";

describe("CommandPalette", () => {
  it("renders an accessible global search entrypoint", () => {
    const html = renderToStaticMarkup(h(CommandPalette));
    expect(html).toContain("Search or run a command");
    expect(html).toContain("Open command search");
  });
});
