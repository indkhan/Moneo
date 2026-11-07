import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

// Scalable Capital's official MCP server. OAuth 2.1 with dynamic client registration and PKCE
// (public client, no secret); the bearer token then calls MCP tools over Streamable HTTP.
// Hosted redirect URIs must be on Scalable's SaaS allowlist; localhost registers freely.
// SCALABLE_MCP_ORIGIN points browser tests at a local stand-in (e2e/mocks/scalable-mcp.mjs); unset in real use.
const ISSUER = process.env.SCALABLE_MCP_ORIGIN || "https://mcp.scalable.capital";
export const SCALABLE_MCP_URL = `${ISSUER}/mcp`;
const SCOPE = "openid profile offline_access";
const PROTOCOL_VERSION = "2025-06-18";

export class ScalableError extends Error {
  /** `refused` marks an answer from the tool itself: Scalable decided, so nothing was left half-done. */
  constructor(message: string, readonly status: number, readonly expired = false, readonly refused = false) { super(message); }
}

const base64url = (bytes: Buffer) => bytes.toString("base64url");

export function pkcePair() {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

async function json<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const code = z.object({ error: z.string() }).safeParse(body).data?.error;
    throw new ScalableError(`Scalable returned ${response.status}${code ? ` (${code})` : ""}`, response.status, code === "invalid_grant" || response.status === 401);
  }
  return schema.parse(body);
}

export async function registerClient(redirectUri: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`${ISSUER}/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Moneo", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], token_endpoint_auth_method: "none", scope: SCOPE }),
  });
  return (await json(response, z.object({ client_id: z.string().min(1).max(200) }))).client_id;
}

export function authorizeUrl(input: { clientId: string; redirectUri: string; state: string; challenge: string }) {
  const url = new URL(`${ISSUER}/authorize`);
  url.search = new URLSearchParams({ response_type: "code", client_id: input.clientId, redirect_uri: input.redirectUri, scope: SCOPE,
    state: input.state, code_challenge: input.challenge, code_challenge_method: "S256", resource: SCALABLE_MCP_URL }).toString();
  return url.toString();
}

export type ScalableTokens = { accessToken: string; refreshToken: string | null; expiresAt: number };
const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), expires_in: z.number().positive().optional() });

async function token(params: Record<string, string>, fetcher: typeof fetch, previousRefresh: string | null = null): Promise<ScalableTokens> {
  const response = await fetcher(`${ISSUER}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, resource: SCALABLE_MCP_URL }).toString(),
  });
  const body = await json(response, tokenSchema);
  // Without expires_in, assume a short life so the next call refreshes instead of failing.
  return { accessToken: body.access_token, refreshToken: body.refresh_token ?? previousRefresh, expiresAt: Date.now() + (body.expires_in ?? 300) * 1000 };
}

export const exchangeCode = (input: { clientId: string; redirectUri: string; code: string; verifier: string }, fetcher: typeof fetch = fetch) =>
  token({ grant_type: "authorization_code", client_id: input.clientId, redirect_uri: input.redirectUri, code: input.code, code_verifier: input.verifier }, fetcher);

export const refreshTokens = (input: { clientId: string; refreshToken: string }, fetcher: typeof fetch = fetch) =>
  token({ grant_type: "refresh_token", client_id: input.clientId, refresh_token: input.refreshToken }, fetcher, input.refreshToken);

const rpcSchema = z.object({ id: z.union([z.number(), z.string()]).optional(), result: z.unknown().optional(), error: z.object({ message: z.string() }).optional() });

/** The JSON-RPC answer to `id`, from a plain JSON body or a Server-Sent Events stream. */
export function rpcMessage(text: string, contentType: string, id: number) {
  const messages = contentType.includes("text/event-stream")
    ? text.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).filter(Boolean).map(data => JSON.parse(data) as unknown)
    : [JSON.parse(text) as unknown];
  const message = messages.map(item => rpcSchema.safeParse(item).data).find(item => item?.id === id);
  if (!message) throw new ScalableError("Scalable MCP sent no answer", 502);
  if (message.error) throw new ScalableError(`Scalable MCP: ${message.error.message}`, 502);
  return message.result;
}

const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).default([]),
  structuredContent: z.unknown().optional(), isError: z.boolean().optional(),
});

/** Read-only MCP session. Tool results are structured content, or the text content parsed as JSON when possible. */
export function scalableMcp(accessToken: string, fetcher: typeof fetch = fetch) {
  let sessionId: string | null = null, protocol = PROTOCOL_VERSION, nextId = 0;
  async function rpc(method: string, params?: unknown, notification = false) {
    const id = ++nextId;
    const response = await fetcher(SCALABLE_MCP_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream",
        "mcp-protocol-version": protocol, ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
      body: JSON.stringify(notification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params }),
    });
    if (!response.ok) throw new ScalableError(`Scalable MCP returned ${response.status}`, response.status, response.status === 401);
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    if (notification) return undefined;
    return rpcMessage(await response.text(), response.headers.get("content-type") ?? "", id);
  }
  return {
    async connect() {
      const result = z.object({ protocolVersion: z.string() }).parse(await rpc("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "Moneo", version: "1.0.0" } }));
      protocol = result.protocolVersion;
      await rpc("notifications/initialized", undefined, true);
    },
    listTools: async () => z.object({ tools: z.array(z.object({ name: z.string() }).passthrough()) }).parse(await rpc("tools/list", {})).tools,
    async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
      const result = toolResultSchema.parse(await rpc("tools/call", { name, arguments: args }));
      const text = result.content.filter(item => item.type === "text").map(item => item.text ?? "").join("\n");
      if (result.isError) throw new ScalableError(`Scalable tool ${name} failed: ${text.slice(0, 300)}`, 502, false, true);
      if (result.structuredContent !== undefined) return result.structuredContent;
      try { return JSON.parse(text) as unknown; } catch { return text; }
    },
  };
}
export type ScalableMcp = ReturnType<typeof scalableMcp>;
