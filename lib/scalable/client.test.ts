import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { authorizeUrl, exchangeCode, pkcePair, refreshTokens, rpcMessage, SCALABLE_MCP_URL, scalableMcp, ScalableError } from "./client";

const reply = (body: unknown, init: ResponseInit & { headers?: Record<string, string> } = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, ...init, headers: { "content-type": "application/json", ...init.headers } });

describe("Scalable OAuth", () => {
  it("makes an S256 PKCE pair", () => {
    const { verifier, challenge } = pkcePair();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("asks for offline access to the MCP resource", () => {
    const url = new URL(authorizeUrl({ clientId: "c1", redirectUri: "http://localhost:3000/api/scalable/callback", state: "s", challenge: "x" }));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: "c1", code_challenge_method: "S256", resource: SCALABLE_MCP_URL, state: "s" });
    expect(url.searchParams.get("scope")).toContain("offline_access");
  });

  it("exchanges a code and keeps the old refresh token when none is rotated", async () => {
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => reply({ access_token: "a1", refresh_token: "r1", expires_in: 600 }));
    const tokens = await exchangeCode({ clientId: "c1", redirectUri: "http://x/cb", code: "code", verifier: "v" }, fetcher as never);
    expect(tokens).toMatchObject({ accessToken: "a1", refreshToken: "r1" });
    expect(String(fetcher.mock.calls[0][1].body)).toContain("code_verifier=v");
    const refreshed = await refreshTokens({ clientId: "c1", refreshToken: "r1" }, (async () => reply({ access_token: "a2" })) as never);
    expect(refreshed).toMatchObject({ accessToken: "a2", refreshToken: "r1" });
  });

  it("marks a rejected refresh as expired", async () => {
    const error = await refreshTokens({ clientId: "c1", refreshToken: "r1" }, (async () => reply({ error: "invalid_grant" }, { status: 400 })) as never).catch(failure => failure);
    expect(error).toBeInstanceOf(ScalableError);
    expect(error.expired).toBe(true);
  });
});

describe("Scalable MCP", () => {
  it("reads the matching answer from an event stream", () => {
    const text = `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n`;
    expect(rpcMessage(text, "text/event-stream", 2)).toEqual({ ok: true });
  });

  it("initializes, keeps the session id and parses tool results", async () => {
    const seen: Record<string, string>[] = [];
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      const body = JSON.parse(String(init.body));
      if (body.method === "initialize") return reply({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }, { headers: { "mcp-session-id": "sess" } });
      if (!body.id) return new Response(null, { status: 202 });
      if (body.params.name === "structured") return reply({ jsonrpc: "2.0", id: body.id, result: { content: [], structuredContent: { value: 1 } } });
      if (body.params.name === "broken") return reply({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "no" }], isError: true } });
      return reply({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "{\"cash\":5}" }] } });
    });
    const mcp = scalableMcp("token", fetcher as never);
    await mcp.connect();
    expect(await mcp.callTool("structured")).toEqual({ value: 1 });
    expect(await mcp.callTool("text")).toEqual({ cash: 5 });
    await expect(mcp.callTool("broken")).rejects.toThrow("Scalable tool broken failed");
    expect(seen.at(-1)).toMatchObject({ authorization: "Bearer token", "mcp-session-id": "sess" });
  });

  it("treats 401 as an ended login", async () => {
    const error = await scalableMcp("t", (async () => new Response("", { status: 401 })) as never).connect().catch(failure => failure);
    expect(error.expired).toBe(true);
  });
});
