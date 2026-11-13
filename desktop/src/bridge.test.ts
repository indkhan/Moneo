import { expect, it, vi } from "vitest";
import { startBridge } from "./bridge";
import type { UpdateStatus } from "./updates";

const status: UpdateStatus = { current: "0.1.0", state: "available", latest: "0.2.0", installs: true };

it("does only what Moneo's server asks, on fixed routes and Moneo's own connection results", async () => {
  const onReturn = vi.fn(async () => {});
  const update = { status: vi.fn(() => status), check: vi.fn(async () => status), install: vi.fn(async () => status) };
  const bridge = await startBridge({ onReturn, update });
  const post = (path: string, headers: Record<string, string> = {}) => fetch(`${bridge.url}/return`, { method: "POST", headers: { "x-moneo-return": path, ...headers } });
  try {
    // Without the launch's secret, or from a web page, nothing happens.
    const base = bridge.url.slice(0, bridge.url.lastIndexOf("/"));
    expect((await fetch(`${base}/guess/update/install`, { method: "POST" })).status).toBe(403);
    expect((await fetch(`${bridge.url}/update/install`, { method: "POST", headers: { origin: "https://example.com" } })).status).toBe(403);
    expect((await post("/import?bank=connected", { origin: "https://example.com" })).status).toBe(403);
    expect((await fetch(`${bridge.url}/update/install`)).status).toBe(404);
    for (const path of ["https://example.com", "//example.com/import?bank=connected", "/import?bank=connected&next=/x", "/settings?chatgpt=a b#ai-access"]) {
      expect((await post(path)).status).toBe(400);
    }
    expect(onReturn).not.toHaveBeenCalled();
    expect(update.install).not.toHaveBeenCalled();

    expect((await post("/import?scalable=connected#scalable")).status).toBe(204);
    expect((await post("/settings?chatgpt=ChatGPT%20sign-in%20failed.#ai-access")).status).toBe(204);
    expect(onReturn).toHaveBeenCalledWith("/import?scalable=connected#scalable");
    onReturn.mockRejectedValueOnce(new Error("window closed"));
    expect((await post("/import?bank=connected")).status).toBe(503);

    expect(await (await fetch(`${bridge.url}/update`)).json()).toEqual(status);
    expect((await fetch(`${bridge.url}/update/install`, { method: "POST" })).status).toBe(200);
    expect(update.install).toHaveBeenCalledTimes(1);
  } finally { bridge.close(); }
});
