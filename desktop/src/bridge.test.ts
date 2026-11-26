import { expect, it, vi } from "vitest";
import { startBridge } from "./bridge";
import type { UpdateStatus } from "./updates";

const status: UpdateStatus = { current: "0.1.0", state: "available", latest: "0.2.0", installs: true };

it("does only what Moneo's server asks, on fixed routes and Moneo's own connection results", async () => {
  const onReturn = vi.fn(async () => {});
  const update = { status: vi.fn(() => status), check: vi.fn(async () => status), install: vi.fn(async () => status) };
  const chooseFolder = vi.fn(async () => "/Users/owner/Models/whisper-small");
  const render = vi.fn(async () => ({ png: "", result: [] }));
  const bridge = await startBridge({ onReturn, update, chooseFolder, render });
  const post = (path: string, headers: Record<string, string> = {}) => fetch(`${bridge.url}/return`, { method: "POST", headers: { "x-moneo-return": path, ...headers } });
  try {
    const base = bridge.url.slice(0, bridge.url.lastIndexOf("/"));
    expect((await fetch(`${base}/guess/update/install`, { method: "POST" })).status).toBe(403);
    expect((await fetch(`${bridge.url}/update/install`, { method: "POST", headers: { origin: "https://example.com" } })).status).toBe(403);
    expect((await post("/money/accounts?bank=connected#connected", { origin: "https://example.com" })).status).toBe(403);
    expect((await fetch(`${bridge.url}/update/install`)).status).toBe(404);
    for (const path of ["https://example.com", "//example.com/money/accounts?bank=connected#connected", "/money/accounts?bank=connected&next=/x#connected", "/import?bank=connected", "/settings?chatgpt=a b#ai-access"]) {
      expect((await post(path)).status).toBe(400);
    }
    expect(onReturn).not.toHaveBeenCalled();
    expect(update.install).not.toHaveBeenCalled();

    expect((await post("/money/accounts?scalable=connected#scalable")).status).toBe(204);
    expect((await post("/settings?chatgpt=ChatGPT%20sign-in%20failed.#ai-access")).status).toBe(204);
    expect(onReturn).toHaveBeenCalledWith("/money/accounts?scalable=connected#scalable");
    onReturn.mockRejectedValueOnce(new Error("window closed"));
    expect((await post("/money/accounts?bank=connected#connected")).status).toBe(503);

    expect(await (await fetch(`${bridge.url}/update`)).json()).toEqual(status);
    expect((await fetch(`${bridge.url}/update/install`, { method: "POST" })).status).toBe(200);
    expect(update.install).toHaveBeenCalledTimes(1);

    expect((await fetch(`${bridge.url}/choose-folder`)).status).toBe(404);
    expect((await fetch(`${bridge.url}/choose-folder`, { method: "POST", headers: { origin: "https://example.com" } })).status).toBe(403);
    expect(chooseFolder).not.toHaveBeenCalled();
    expect(await (await fetch(`${bridge.url}/choose-folder`, { method: "POST" })).json()).toEqual({ path: "/Users/owner/Models/whisper-small" });

    const draft = { path: "/ai/artifacts/aaa2a1ea-8dcf-4adf-9c03-df0ecb5dca2a/draft-card?d=abc&size=M&theme=dark", width: 560, height: 300, full: false, script: "1" };
    const shoot = (body: object) => fetch(`${bridge.url}/render`, { method: "POST", body: JSON.stringify(body) });
    for (const path of ["https://example.com/", "/settings", "/ai/artifacts/aaa2a1ea-8dcf-4adf-9c03-df0ecb5dca2a/frame?v=1", "//example.com/ai/artifacts/aaa2a1ea-8dcf-4adf-9c03-df0ecb5dca2a/draft?d=a"])
      expect((await shoot({ ...draft, path })).status, path).toBe(400);
    expect(render).not.toHaveBeenCalled();
    expect((await shoot(draft)).status).toBe(200);
    expect(render).toHaveBeenCalledWith(draft);
  } finally { bridge.close(); }
});
