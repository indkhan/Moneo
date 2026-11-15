import { afterEach, expect, it, vi } from "vitest";
import { createServerClient } from "@supabase/ssr";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({ cookies: async () => ({
  getAll: () => [...jar].map(([name, value]) => ({ name, value })),
  set: (name: string, value: string) => jar.set(name, value),
}) }));
import { requireWorkspace } from "./auth";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); jar.clear(); });

async function session(userStatus: number | "socket") {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54521");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-key");
  const user = { id: `recovery-owner-${userStatus}`, aud: "authenticated", role: "authenticated" };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: user.id, session_id: `recovery-${userStatus}`, exp: Math.floor(Date.now() / 1000) + 3600 })}.${encode("signature")}`;
  let checks = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/token")) return Response.json({ access_token: token, refresh_token: "refresh", expires_in: 3600, token_type: "bearer", user });
    if (url.includes("/user")) {
      if (++checks === 1 || userStatus === 401) {
        if (userStatus === "socket") throw new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } });
        return Response.json({ message: "Unavailable" }, { status: userStatus });
      }
      return Response.json(user);
    }
    if (url.includes("/rest/v1/workspaces")) return Response.json({ id: "workspace", owner_id: user.id, display_currency: "EUR", workspace_settings: null });
    throw new Error("Unexpected test request");
  }));
  const client = createServerClient("http://127.0.0.1:54521", "test-key", { cookies: {
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    setAll: values => values.forEach(({ name, value }) => jar.set(name, value)),
  } });
  await client.auth.signInWithPassword({ email: "qa@example.test", password: "test-only" });
  return () => checks;
}

it.each([503, "socket"] as const)("recovers a signed-in workspace after temporary auth failure %s", async status => {
  await session(status);
  expect((await requireWorkspace()).workspace.id).toBe("workspace");
});

it("does not retry invalid authentication", async () => {
  const checks = await session(401);
  await expect(requireWorkspace()).rejects.toThrow("Unauthorized");
  expect(checks()).toBe(1);
});
