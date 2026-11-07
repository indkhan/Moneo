import { beforeEach, expect, it, vi } from "vitest";
import { requireWorkspace } from "@/lib/auth";
import { checkEnableBankingCredentials, EnableBankingError } from "@/lib/bank/enable-banking";
import { removeServiceKeys, saveServiceKeys } from "@/lib/service-keys";
import { DELETE, POST } from "./route";

vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("@/lib/service-keys", () => ({ saveServiceKeys: vi.fn(), removeServiceKeys: vi.fn() }));
vi.mock("@/lib/bank/enable-banking", async original => ({ ...await original<typeof import("@/lib/bank/enable-banking")>(), checkEnableBankingCredentials: vi.fn() }));

const pem = "-----BEGIN PRIVATE KEY-----\nMIIsynthetic\n-----END PRIVATE KEY-----\n";
const post = (body: unknown) => POST(new Request("http://localhost/api/bank/credentials", { method: "POST", body: JSON.stringify(body) }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BANK_TOKEN_ENCRYPTION_KEY", Buffer.alloc(32).toString("base64"));
  vi.mocked(requireWorkspace).mockResolvedValue({} as never);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

it("saves the App ID and key after Enable Banking accepts them", async () => {
  const response = await post({ appId: " app-1 ", privateKey: pem });
  expect(response.status).toBe(200);
  expect(checkEnableBankingCredentials).toHaveBeenCalledWith({ appId: "app-1", privateKey: pem.trim() });
  expect(saveServiceKeys).toHaveBeenCalledWith({ enable_banking_app_id: "app-1", enable_banking_private_key: pem.trim() });
});

it("explains a key that is not a PEM or that Enable Banking rejects, and saves nothing", async () => {
  expect((await (await post({ appId: "app-1", privateKey: "hello" })).json()).error).toMatch(/BEGIN PRIVATE KEY/);
  vi.mocked(checkEnableBankingCredentials).mockRejectedValueOnce(new EnableBankingError(401, undefined, "Enable Banking GET /application failed (401)"));
  const rejected = await post({ appId: "app-1", privateKey: pem });
  expect(rejected.status).toBe(400);
  expect((await rejected.json()).error).toBe("Enable Banking rejected the App ID or private key. Check that the key belongs to this App ID.");
  expect(saveServiceKeys).not.toHaveBeenCalled();
});

it("removes both credentials", async () => {
  expect((await DELETE()).status).toBe(200);
  expect(removeServiceKeys).toHaveBeenCalledWith(["enable_banking_app_id", "enable_banking_private_key"]);
});
