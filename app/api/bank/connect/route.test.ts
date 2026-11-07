import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requireWorkspace } from "@/lib/auth";
import { EnableBankingError, enableBankingClient, enableBankingConfigured } from "@/lib/bank/enable-banking";
import { serviceDb } from "@/lib/bank/server";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("@/lib/bank/enable-banking", async original => ({ ...await original<typeof import("@/lib/bank/enable-banking")>(), enableBankingClient: vi.fn(), enableBankingConfigured: vi.fn() }));
vi.mock("@/lib/bank/server", async original => ({ ...await original<typeof import("@/lib/bank/server")>(), serviceDb: vi.fn() }));

const startAuthorization = vi.fn();
beforeEach(() => {
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic");
  vi.mocked(requireWorkspace).mockResolvedValue({ workspace: { id: "ws-1" } } as never);
  vi.mocked(enableBankingConfigured).mockResolvedValue(true);
  vi.mocked(enableBankingClient).mockResolvedValue({
    listAspsps: async () => [{ name: "Revolut", country: "DE" }], startAuthorization,
  } as never);
  const insert = { select: () => insert, single: async () => ({ data: { auth_state: "6f1c1f8e-4c39-4b55-8a3e-0c7a9d1b2c3d" }, error: null }) };
  vi.mocked(serviceDb).mockReturnValue({ from: () => ({ insert: () => insert }) } as never);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const connect = () => POST(new Request("http://localhost/api/bank/connect", { method: "POST", body: JSON.stringify({ aspspName: "Revolut", country: "DE" }) }));

it("explains a redirect address Enable Banking does not allow", async () => {
  startAuthorization.mockRejectedValue(new EnableBankingError(400, "REDIRECT_URI_NOT_ALLOWED", "Enable Banking POST /auth failed (400 REDIRECT_URI_NOT_ALLOWED)"));
  const response = await connect();
  expect(response.status).toBe(502);
  expect((await response.json()).error).toBe("Enable Banking rejected the return address. Add https://localhost:3443/api/bank/callback as a Redirect URL in your Enable Banking application, then try again.");
  expect(console.error).toHaveBeenCalledWith("bank connect failed", "Enable Banking POST /auth failed (400 REDIRECT_URI_NOT_ALLOWED)");
});

it("explains rejected credentials and names unknown codes", async () => {
  startAuthorization.mockRejectedValueOnce(new EnableBankingError(401, undefined, "Enable Banking POST /auth failed (401)"));
  expect((await (await connect()).json()).error).toMatch(/rejected the App ID or private key/);
  startAuthorization.mockRejectedValueOnce(new EnableBankingError(422, "SOMETHING_NEW", "Enable Banking POST /auth failed (422 SOMETHING_NEW)"));
  expect((await (await connect()).json()).error).toBe("The bank connection could not be started (Enable Banking said SOMETHING_NEW). Try again.");
});

it("keeps the generic message for errors that are not from Enable Banking", async () => {
  startAuthorization.mockRejectedValue(new Error("socket hang up"));
  expect((await (await connect()).json()).error).toBe("The bank connection could not be started");
});
