// E01-S01: minimal app health/version contract. Service-free; binds an
// ephemeral loopback port per run. Asserts exact JSON shape, method handling,
// security headers and that no secret sentinel ever appears in a response.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo, Server } from "node:net";
import { createApp } from "../apps/web/src/server.ts";

let server: Server;
let base = "";

beforeAll(async () => {
  process.env["SENTINEL_SECRET_E01S01"] = "sentinel-value-must-never-leak";
  process.env["APP_RELEASE"] = "test";
  process.env["GIT_SHA"] = "test-sha";
  server = createApp();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  delete process.env["SENTINEL_SECRET_E01S01"];
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

async function bodyText(res: Response): Promise<string> {
  return await res.text();
}

describe("e01-s01 web health slice", () => {
  it("GET /healthz returns exact ok shape with build metadata", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ status: "ok", name: "moneo-web", release: "test", gitSha: "test-sha" });
  });

  it("GET /readyz reports readiness with build check", async () => {
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ready: true,
      checks: { build: "ok" },
      name: "moneo-web",
      release: "test",
      gitSha: "test-sha",
    });
  });

  it("GET /version reports name/release/sha only", async () => {
    const res = await fetch(`${base}/version`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", name: "moneo-web", release: "test", gitSha: "test-sha" });
  });

  it("HEAD /healthz succeeds without a body", async () => {
    const res = await fetch(`${base}/healthz`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("POST to a read endpoint is 405 with an Allow header", async () => {
    const res = await fetch(`${base}/healthz`, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
    expect(await res.json()).toEqual({ error: "method_not_allowed" });
  });

  it("unknown paths are 404 JSON", async () => {
    const res = await fetch(`${base}/no-such-route?x=1`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("security headers are present and no secret sentinel leaks", async () => {
    for (const path of ["/healthz", "/readyz", "/version", "/no-such-route"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(await bodyText(res)).not.toContain("sentinel-value-must-never-leak");
    }
  });

  it("query strings and request bodies do not change the contract", async () => {
    const res = await fetch(`${base}/healthz?token=sentinel-value-must-never-leak`, {
      method: "POST",
      body: "sentinel-value-must-never-leak",
    });
    expect(res.status).toBe(405);
    expect(await bodyText(res)).not.toContain("sentinel-value-must-never-leak");
  });
});
