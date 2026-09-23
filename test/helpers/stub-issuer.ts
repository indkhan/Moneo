// Shared synthetic OIDC issuer for deterministic auth/tenancy tests.
// Loopback only, synthetic subs, no network beyond the test process. The
// `login_as` authorize parameter selects the synthetic subject; `setEvil`
// makes discovery report a mismatched issuer for negative tests.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const STUB_CLIENT_ID = "moneo-test-client";
export const STUB_CLIENT_SECRET = "stub-secret";

type StubCode = { challenge: string; clientId: string; redirectUri: string; sub: string; used: boolean };

function stubJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

export type StubIssuer = {
  base: string;
  setEvil: (evil: boolean) => void;
  /** E08-S01 step-up claims mode: ok (fresh auth_time+acr), missing (sub only), stale (1h-old auth_time). */
  setStepUp: (mode: "ok" | "missing" | "stale") => void;
  lastAccessToken: () => string;
  close: () => Promise<void>;
};

export async function startStubIssuer(): Promise<StubIssuer> {
  let base = "";
  let evil = false;
  let stepUp: "ok" | "missing" | "stale" = "ok";
  const codes = new Map<string, StubCode>();
  const accessToSub = new Map<string, string>();
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub.invalid");
    if (url.pathname === "/.well-known/openid-configuration") {
      stubJson(res, 200, {
        issuer: evil ? "http://evil.invalid/realms/moneo" : base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        userinfo_endpoint: `${base}/userinfo`,
      });
      return;
    }
    if (url.pathname === "/authorize") {
      const clientId = url.searchParams.get("client_id");
      const redirectUri = url.searchParams.get("redirect_uri");
      const challenge = url.searchParams.get("code_challenge");
      const method = url.searchParams.get("code_challenge_method");
      const state = url.searchParams.get("state");
      if (clientId !== STUB_CLIENT_ID || !redirectUri?.endsWith("/auth/callback") || !challenge || method !== "S256" || !state) {
        stubJson(res, 400, { error: "invalid_request" });
        return;
      }
      const code = randomBytes(24).toString("base64url");
      codes.set(code, { challenge, clientId, redirectUri, sub: url.searchParams.get("login_as") ?? "synthetic-user-a", used: false });
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", state);
      res.writeHead(302, { Location: back.toString() });
      res.end();
      return;
    }
    if (url.pathname === "/token") {
      const body = new URLSearchParams(await readBody(req));
      const code = body.get("code") ?? "";
      const entry = codes.get(code);
      const verifier = body.get("code_verifier") ?? "";
      const expected = createHash("sha256").update(verifier).digest("base64url");
      if (body.get("grant_type") !== "authorization_code" || !entry || entry.used || entry.challenge !== expected || body.get("client_id") !== entry.clientId || body.get("redirect_uri") !== entry.redirectUri || body.get("client_secret") !== STUB_CLIENT_SECRET) {
        stubJson(res, 400, { error: "invalid_grant" });
        return;
      }
      entry.used = true;
      const access = `stub-access-${randomBytes(16).toString("hex")}`;
      accessToSub.set(access, entry.sub);
      stubJson(res, 200, { access_token: access, token_type: "Bearer", expires_in: 300 });
      return;
    }
    if (url.pathname === "/userinfo") {
      const sub = accessToSub.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      if (!sub) {
        stubJson(res, 401, { error: "invalid_token" });
        return;
      }
      if (stepUp === "missing") {
        stubJson(res, 200, { sub });
        return;
      }
      const nowSec = Math.floor(Date.now() / 1000);
      stubJson(res, 200, { sub, auth_time: stepUp === "stale" ? nowSec - 3600 : nowSec, acr: "1" });
      return;
    }
    stubJson(res, 404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    setEvil: (value: boolean) => {
      evil = value;
    },
    setStepUp: (mode: "ok" | "missing" | "stale") => {
      stepUp = mode;
    },
    lastAccessToken: () => [...accessToSub.keys()].at(-1) ?? "",
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
