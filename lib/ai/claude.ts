import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { ToolSet } from "ai";
import { claudeCode, createAiSdkMcpServer, type ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import { z } from "zod";

// Claude plan usage: requests run through Claude Code (the Claude Agent SDK's bundled binary) signed in
// with the owner's own claude.ai account, so they count toward that plan, never an API key. Moneo never
// sees or stores the Claude token; Claude Code keeps it on this computer.
// Docs: https://code.claude.com/docs/en/agent-sdk/overview

export class ClaudeError extends Error {}

/** The Claude Code binary that ships with the Agent SDK for this platform, or null when it isn't installed. */
export function claudeExecutable(): string | null {
  const require = createRequire(import.meta.url);
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  for (const name of process.platform === "linux" ? [base, `${base}-musl`] : [base]) {
    try {
      const file = require.resolve(`${name}/claude${process.platform === "win32" ? ".exe" : ""}`);
      if (existsSync(file)) return file;
    } catch { /* try the next one */ }
  }
  return null;
}

// Any of these would make Claude Code bill an API key or a cloud account instead of the plan.
const PAID_ROUTES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
/** The environment for Claude Code: this process's, minus everything that routes requests away from the plan. */
export function claudeEnv(env: NodeJS.ProcessEnv = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !PAID_ROUTES.includes(key))) as NodeJS.ProcessEnv;
}

const statusSchema = z.object({ loggedIn: z.boolean(), authMethod: z.string().nullish(), email: z.string().nullish(), subscriptionType: z.string().nullish() });
export type ClaudeAccount = { installed: boolean; signedIn: boolean; email: string | null; plan: string | null; problem: string | null };

/** What `claude auth status` says, read as plan sign-in only: an API-key or Console login doesn't count. */
export function accountFrom(output: string): ClaudeAccount {
  const parsed = statusSchema.safeParse((() => { try { return JSON.parse(output); } catch { return null; } })());
  if (!parsed.success) return { installed: true, signedIn: false, email: null, plan: null, problem: "Claude Code's sign-in status could not be read." };
  const { loggedIn, authMethod, email, subscriptionType } = parsed.data;
  const plan = loggedIn && authMethod === "claude.ai";
  return { installed: true, signedIn: plan, email: plan ? email ?? null : null, plan: plan ? subscriptionType ?? null : null,
    problem: loggedIn && !plan ? "Claude Code is signed in with an API key or Console account, not a Claude plan. Sign in with Claude to use your plan." : null };
}

const cache = globalThis as typeof globalThis & { moneoClaudeAccount?: { at: number; value: Promise<ClaudeAccount> } };
/** The Claude account Claude Code is signed in with, read at most every 30 seconds. */
export function claudeAccount(): Promise<ClaudeAccount> {
  if (cache.moneoClaudeAccount && Date.now() - cache.moneoClaudeAccount.at < 30_000) return cache.moneoClaudeAccount.value;
  const executable = claudeExecutable();
  const value = executable ? new Promise<ClaudeAccount>(resolve => execFile(executable, ["auth", "status", "--json"], { env: claudeEnv(), timeout: 20_000, windowsHide: true },
    (error, stdout) => resolve(stdout.trim() ? accountFrom(stdout) : { installed: true, signedIn: false, email: null, plan: null, problem: error ? "Claude Code did not answer. Try again." : null })))
    : Promise.resolve({ installed: false, signedIn: false, email: null, plan: null, problem: "Claude Code is missing from this install. Run npm ci, then restart Moneo." });
  cache.moneoClaudeAccount = { at: Date.now(), value };
  return value;
}
export const forgetClaudeAccount = () => { delete cache.moneoClaudeAccount; };

// Sign-in runs Claude Code's own `claude auth login`: it opens the browser on this computer and, when the
// page shows a code instead of finishing on its own, reads that code from its input.
type SignIn = { process: ChildProcess; url: string | null; output: string; done: boolean; error: string | null };
const login = globalThis as typeof globalThis & { moneoClaudeSignIn?: SignIn };
const AUTHORIZE_URL = /https:\/\/\S+\/oauth\/authorize\?\S+/;

export function claudeSignInState() {
  const current = login.moneoClaudeSignIn;
  return current ? { running: !current.done, url: current.url, error: current.error } : { running: false, url: null, error: null };
}

