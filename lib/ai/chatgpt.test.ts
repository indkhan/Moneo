import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chatgptAccessToken, chatgptFetch, chatgptStatus, finalResponse, finishSignIn, setAiSource, signOut, startSignIn, usesChatGPT } from "./chatgpt";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "moneo-chatgpt-"));
  vi.stubEnv("MONEO_DATA_DIR", dir);
  vi.stubEnv("BANK_TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("OPENAI_API_KEY", "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

const idToken = `x.${Buffer.from(JSON.stringify({ email: "owner@example.com" })).toString("base64url")}.y`;
const tokenReply = (scope = "openid chatgpt.tokens.use.direct", expires = 3600) =>
  Response.json({ access_token: "access-1", refresh_token: "refresh-1", id_token: idToken, expires_in: expires, scope });

async function signIn(reply = tokenReply()) {
  const authorize = new URL(await startSignIn(3000));
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(reply);
  await finishSignIn(new URLSearchParams({ state: authorize.searchParams.get("state")!, code: "code-1", client_id: "oaiapp_1" }));
  return { authorize, fetcher };
}

it("registers dynamically on a 127.0.0.1 callback, then exchanges the code with PKCE and the issued client id", async () => {
  const { authorize, fetcher } = await signIn();
  expect(authorize.origin + authorize.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
  expect(authorize.searchParams.get("client_id")).toBe("dynamic_agent_client");
  expect(authorize.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:3000/api/ai/chatgpt/callback");
  expect(authorize.searchParams.get("scope")).toContain("chatgpt.tokens.use.direct");
  const body = new URLSearchParams(String(fetcher.mock.calls[0][1]?.body));
  expect(body.get("client_id")).toBe("oaiapp_1");
  expect(body.get("code_verifier")).toBeTruthy();
  expect(body.get("redirect_uri")).toBe("http://127.0.0.1:3000/api/ai/chatgpt/callback");
  expect(await chatgptStatus()).toEqual({ signedIn: true, email: "owner@example.com", source: "chatgpt" });
  expect(await usesChatGPT()).toBe(true);
  // A returning sign-in reuses the issued client and skips the agent name.
  const again = new URL(await startSignIn(3000));
  expect(again.searchParams.get("client_id")).toBe("oaiapp_1");
  expect(again.searchParams.get("agent_name_hint")).toBeNull();
});

it("rejects a callback with the wrong state and a grant without plan usage", async () => {
  await startSignIn(3000);
  await expect(finishSignIn(new URLSearchParams({ state: "forged", code: "c", client_id: "oaiapp_1" }))).rejects.toThrow("expired");
  await expect(signIn(tokenReply("openid profile"))).rejects.toThrow("plan usage");
  expect((await chatgptStatus()).signedIn).toBe(false);
});

it("lets the owner pick the API key when both are set up, and falls back to it after sign-out", async () => {
  await signIn();
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
  await setAiSource("api_key");
  expect(await usesChatGPT()).toBe(false);
  await setAiSource("chatgpt");
  expect(await usesChatGPT()).toBe(true);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
  await signOut();
  expect(await chatgptStatus()).toMatchObject({ signedIn: false, source: "api_key" });
});

it("refreshes an access token that is about to expire, once for concurrent callers", async () => {
  const { fetcher } = await signIn(tokenReply(undefined, 30));
  fetcher.mockClear().mockResolvedValue(Response.json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }));
  expect(await Promise.all([chatgptAccessToken(), chatgptAccessToken()])).toEqual(["access-2", "access-2"]);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(new URLSearchParams(String(fetcher.mock.calls[0][1]?.body)).get("grant_type")).toBe("refresh_token");
  expect(await chatgptAccessToken()).toBe("access-2");
});

const sse = (...events: object[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

it("sends plan-usage requests as streaming, unstored and without unsupported fields, and returns the final response to non-streaming callers", async () => {
  const { fetcher } = await signIn();
  fetcher.mockClear().mockResolvedValue(sse({ type: "response.output_text.delta", delta: "Hi" }, { type: "response.completed", response: { id: "r1", output: [] } }));
  const response = await chatgptFetch("https://api.openai.com/v1/responses", { method: "POST", headers: { authorization: "Bearer chatgpt" },
    body: JSON.stringify({ model: "gpt-x", input: [], temperature: 0.2, max_output_tokens: 100, store: true }) });
  expect(await response.json()).toEqual({ id: "r1", output: [] });
  const sent = fetcher.mock.calls[0];
  expect(JSON.parse(String(sent[1]?.body))).toEqual({ model: "gpt-x", input: [], store: false, stream: true });
  expect(new Headers(sent[1]?.headers).get("authorization")).toBe("Bearer access-1");
});

it("passes a streaming request's events straight through", async () => {
  await signIn();
  const upstream = sse({ type: "response.completed", response: { id: "r2" } });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(upstream);
  expect(await chatgptFetch("https://api.openai.com/v1/responses", { method: "POST", body: JSON.stringify({ stream: true }) })).toBe(upstream);
});

it("treats a stream without a terminal event as a failure", async () => {
  await expect(finalResponse(sse({ type: "response.output_text.delta", delta: "partial" }).body!)).rejects.toThrow("ended the response early");
});
