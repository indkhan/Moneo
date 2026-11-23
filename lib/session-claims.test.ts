import { createHmac } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { sessionClaims } from "./session-claims";

const SECRET = "test-jwt-secret-with-at-least-32-characters";
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

function token(claims: object, secret = SECRET, alg = "HS256") {
  const unsigned = `${encode({ alg, typ: "JWT" })}.${encode(claims)}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}

const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

function authWith(accessToken: string | null) {
  return {
    getSession: vi.fn(async () => ({ data: { session: accessToken ? { access_token: accessToken } : null }, error: null })),
    getClaims: vi.fn(async () => ({ data: { claims: { sub: "from-auth-server" } }, error: null })),
  } as unknown as Parameters<typeof sessionClaims>[0] & { getClaims: ReturnType<typeof vi.fn> };
}

beforeEach(() => { process.env.JWT_SECRET = SECRET; });

it("trusts a session token signed with the backend's secret without asking Supabase Auth", async () => {
  const auth = authWith(token({ sub: "owner", session_id: "s1", exp: inAnHour() }));
  const { claims } = await sessionClaims(auth);
  expect(claims).toMatchObject({ sub: "owner", session_id: "s1" });
  expect(auth.getClaims).not.toHaveBeenCalled();
});

it.each([
  ["signed with another secret", token({ sub: "intruder", exp: inAnHour() }, "another-secret-another-secret-another")],
  ["expired", token({ sub: "owner", exp: Math.floor(Date.now() / 1000) - 1 })],
  ["claiming a different algorithm", token({ sub: "intruder", exp: inAnHour() }, SECRET, "none")],
  ["with a payload changed after signing", (() => { const [h, , s] = token({ sub: "owner", exp: inAnHour() }).split("."); return `${h}.${encode({ sub: "intruder", exp: inAnHour() })}.${s}`; })()],
])("leaves a token %s to Supabase Auth", async (_case, accessToken) => {
  const auth = authWith(accessToken);
  const { claims } = await sessionClaims(auth);
  expect(claims?.sub).toBe("from-auth-server");
  expect(auth.getClaims).toHaveBeenCalledOnce();
});

it("asks Supabase Auth when the secret is not configured", async () => {
  delete process.env.JWT_SECRET;
  const auth = authWith(token({ sub: "owner", exp: inAnHour() }));
  await sessionClaims(auth);
  expect(auth.getClaims).toHaveBeenCalledOnce();
});
