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

test("requires an OpenAI key", () => {
  vi.stubEnv("OPENAI_API_KEY", "");
  expect(() => getModel("gpt-5")).toThrow("OPENAI_API_KEY");
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  expect(getModel("gpt-5").modelId).toBe("gpt-5");
});

test("sends vendor/model IDs to OpenRouter", () => {
  vi.stubEnv("OPENROUTER_API_KEY", "");
  expect(() => getModel("nvidia/nemotron-3.5-lightning:free")).toThrow("OPENROUTER_API_KEY");
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  expect(getModel("nvidia/nemotron-3.5-lightning:free").provider).toContain("openrouter");
});
