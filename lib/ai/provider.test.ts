import { afterEach, expect, test, vi } from "vitest";
import { getModel, listFreeModels, modelForSettings } from "./provider";
import { settingsSchema } from "@/lib/settings";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

test("accepts the configured OpenRouter model without a suffix restriction", () => {
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  vi.stubEnv("OPENROUTER_MODEL", "example/model");
  expect(getModel().modelId).toBe("example/model");
});

test("offers only zero-price models with tools and structured response support", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [
    { id: "free", name: "Free", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools", "response_format"] },
    { id: "paid", pricing: { prompt: "0.01", completion: "0" }, supported_parameters: ["tools", "response_format"] },
    { id: "underflow", pricing: { prompt: "1e-1000", completion: "0" }, supported_parameters: ["tools", "response_format"] },
    { id: "empty", pricing: { prompt: "", completion: "0" }, supported_parameters: ["tools", "response_format"] },
    { id: "limited", pricing: { prompt: "0", completion: "0" }, supported_parameters: [] },
  ] })));
  expect(await listFreeModels()).toEqual([{ id: "free", name: "Free" }]);
});

test("refuses a formerly free selected model before provider invocation", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [
    { id: "changed", name: "Changed", pricing: { prompt: "0", completion: "1" }, supported_parameters: ["tools", "response_format"] },
  ] })));
  await expect(modelForSettings(settingsSchema.parse({ openrouter_model: "changed" }))).rejects.toThrow("no longer free");
});
