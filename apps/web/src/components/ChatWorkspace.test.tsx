import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatWorkspace } from "./ChatWorkspace";

describe("ChatWorkspace", () => {
  it("renders a usable empty conversation with visible context controls", () => {
    const html = renderToStaticMarkup(
      h(ChatWorkspace, { compact: false, initialContext: { pathname: "/money", label: "Money" } }),
    );
    expect(html).toContain("New conversation");
    expect(html).toContain("Money");
    expect(html).toContain("Remove Money context");
    expect(html).toContain("Ask about your finances");
    expect(html).toContain("Send");
  });

  it("keeps the compact panel focused on the active thread", () => {
    const html = renderToStaticMarkup(h(ChatWorkspace, { compact: true }));
    expect(html).toContain('aria-label="Assistant conversation"');
    expect(html).toContain("Open full chat");
  });
});
