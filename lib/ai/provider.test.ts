import { afterEach, expect, test, vi } from "vitest";
import { getModel, modelIdFor } from "./provider";
import { AI_AGENTS, settingsSchema } from "@/lib/settings";

afterEach(() => { vi.unstubAllEnvs(); });

test("uses each agent's typed model and falls back to its default", () => {
  const settings = settingsSchema.parse({ ai_models: { chat: "gpt-custom" } });
  expect(modelIdFor(settings, "chat")).toBe("gpt-custom");
  expect(modelIdFor(settings, "imports")).toBe(AI_AGENTS.imports.model);
  expect(modelIdFor(undefined, "chat")).toBe(AI_AGENTS.chat.model);
});

test("a voice call follows the chat model until its own model is set", () => {
  expect(modelIdFor(settingsSchema.parse({}), "voice_call")).toBe(AI_AGENTS.chat.model);
  expect(modelIdFor(settingsSchema.parse({ ai_models: { chat: "gpt-custom" } }), "voice_call")).toBe("gpt-custom");
  expect(modelIdFor(settingsSchema.parse({ ai_models: { chat: "gpt-custom", voice_call: "gpt-fast" } }), "voice_call")).toBe("gpt-fast");
  expect(modelIdFor(undefined, "voice_call")).toBe(AI_AGENTS.chat.model);
});

test("requires an API key when not signed in with ChatGPT", async () => {
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  await expect(getModel("gpt-5")).rejects.toThrow("Settings → AI access");
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  expect((await getModel("gpt-5")).modelId).toBe("gpt-5");
});

test("sends vendor/model IDs to OpenRouter", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "");
  await expect(getModel("nvidia/nemotron-3.5-lightning:free")).rejects.toThrow("OpenRouter API key");
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  expect((await getModel("nvidia/nemotron-3.5-lightning:free")).provider).toContain("openrouter");
});

test("with only an OpenRouter key, OpenAI model IDs run through OpenRouter", async () => {
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  const model = await getModel(AI_AGENTS.chat.model);
  expect(model.provider).toContain("openrouter");
  expect(model.modelId).toBe(`openai/${AI_AGENTS.chat.model}`);
});
