import { beforeEach, expect, it, vi } from "vitest";
import { saveAiKey } from "./ai-key-actions";
import { checkAiKey } from "@/lib/ai/keys";
import { removeServiceKeys, saveServiceKeys } from "@/lib/service-keys";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("@/lib/service-keys", () => ({ saveServiceKeys: vi.fn(), removeServiceKeys: vi.fn() }));
vi.mock("@/lib/ai/keys", async original => ({ ...await original<typeof import("@/lib/ai/keys")>(), checkAiKey: vi.fn() }));

const form = (values: Record<string, string>) => { const data = new FormData(); for (const [key, value] of Object.entries(values)) data.set(key, value); return data; };
beforeEach(() => vi.clearAllMocks());

it("saves a key only after the provider accepts it", async () => {
  vi.mocked(checkAiKey).mockResolvedValueOnce("OpenRouter didn't accept that key. Check it and try again.").mockResolvedValueOnce(null);
  expect(await saveAiKey({}, form({ name: "openrouter_api_key", key: "sk-or-wrong-key" }))).toEqual({ error: "OpenRouter didn't accept that key. Check it and try again." });
  expect(saveServiceKeys).not.toHaveBeenCalled();
  expect(await saveAiKey({}, form({ name: "openrouter_api_key", key: "  sk-or-right-key  " }))).toEqual({ saved: true });
  expect(checkAiKey).toHaveBeenLastCalledWith("openrouter_api_key", "sk-or-right-key");
  expect(saveServiceKeys).toHaveBeenCalledWith({ openrouter_api_key: "sk-or-right-key" });
});

it("rejects unknown names and malformed keys without calling the provider", async () => {
  expect((await saveAiKey({}, form({ name: "enable_banking_private_key", key: "sk-something-long" }))).error).toBe("Unknown key");
  expect((await saveAiKey({}, form({ name: "openai_api_key", key: "sk-has a space" }))).error).toBe("A key has no spaces");
  expect(checkAiKey).not.toHaveBeenCalled();
});

it("removes the saved key", async () => {
  expect(await saveAiKey({}, form({ name: "openai_api_key", operation: "remove" }))).toEqual({});
  expect(removeServiceKeys).toHaveBeenCalledWith(["openai_api_key"]);
});
