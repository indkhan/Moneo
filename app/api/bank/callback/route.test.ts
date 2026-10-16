import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { start } from "workflow/api";
import { requireWorkspace } from "@/lib/auth";
import { enableBankingClient } from "@/lib/bank/enable-banking";
import { serviceDb } from "@/lib/bank/server";
import { decryptToken } from "@/lib/bank/token-crypto";
import { GET } from "./route";

vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/workflows/bank-sync", () => ({ syncBankConnection: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("@/lib/bank/enable-banking", () => ({ enableBankingClient: vi.fn() }));
vi.mock("@/lib/bank/server", async original => ({ ...await original<typeof import("@/lib/bank/server")>(), serviceDb: vi.fn() }));

const state = "6f1c1f8e-4c39-4b55-8a3e-0c7a9d1b2c3d";
const connectionId = "0b8f6c1e-2d3a-4e5f-9a8b-7c6d5e4f3a2b";
let pending: { id: string; aspsp_name: string; created_at: string } | null;
const updates: Record<string, unknown>[] = [];
const inserts: unknown[] = [];

beforeEach(() => {
  vi.stubEnv("BANK_TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  pending = { id: connectionId, aspsp_name: "Revolut", created_at: new Date().toISOString() };
  updates.length = 0; inserts.length = 0;
  vi.mocked(requireWorkspace).mockResolvedValue({ workspace: { id: "ws-1" } } as never);
  const query = () => {
    const filters: unknown[][] = [];
    const builder = {
      select: () => builder, in: () => builder, neq: () => builder,
      eq: (...args: unknown[]) => { filters.push(args); return builder; },
      maybeSingle: async () => ({ data: filters.some(([column, value]) => column === "auth_state" && value === state) ? pending : null, error: null }),
      single: async () => ({ data: { id: connectionId }, error: null }),
      insert: async (rows: unknown) => { inserts.push(rows); return { error: null }; },
      update: (values: Record<string, unknown>) => { updates.push(values); return builder; },
      then: (resolve: (value: unknown) => void) => resolve({ error: null }),
    };
    return builder;
  };
  vi.mocked(serviceDb).mockReturnValue({ from: query } as never);
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

const callback = (query: string) => GET(new Request(`http://localhost:3000/api/bank/callback?${query}`));

it("rejects an unknown, malformed or stale state without touching the bank", async () => {
  for (const query of ["code=c&state=not-a-uuid", "code=c&state=11111111-2222-4333-8444-555555555555"]) {
    const response = await callback(query);
    expect(response.headers.get("location")).toBe("http://localhost:3000/import?bank=invalid");
  }
  pending = { ...pending!, created_at: new Date(Date.now() - 2 * 3_600_000).toISOString() };
  expect((await callback(`code=c&state=${state}`)).headers.get("location")).toContain("bank=invalid");
  expect(enableBankingClient).not.toHaveBeenCalled();
});

it("marks a cancelled consent as an error", async () => {
  expect((await callback(`error=access_denied&state=${state}`)).headers.get("location")).toContain("bank=error");
  expect(updates).toEqual([{ status: "error", last_error: "The bank returned access_denied" }]);
});

it("stores the session encrypted, links accounts and starts the first sync", async () => {
  const createSession = vi.fn().mockResolvedValue({ session_id: "secret-session", aspsp: { name: "Revolut", country: "DE" },
    access: { valid_until: "2027-04-14T00:00:00+00:00" }, accounts: [{ uid: "u1", currency: "EUR", account_id: { iban: "DE89 3704 0044 0532 0130 00" } }] });
  vi.mocked(enableBankingClient).mockReturnValue({ createSession } as never);
  expect((await callback(`code=abc&state=${state}`)).headers.get("location")).toContain("bank=connected");
  expect(createSession).toHaveBeenCalledWith("abc", expect.objectContaining({ ip: "127.0.0.1" }));
  expect(inserts).toEqual([[{ connection_id: connectionId, workspace_id: "ws-1", provider_account_uid: "u1", iban: "DE89370400440532013000", currency_code: "EUR", account_name: "Revolut ••3000" }]]);
  const activated = updates[0] as { status: string; session_id_encrypted: string };
  expect(activated.status).toBe("active");
  expect(activated.session_id_encrypted).not.toContain("secret-session");
  expect(decryptToken(activated.session_id_encrypted, connectionId)).toBe("secret-session");
  expect(start).toHaveBeenCalledWith(expect.anything(), [connectionId, "ws-1", expect.any(Object)]);
});
