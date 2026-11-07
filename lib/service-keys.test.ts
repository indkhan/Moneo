import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { removeServiceKeys, saveServiceKeys, serviceKey, serviceKeyStatus } from "./service-keys";

vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));

let rows: { name: string; value_encrypted: string }[] = [];
beforeEach(() => {
  rows = [];
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://synthetic.invalid");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic");
  vi.stubEnv("BANK_TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.mocked(createClient).mockReturnValue({ from: () => ({
    select: async () => ({ data: rows, error: null }),
    upsert: async (next: typeof rows) => { rows = [...rows.filter(row => !next.some(item => item.name === row.name)), ...next]; return { error: null }; },
    delete: () => ({ in: async (_: string, names: string[]) => { rows = rows.filter(row => !names.includes(row.name)); return { error: null }; } }),
  }) } as never);
});
afterEach(() => { vi.unstubAllEnvs(); });

it("falls back to .env while nothing is stored", async () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-from-env-1234");
  expect(await serviceKey("openai_api_key")).toBe("sk-from-env-1234");
  expect((await serviceKeyStatus()).openai_api_key).toEqual({ source: "env", hint: "1234" });
  expect(await serviceKey("openrouter_api_key")).toBeUndefined();
});

it("prefers the stored key and seals it at rest", async () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-from-env-1234");
  await saveServiceKeys({ openai_api_key: "sk-saved-in-app-9876" });
  expect(rows[0].value_encrypted).toMatch(/^v1:/);
  expect(rows[0].value_encrypted).not.toContain("9876");
  expect(await serviceKey("openai_api_key")).toBe("sk-saved-in-app-9876");
  expect((await serviceKeyStatus()).openai_api_key).toEqual({ source: "app", hint: "9876" });
  await removeServiceKeys(["openai_api_key"]);
  expect(await serviceKey("openai_api_key")).toBe("sk-from-env-1234");
});

it("uses .env when the database is not set up", async () => {
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-env");
  expect(await serviceKey("openrouter_api_key")).toBe("sk-or-env");
  await expect(saveServiceKeys({ openrouter_api_key: "x" })).rejects.toThrow("npm run setup");
});
