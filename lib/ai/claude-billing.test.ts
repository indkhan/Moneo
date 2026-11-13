import { afterEach, expect, it, vi } from "vitest";
import { claudeModel } from "./claude";

afterEach(() => { vi.unstubAllEnvs(); });

// Runs the real adapter and Agent SDK up to the point Claude Code would be started, where its final
// environment is known. The adapter merges its own copy of ANTHROPIC_* variables underneath ours.
it("starts Claude Code without any variable that would bill an API key or cloud account", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "token");
  vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "1");
  let env: Record<string, string | undefined> | null = null;
  const model = claudeModel("claude-opus-5-5", {}, { spawnClaudeCodeProcess: options => { env = options.env; throw new Error("stopped before Claude Code starts"); } });
  const { stream } = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] } as Parameters<typeof model.doStream>[0]);
  for await (const part of stream as unknown as AsyncIterable<unknown>) void part;
  expect(env).not.toBeNull();
  expect(env!.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env!.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  expect(env!.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
});