/** Starts Claude Code's sign-in and waits briefly for its sign-in link. */
export async function startClaudeSignIn(spawnProcess: (command: string, args: string[], options: SpawnOptions) => ChildProcess = spawn) {
  const executable = claudeExecutable();
  if (!executable) throw new ClaudeError("Claude Code is missing from this install. Run npm ci, then restart Moneo.");
  cancelClaudeSignIn();
  const child = spawnProcess(executable, ["auth", "login", "--claudeai"], { env: claudeEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const state: SignIn = { process: child, url: null, output: "", done: false, error: null };
  login.moneoClaudeSignIn = state;
  const read = (chunk: Buffer) => {
    state.output = (state.output + chunk.toString()).slice(-4000);
    state.url ??= state.output.match(AUTHORIZE_URL)?.[0] ?? null;
  };
  child.stdout?.on("data", read);
  child.stderr?.on("data", read);
  child.on("error", () => { state.done = true; state.error = "Claude Code could not start. Try again."; });
  child.on("exit", code => {
    state.done = true;
    if (code !== 0 && code !== null && !state.error) state.error = "Claude sign-in did not finish. Try again.";
    forgetClaudeAccount();
  });
  // Clean up a sign-in nobody finished.
  setTimeout(() => { if (login.moneoClaudeSignIn === state) cancelClaudeSignIn(); }, 15 * 60_000).unref();
  for (let waited = 0; waited < 10_000 && !state.url && !state.done; waited += 100) await new Promise(resolve => setTimeout(resolve, 100));
  return claudeSignInState();
}

/** Passes the code the Claude sign-in page showed to the waiting `claude auth login`. */
export function submitClaudeCode(code: string) {
  const current = login.moneoClaudeSignIn;
  const value = code.trim();
  if (!current || current.done || !current.process.stdin) throw new ClaudeError("The sign-in expired. Start it again.");
  if (!/^[\w#.-]{10,500}$/.test(value)) throw new ClaudeError("That doesn't look like a Claude sign-in code.");
  current.process.stdin.write(`${value}\n`);
}

export function cancelClaudeSignIn() {
  const current = login.moneoClaudeSignIn;
  if (current && !current.done) current.process.kill();
  delete login.moneoClaudeSignIn;
}

/**
 * A Claude model run by Claude Code on the owner's plan. Claude Code runs the tool loop itself, so Moneo's
 * tools are handed over here as an in-process MCP server; nothing else is available to it: no built-in
 * tools, no settings, CLAUDE.md or MCP servers from this computer, and no transcripts written to disk.
 */
export function claudeModel(modelId: string, tools: ToolSet = {}) {
  const names = Object.keys(tools);
  const settings: ClaudeCodeSettings = {
    pathToClaudeCodeExecutable: claudeExecutable() ?? undefined,
    env: claudeEnv(),
    tools: [], settingSources: [], strictMcpConfig: true, persistSession: false,
    // Matches the chat's stepCountIs(30) guard against runaway loops.
    maxTurns: 30,
    ...(names.length ? { mcpServers: { moneo: createAiSdkMcpServer("moneo", tools) }, allowedTools: names.map(name => `mcp__moneo__${name}`) } : {}),
  };
  const base = claudeCode(modelId, settings);
  // The provider folds system messages into the prompt text; Moneo's instructions go in as the system prompt
  // instead, and the OpenAI reasoning effort a call asks for carries over.
  type Options = Parameters<typeof base.doStream>[0];
  const forCall = (options: Options) => {
    const system = options.prompt.flatMap(message => message.role === "system" ? [message.content] : []).join("\n\n");
    const effort = (options.providerOptions?.openai as { reasoningEffort?: unknown } | undefined)?.reasoningEffort;
    const model = claudeCode(modelId, { ...settings, ...(system ? { systemPrompt: system } : {}), ...(effort === "low" || effort === "medium" || effort === "high" ? { effort } : {}) });
    return { model, options: { ...options, prompt: options.prompt.filter(message => message.role !== "system") } };
  };
  return Object.assign(Object.create(base) as typeof base, {
    doGenerate: (options: Options) => { const call = forCall(options); return call.model.doGenerate(call.options); },
    doStream: (options: Options) => { const call = forCall(options); return call.model.doStream(call.options); },
  });
}

/** Tool names as Moneo knows them: Claude reports its MCP tools as mcp__moneo__<name>. */
export const moneoToolName = (name: string) => name.replace(/^mcp__moneo__/, "");
