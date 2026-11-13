import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { tool } from "ai";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";

const provider = vi.hoisted(() => ({ calls: [] as { modelId: string; settings: Record<string, unknown> }[] }));
vi.mock("ai-sdk-provider-claude-code", () => ({
  createAiSdkMcpServer: (name: string, tools: Record<string, { execute: (input: unknown, options: object) => unknown }>) => ({ name, tools: Object.keys(tools), run: tools }),
  claudeCode: (modelId: string, settings: Record<string, unknown>) => {
    provider.calls.push({ modelId, settings });
    return { provider: "claude-code", modelId, doStream: async (options: unknown) => ({ options }), doGenerate: async (options: unknown) => ({ options }) };
  },
}));

const { accountFrom, cancelClaudeSignIn, claudeEnv, claudeModel, claudeSignInState, startClaudeSignIn, submitClaudeCode } = await import("./claude");

afterEach(() => { provider.calls.length = 0; cancelClaudeSignIn(); });

it("never hands Claude Code a route that bills an API key or cloud account", () => {
  const env = claudeEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-1", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "https://proxy", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_OAUTH_TOKEN: "plan" });
  expect(env).toEqual({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "plan" });
});

it("counts only a claude.ai sign-in as the owner's plan", () => {
  expect(accountFrom(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "owner@example.com", subscriptionType: "max" })))
    .toEqual({ installed: true, signedIn: true, email: "owner@example.com", plan: "max", problem: null });
  const console = accountFrom(JSON.stringify({ loggedIn: true, authMethod: "console", email: "owner@example.com" }));
  expect(console.signedIn).toBe(false);
  expect(console.problem).toContain("not a Claude plan");
  expect(accountFrom(JSON.stringify({ loggedIn: false })).signedIn).toBe(false);
  expect(accountFrom("not json").signedIn).toBe(false);
});

it("gives Claude only Moneo's tools, its instructions as the system prompt and the call's reasoning effort", async () => {
  const balance = tool({ description: "Balance", inputSchema: z.object({ account: z.string(), other: z.string().optional() }).refine(input => input.account !== input.other, "Pick two accounts"), execute: async () => ({}) });
  const model = claudeModel("claude-opus-5-5", { accounts_balance: balance });
  const prompt = [{ role: "system" as const, content: "You are Moneo." }, { role: "user" as const, content: [{ type: "text" as const, text: "Hi" }] }];
  const result = await model.doStream({ prompt, providerOptions: { openai: { reasoningEffort: "low" } } } as Parameters<typeof model.doStream>[0]) as unknown as { options: { prompt: unknown[] } };
  const settings = provider.calls.at(-1)!.settings;
  expect(settings).toMatchObject({ tools: [], settingSources: [], strictMcpConfig: true, persistSession: false, allowedTools: ["mcp__moneo__accounts_balance"],
    mcpServers: { moneo: { name: "moneo", tools: ["accounts_balance"] } }, systemPrompt: "You are Moneo.", effort: "low" });
  expect(settings.env).not.toHaveProperty("ANTHROPIC_API_KEY");
  expect(result.options.prompt).toEqual([prompt[1]]);
  // Object-level rules still hold although the bridge checks fields one by one.
  const run = (settings.mcpServers as { moneo: { run: Record<string, { execute: (input: unknown, options: object) => unknown }> } }).moneo.run;
  expect(() => run.accounts_balance.execute({ account: "a", other: "a" }, {})).toThrow("Pick two accounts");
});

function fakeLogin() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() });
  const spawn = vi.fn<(command: string, args: string[]) => ChildProcess>(() => {
    // Buffered until Moneo starts reading, like a real process's output.
    child.stdout.write("Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc\nPaste code here if prompted > ");
    return child as unknown as ChildProcess;
  });
  return { child, spawn };
}

it("signs in through Claude Code's own login and passes the pasted code to it", async () => {
  const { child, spawn } = fakeLogin();
  const state = await startClaudeSignIn(spawn);
  expect(spawn.mock.calls[0][1]).toEqual(["auth", "login", "--claudeai"]);
  expect(state).toEqual({ running: true, url: "https://claude.com/cai/oauth/authorize?code=true&state=abc", error: null });
  expect(() => submitClaudeCode("bad code")).toThrow("doesn't look like");
  const written = once(child.stdin, "data");
  submitClaudeCode("  abcdefghijkl#state-1 ");
  expect(String((await written)[0])).toBe("abcdefghijkl#state-1\n");
  child.emit("exit", 0);
  expect(claudeSignInState()).toEqual({ running: false, url: state.url, error: null });
  expect(() => submitClaudeCode("abcdefghijkl")).toThrow("expired");
});
