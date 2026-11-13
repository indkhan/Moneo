import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { decryptToken, encryptToken } from "@/lib/bank/token-crypto";
import { serviceKey } from "@/lib/service-keys";

// "Sign in with ChatGPT" for open-source, locally hosted apps: the owner's ChatGPT plan pays for
// AI requests instead of an API key. Dynamic client registration with PKCE, no client secret.
// Docs: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
const AUTH = "https://auth.openai.com/api/accounts";
const RESOURCE = "https://api.openai.com/v1";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const file = () => path.join(process.env.MONEO_DATA_DIR ?? path.join(process.cwd(), ".data"), "chatgpt.json");
const AAD = "moneo:chatgpt";

export type AiSource = "chatgpt" | "claude" | "api_key";
const tokensSchema = z.object({ accessToken: z.string(), refreshToken: z.string().nullable(), expiresAt: z.number(), scopes: z.array(z.string()) });
const stateSchema = z.object({
  hostId: z.string().transform(value => z.uuid().safeParse(value).success ? `urn:uuid:${value}` : value),
  // Which one pays when both are set up; the owner picks it in Settings.
  source: z.enum(["chatgpt", "claude", "api_key"]).default("chatgpt"),
  account: z.object({ clientId: z.string(), email: z.string().nullable(), idToken: z.string().nullable(), tokens: tokensSchema }).nullable().default(null),
  pending: z.object({ state: z.string(), verifier: z.string(), redirectUri: z.string(), clientId: z.string(), createdAt: z.number() }).nullable().default(null),
});
type State = z.infer<typeof stateSchema>;
type Tokens = z.infer<typeof tokensSchema>;

export class ChatGPTError extends Error {}

// Tokens are sealed with the app's encryption key, so the file alone does not leak them.
async function load(): Promise<State> {
  try { return stateSchema.parse(JSON.parse(decryptToken(await readFile(file(), "utf8"), AAD))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return stateSchema.parse({ hostId: `urn:uuid:${randomUUID()}` });
    throw error;
  }
}
async function save(state: State) {
  const target = file();
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, encryptToken(JSON.stringify(state), AAD), { mode: 0o600 });
  await rename(temp, target);
}

const tokenResponse = z.object({ access_token: z.string(), refresh_token: z.string().optional(), id_token: z.string().optional(), expires_in: z.number().optional(), scope: z.string().optional() });
async function token(body: Record<string, string>, previous?: Tokens) {
  const response = await fetch(`${AUTH}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...body, resource: RESOURCE }) });
  const parsed = tokenResponse.safeParse(await response.json().catch(() => null));
  if (!response.ok || !parsed.success) throw new ChatGPTError(`ChatGPT sign-in failed (${response.status})`);
  const data = parsed.data;
  const tokens: Tokens = { accessToken: data.access_token, refreshToken: data.refresh_token ?? previous?.refreshToken ?? null,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000, scopes: data.scope ? data.scope.split(" ") : previous?.scopes ?? [] };
  return { tokens, idToken: data.id_token ?? null };
}

// Only shown in Settings; nothing is authorized from it, so the payload is read without verifying.
function emailFrom(idToken: string | null) {
  try { return z.object({ email: z.string() }).parse(JSON.parse(Buffer.from(idToken!.split(".")[1], "base64url").toString())).email; }
  catch { return null; }
}

/** The ChatGPT authorize URL. OpenAI only accepts a 127.0.0.1 loopback callback. */
export async function startSignIn(port: number) {
  const state = await load();
  const verifier = randomBytes(32).toString("base64url"), oauthState = randomUUID();
  const redirectUri = `http://127.0.0.1:${port}/api/ai/chatgpt/callback`;
  const clientId = state.account?.clientId ?? "dynamic_agent_client";
  const url = new URL(`${AUTH}/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId, ext_agent_host_id: state.hostId, response_type: "code", redirect_uri: redirectUri, scope: SCOPE, resource: RESOURCE,
    state: oauthState, nonce: randomUUID(), code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    ...(state.account ? { ...(state.account.idToken ? { id_token_hint: state.account.idToken } : {}), ...(state.account.email ? { login_hint: state.account.email } : {}) } : { agent_name_hint: "Moneo" }),
  }).toString();
  await save({ ...state, pending: { state: oauthState, verifier, redirectUri, clientId, createdAt: Date.now() } });
  return url.toString();
}

export async function finishSignIn(query: URLSearchParams) {
  const state = await load();
  const pending = state.pending;
  if (!pending || query.get("state") !== pending.state || Date.now() - pending.createdAt > 600_000) throw new ChatGPTError("The sign-in expired. Try again.");
  await save({ ...state, pending: null });
  if (query.get("error")) throw new ChatGPTError(query.get("error") === "access_denied" ? "ChatGPT sign-in was cancelled." : "ChatGPT sign-in failed.");
  const issued = query.get("client_id");
  const clientId = pending.clientId === "dynamic_agent_client" ? issued : issued && issued !== pending.clientId ? null : pending.clientId;
  const code = query.get("code");
  if (!clientId || !code) throw new ChatGPTError("ChatGPT did not finish the sign-in. Try again.");
  const { tokens, idToken } = await token({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: pending.verifier, redirect_uri: pending.redirectUri });
  if (!tokens.scopes.includes(PLAN_SCOPE)) throw new ChatGPTError("ChatGPT plan usage wasn't allowed, so Moneo can't use your plan. Sign in again and allow it.");
  await save({ ...state, pending: null, source: "chatgpt", account: { clientId, email: emailFrom(idToken), idToken, tokens } });
}

export async function signOut() {
  const state = await load();
  if (state.account?.tokens.refreshToken) {
    // Best effort; the owner can also disconnect Moneo in ChatGPT settings.
    await fetch(`${AUTH}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: state.account.tokens.refreshToken, token_type_hint: "refresh_token", client_id: state.account.clientId }) }).catch(() => undefined);
  }
  // The registered client id stays with the host id for a later sign-in to the same account.
  await save({ ...state, account: null, source: state.source === "claude" ? "claude" : "api_key" });
}

