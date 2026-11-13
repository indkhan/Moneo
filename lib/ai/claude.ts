import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { ToolSet } from "ai";
import { claudeCode, createAiSdkMcpServer, type ClaudeCodeSettings, type MessageInjector } from "ai-sdk-provider-claude-code";
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
      const file = require.resolve(/*turbopackIgnore: true*/ `${name}/claude${process.platform === "win32" ? ".exe" : ""}`);
      if (existsSync(/*turbopackIgnore: true*/ file)) return file;
    } catch { /* try the next one */ }
  }
  return null;
}

// Any of these would make Claude Code bill an API key or a cloud account instead of the plan.
const PAID_ROUTES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
/** The environment for Claude Code: this process's, minus everything that routes requests away from the plan. */
export function claudeEnv(env: Record<string, string | undefined> = process.env) {
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
  const value = executable ? new Promise<ClaudeAccount>(resolve => execFile(/*turbopackIgnore: true*/ executable, ["auth", "status", "--json"], { env: claudeEnv(), timeout: 20_000, windowsHide: true },
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
  const child = spawnProcess(/*turbopackIgnore: true*/ executable, ["auth", "login", "--claudeai"], { env: claudeEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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
 * Where messages sent during an answer come from. `take` claims the pending ones (each is handed out once);
 * `delivered` says which of them reached the running answer.
 */
export type ClaudeSteering = { take: () => Promise<{ id: string; content: string }[]>; delivered: (steers: { id: string; content: string }[]) => void };
const STEER_POLL_MS = 1500;

/**
 * While Claude Code runs an answer, hands it the steers taken from `steering`. Claude Code runs the whole tool
 * loop inside one model step, so unlike other models it can only be steered by pushing messages into its
 * running query. Returns what ends it: call it when the answer is over so nothing keeps polling.
 */
export function steerClaudeRun(injector: MessageInjector, steering: ClaudeSteering, pollMs = STEER_POLL_MS) {
  let ended = false, polling = false;
  const poll = async () => {
    if (ended || polling) return;
    polling = true;
    try {
      const taken = await steering.take();
      for (const steer of taken) {
        // A steer taken as the answer ends is not delivered; the owner's queue sends it as the next message.
        if (ended) break;
        injector.inject(steer.content, delivered => { if (delivered) steering.delivered([steer]); });
      }
    } catch (error) { console.error("Steering Claude failed", error); }
    finally { polling = false; }
  };
  const timer = setInterval(() => void poll(), pollMs);
  timer.unref?.();
  return () => { ended = true; clearInterval(timer); injector.close(); };
}

/**
 * A Claude model run by Claude Code on the owner's plan. Claude Code runs the tool loop itself, so Moneo's
 * tools are handed over here as an in-process MCP server; nothing else is available to it: no built-in
 * tools, no settings, CLAUDE.md or MCP servers from this computer, and no transcripts written to disk.
 */
export function claudeModel(modelId: string, tools: ToolSet = {}, steering?: ClaudeSteering) {
  const names = Object.keys(tools);
  // The MCP bridge checks each field on its own; checking the whole schema again keeps object-level rules
  // (such as "no duplicate overrides") before a tool runs.
  const checked = Object.fromEntries(Object.entries(tools).map(([name, definition]) => [name, { ...definition,
    execute: (input: unknown, options: Parameters<NonNullable<typeof definition.execute>>[1]) =>
      definition.execute!((definition.inputSchema as z.ZodType).parse(input), options) }])) as ToolSet;
  const settings: ClaudeCodeSettings = {
    pathToClaudeCodeExecutable: claudeExecutable() ?? undefined,
    env: claudeEnv(),
    tools: [], settingSources: [], strictMcpConfig: true, persistSession: false,
    // Matches the chat's stepCountIs(30) guard against runaway loops.
    maxTurns: 30,
    ...(names.length ? { mcpServers: { moneo: createAiSdkMcpServer("moneo", checked) }, allowedTools: names.map(name => `mcp__moneo__${name}`) } : {}),
  };
  const base = claudeCode(modelId, settings);
  // The provider folds system messages into the prompt text; Moneo's instructions go in as the system prompt
  // instead, and the OpenAI reasoning effort a call asks for carries over.
  type Options = Parameters<typeof base.doStream>[0];
  const forCall = (options: Options) => {
    const system = options.prompt.flatMap(message => message.role === "system" ? [message.content] : []).join("\n\n");
    const effort = (options.providerOptions?.openai as { reasoningEffort?: unknown } | undefined)?.reasoningEffort;
    // Steers reach the answer through streaming input; the call ends them when its stream ends.
    let endSteering: (() => void) | undefined, finished = false;
    const model = claudeCode(modelId, { ...settings, ...(system ? { systemPrompt: system } : {}), ...(effort === "low" || effort === "medium" || effort === "high" ? { effort } : {}),
      ...(steering ? { streamingInput: "always" as const, onStreamStart: (injector: MessageInjector) => { if (finished) injector.close(); else endSteering = steerClaudeRun(injector, steering); } } : {}) });
    const end = () => { finished = true; endSteering?.(); };
    options.abortSignal?.addEventListener("abort", end, { once: true });
    return { model, end, options: { ...options, prompt: options.prompt.filter(message => message.role !== "system") } };
  };
  /** The stream, ending the call's steering when it finishes, fails or is canceled. */
  const steered = (stream: ReadableStream<unknown>, end: () => void) => {
    const reader = stream.getReader();
    return new ReadableStream({
      pull: async controller => { try { const next = await reader.read(); if (next.done) { end(); controller.close(); } else controller.enqueue(next.value); } catch (error) { end(); controller.error(error); } },
      cancel: reason => { end(); return reader.cancel(reason); },
    });
  };
  return Object.assign(Object.create(base) as typeof base, {
    doGenerate: (options: Options) => { const call = forCall(options); return call.model.doGenerate(call.options); },
    doStream: async (options: Options) => {
      const call = forCall(options);
      try {
        const result = await call.model.doStream(call.options);
        return steering ? { ...result, stream: steered(result.stream, call.end) as typeof result.stream } : result;
      } catch (error) { call.end(); throw error; }
    },
  });
}

/** Tool names as Moneo knows them: Claude reports its MCP tools as mcp__moneo__<name>. */
export const moneoToolName = (name: string) => name.replace(/^mcp__moneo__/, "");
