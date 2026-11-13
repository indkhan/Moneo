import { expect, it, vi } from "vitest";
import { startAuthReturn } from "./auth-return";

it("opens only Moneo's own connection results, and only when its server asks", async () => {
  const open = vi.fn(async () => {});
  const bridge = await startAuthReturn(open);
  const post = (path: string, headers: Record<string, string> = {}) => fetch(bridge.url, { method: "POST", headers: { "x-moneo-return": path, ...headers } });
  try {
    expect((await fetch(bridge.url)).status).toBe(403);
    expect((await fetch(`${bridge.url}x`, { method: "POST", headers: { "x-moneo-return": "/import?bank=connected" } })).status).toBe(403);
    expect((await post("/import?bank=connected", { origin: "https://example.com" })).status).toBe(403);
    for (const path of ["https://example.com", "//example.com/import?bank=connected", "/import?bank=connected&next=/x", "/settings?chatgpt=a b#ai-access"]) {
      expect((await post(path)).status).toBe(400);
    }
    expect(open).not.toHaveBeenCalled();
    expect((await post("/import?scalable=connected#scalable")).status).toBe(204);
    expect((await post("/settings?chatgpt=ChatGPT%20sign-in%20failed.#ai-access")).status).toBe(204);
    expect(open).toHaveBeenCalledWith("/import?scalable=connected#scalable");
    open.mockRejectedValueOnce(new Error("window closed"));
    expect((await post("/import?bank=connected")).status).toBe(503);
  } finally { bridge.close(); }
});