export async function setAiSource(source: AiSource) {
  await save({ ...(await load()), source });
}

export async function chatgptStatus() {
  const state = await load().catch(() => null);
  return { signedIn: Boolean(state?.account), email: state?.account?.email ?? null, source: state?.source ?? "api_key" };
}

let refreshing: Promise<string> | null = null;
/** A valid access token, refreshed near expiry. Refreshes are serialized because the refresh token rotates. */
export async function chatgptAccessToken(): Promise<string> {
  if (refreshing) return refreshing;
  const account = (await load()).account;
  if (!account) throw new ChatGPTError("Not signed in with ChatGPT");
  if (account.tokens.expiresAt - Date.now() > 120_000) return account.tokens.accessToken;
  refreshing ??= (async () => {
    try {
      // Read again inside the lock: another caller may have just stored a rotated token.
      const account = (await load()).account;
      if (!account) throw new ChatGPTError("Not signed in with ChatGPT");
      if (account.tokens.expiresAt - Date.now() > 120_000) return account.tokens.accessToken;
      if (!account.tokens.refreshToken) throw new ChatGPTError("The ChatGPT sign-in ended. Sign in again in Settings.");
      const { tokens, idToken } = await token({ grant_type: "refresh_token", client_id: account.clientId, refresh_token: account.tokens.refreshToken }, account.tokens);
      await save({ ...(await load()), account: { ...account, idToken: idToken ?? account.idToken, tokens } });
      return tokens.accessToken;
    } finally { refreshing = null; }
  })();
  return refreshing;
}

/**
 * True when AI requests for plain OpenAI model ids should use the ChatGPT plan: unless the owner picked the
 * API key, a signed-in plan pays, including for GPT models mixed in while Claude is the main source.
 */
export async function usesChatGPT() {
  const status = await chatgptStatus();
  return status.signedIn && (status.source !== "api_key" || !(await serviceKey("openai_api_key")));
}

// Plan usage accepts only streaming Responses calls with store: false and without sampling limits.
const UNSUPPORTED = ["background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "previous_response_id", "prompt",
  "prompt_cache_retention", "safety_identifier", "service_tier", "temperature", "top_logprobs", "top_p", "truncation", "user"];

/** fetch for the OpenAI provider: adds the plan token and turns a non-streaming call into a stream it reads to the end. */
export async function chatgptFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${await chatgptAccessToken()}`);
  const url = String(input instanceof Request ? input.url : input);
  if (!url.endsWith("/responses") || typeof init.body !== "string") return fetch(input, { ...init, headers });
  const body = JSON.parse(init.body) as Record<string, unknown>;
  const wantsStream = body.stream === true;
  for (const field of UNSUPPORTED) delete body[field];
  const response = await fetch(input, { ...init, headers, body: JSON.stringify({ ...body, store: false, stream: true }) });
  if (wantsStream || !response.ok || !response.body) return response;
  const final = await finalResponse(response.body);
  return new Response(JSON.stringify(final), { status: 200, headers: { "content-type": "application/json" } });
}

/** The response object from the stream's terminal event (completed, incomplete or failed). */
export async function finalResponse(stream: ReadableStream<Uint8Array>) {
  const reader = stream.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader();
  let buffer = "", last: unknown = null;
  for (;;) {
    const { value, done } = await reader.read();
    buffer += value ?? "";
    const lines = buffer.split(/\r?\n/);
    buffer = done ? "" : lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const event = (() => { try { return JSON.parse(line.slice(5)) as { type?: string; response?: unknown }; } catch { return null; } })();
      if (event?.response && ["response.completed", "response.incomplete", "response.failed"].includes(event.type ?? "")) last = event.response;
    }
    if (done) break;
  }
  if (!last) throw new ChatGPTError("ChatGPT ended the response early");
  return last;
}
