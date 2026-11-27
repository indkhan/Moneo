import { afterEach, expect, test, vi } from "vitest";
import { currentModelId, getModel, modelIdFor, SYSTEM_PROMPT } from "./provider";
import { claudeAccount } from "./claude";
import { generateText } from "ai";
import { AI_AGENTS, settingsSchema } from "@/lib/settings";

const inserted = vi.fn<(row: unknown) => Promise<{ error: null }>>(async () => ({ error: null }));
vi.mock("@/lib/service-db", () => ({ serviceDb: (() => ({ from: () => ({ insert: inserted }) })) }));
vi.mock("./claude", async original => ({ ...await original<typeof import("./claude")>(), claudeAccount: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); });
const scope = { workspaceId: "00000000-0000-4000-8000-000000000001", task: "chat" } as const;

test("uses each agent's typed model and falls back to its default", () => {
  const settings = settingsSchema.parse({ ai_models: { chat: "gpt-custom" } });
  expect(modelIdFor(settings, "chat")).toBe("gpt-custom");
  expect(modelIdFor(settings, "imports")).toBe(AI_AGENTS.imports.model);
  expect(modelIdFor(undefined, "chat")).toBe(AI_AGENTS.chat.model);
  expect(modelIdFor(settings, "imports", "claude")).toBe(AI_AGENTS.imports.claude);
  expect(modelIdFor(settings, "chat", "claude")).toBe("gpt-custom");
});

test("a Claude model runs only on a Claude plan sign-in, never on a paid key", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
  vi.mocked(claudeAccount).mockResolvedValue({ installed: true, signedIn: false, email: null, plan: null, problem: null });
  await expect(getModel("claude-opus-5-5", scope)).rejects.toThrow("Sign in with Claude");
  vi.mocked(claudeAccount).mockResolvedValue({ installed: true, signedIn: true, email: "owner@example.com", plan: "max", problem: null });
  const model = await getModel("claude-opus-5-5", scope);
  expect(model.provider).toBe("claude-code");
  expect(model.modelId).toBe("claude-opus-5-5");
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
  await expect(getModel("gpt-5", scope)).rejects.toThrow("Settings → AI access");
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  expect((await getModel("gpt-5", scope)).modelId).toBe("gpt-5");
});

test("sends vendor/model IDs to OpenRouter", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "");
  await expect(getModel("nvidia/nemotron-3.5-lightning:free", scope)).rejects.toThrow("OpenRouter API key");
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  expect((await getModel("nvidia/nemotron-3.5-lightning:free", scope)).provider).toContain("openrouter");
});

test("with only an OpenRouter key, OpenAI model IDs run through OpenRouter", async () => {
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  const model = await getModel(AI_AGENTS.chat.model, scope);
  expect(model.provider).toContain("openrouter");
  expect(model.modelId).toBe(`openai/${AI_AGENTS.chat.model}`);
});

test("the shared default reaches every task unless explicitly overridden", async () => {
  const settings = settingsSchema.parse({ ai_models: { default: "gpt-shared", titles: "gpt-title" } });
  for (const agent of Object.keys(AI_AGENTS) as (keyof typeof AI_AGENTS)[]) {
    expect(modelIdFor(settings, agent)).toBe(agent === "titles" ? "gpt-title" : "gpt-shared");
    expect(await currentModelId(settings, agent)).toBe(agent === "titles" ? "gpt-title" : "gpt-shared");
  }
});

test("the system prompt stays within its budget", () => {
  const budget = 8000;
  expect(SYSTEM_PROMPT.length, `The system prompt is ${SYSTEM_PROMPT.length} characters; its budget is ${budget}. Do not add a sentence to make one request work: give the assistant the tool, data or scope it lacks (AGENTS.md How to work, "Fix the class"). For guidance that applies to every request, shorten something else first. Raise the budget only when the owner asks.`).toBeLessThanOrEqual(budget);
});

test("a model from the provider records its call with the task, source and reported tokens", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  inserted.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "r1", model: "vendor/m", created: 0,
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } })));
  const model = await getModel("vendor/m", { workspaceId: scope.workspaceId, task: "organize" });
  expect((await generateText({ model, prompt: "hello" })).text).toBe("hi");
  await vi.waitFor(() => expect(inserted).toHaveBeenCalledOnce());
  expect(inserted.mock.calls[0]?.[0]).toMatchObject({ workspace_id: scope.workspaceId, task: "organize", source: "openrouter", model_id: "vendor/m", input_tokens: 11, output_tokens: 3, status: "succeeded" });
});
