import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import type { ToolSet } from "ai";
import { claudeCode, createAiSdkMcpServer, type ClaudeCodeSettings, type MessageInjector } from "ai-sdk-provider-claude-code";
import { z } from "zod";
import { childProcessEnv, dataDir } from "@/lib/env";

export class ClaudeError extends Error {}

export function claudeExecutable(): string | null {
  const require = createRequire(import.meta.url);
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const glibc = process.platform === "linux" && Boolean((process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime);
  for (const name of process.platform === "linux" ? glibc ? [base, `${base}-musl`] : [`${base}-musl`, base] : [base]) {
    try {
      const file = require.resolve(/*turbopackIgnore: true*/ `${name}/claude${process.platform === "win32" ? ".exe" : ""}`);
      if (existsSync(/*turbopackIgnore: true*/ file)) return file;
    } catch { continue; }
  }
  return null;
}

const PAID_ROUTES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
export function claudeEnv(env: Record<string, string | undefined> = childProcessEnv()) {
  return { ...env, ...Object.fromEntries(PAID_ROUTES.map(key => [key, undefined])) } as NodeJS.ProcessEnv;
}

const statusSchema = z.object({ loggedIn: z.boolean(), authMethod: z.string().nullish(), email: z.string().nullish(), subscriptionType: z.string().nullish() });
export type ClaudeAccount = { installed: boolean; signedIn: boolean; email: string | null; plan: string | null; problem: string | null };

export function accountFrom(output: string): ClaudeAccount {
  const parsed = statusSchema.safeParse((() => { try { return JSON.parse(output); } catch { return null; } })());
  if (!parsed.success) return { installed: true, signedIn: false, email: null, plan: null, problem: "Claude Code's sign-in status could not be read." };
  const { loggedIn, authMethod, email, subscriptionType } = parsed.data;
  const plan = loggedIn && authMethod === "claude.ai";
  return { installed: true, signedIn: plan, email: plan ? email ?? null : null, plan: plan ? subscriptionType ?? null : null,
    problem: loggedIn && !plan ? "Claude Code is signed in with an API key or Console account, not a Claude plan. Sign in with Claude to use your plan." : null };
}

const cache = globalThis as typeof globalThis & { moneoClaudeAccount?: { at: number; value: Promise<ClaudeAccount> } };
const connectionFile = () => path.join(dataDir(), "claude-connected");

export async function setClaudeConnected(connected: boolean) {
  await mkdir(path.dirname(connectionFile()), { recursive: true });
  await writeFile(connectionFile(), connected ? "true" : "false", { mode: 0o600 });
}

export async function claudeAccount(): Promise<ClaudeAccount> {
  const connected = await readFile(connectionFile(), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "false";
    throw error;
  });
  if (connected !== "true") {
    const installed = Boolean(claudeExecutable());
    return { installed, signedIn: false, email: null, plan: null, problem: installed ? null : "Claude Code is missing from this install. Run npm ci, then restart Moneo." };
  }
  return availableClaudeAccount();
}

export function availableClaudeAccount(): Promise<ClaudeAccount> {
  if (cache.moneoClaudeAccount && Date.now() - cache.moneoClaudeAccount.at < 30_000) return cache.moneoClaudeAccount.value;
  const executable = claudeExecutable();
  const value = executable ? new Promise<ClaudeAccount>(resolve => execFile(/*turbopackIgnore: true*/ executable, ["auth", "status", "--json"], { env: claudeEnv(), timeout: 20_000, windowsHide: true },
    (error, stdout) => resolve(stdout.trim() ? accountFrom(stdout) : { installed: true, signedIn: false, email: null, plan: null, problem: error ? "Claude Code did not answer. Try again." : null })))
    : Promise.resolve({ installed: false, signedIn: false, email: null, plan: null, problem: "Claude Code is missing from this install. Run npm ci, then restart Moneo." });
  cache.moneoClaudeAccount = { at: Date.now(), value };
  return value;
}
export const forgetClaudeAccount = () => { delete cache.moneoClaudeAccount; };

type SignIn = { process: ChildProcess; url: string | null; output: string; done: boolean; error: string | null };
const login = globalThis as typeof globalThis & { moneoClaudeSignIn?: SignIn };
const AUTHORIZE_URL = /https:\/\/\S+\/oauth\/authorize\?\S+/;

export function claudeSignInState() {
  const current = login.moneoClaudeSignIn;
  return current ? { running: !current.done, url: current.url, error: current.error } : { running: false, url: null, error: null };
}

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
  setTimeout(() => { if (login.moneoClaudeSignIn === state) cancelClaudeSignIn(); }, 15 * 60_000).unref();
  for (let waited = 0; waited < 10_000 && !state.url && !state.done; waited += 100) await new Promise(resolve => setTimeout(resolve, 100));
  return claudeSignInState();
}

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

export type ClaudeSteering = { take: () => Promise<{ id: string; content: string }[]>; delivered: (steers: { id: string; content: string }[]) => void };
const STEER_POLL_MS = 1500;

export function steerClaudeRun(injector: MessageInjector, steering: ClaudeSteering, pollMs = STEER_POLL_MS) {
  let ended = false, polling = false;
  const poll = async () => {
    if (ended || polling) return;
    polling = true;
    try {
      const taken = await steering.take();
      for (const steer of taken) {
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

export function claudeModel(modelId: string, tools: ToolSet = {}, steering?: ClaudeSteering, overrides: Partial<ClaudeCodeSettings> = {}) {
  const names = Object.keys(tools);
  const checked = Object.fromEntries(Object.entries(tools).map(([name, definition]) => [name, { ...definition,
    execute: (input: unknown, options: Parameters<NonNullable<typeof definition.execute>>[1]) =>
      definition.execute!((definition.inputSchema as z.ZodType).parse(input), options) }])) as ToolSet;
  const settings: ClaudeCodeSettings = {
    pathToClaudeCodeExecutable: claudeExecutable() ?? undefined,
    env: claudeEnv(),
    tools: [], settingSources: [], strictMcpConfig: true, persistSession: false,
    maxTurns: CHAT_MAX_STEPS,
    ...(names.length ? { mcpServers: { moneo: createAiSdkMcpServer("moneo", checked) }, allowedTools: names.map(name => `mcp__moneo__${name}`) } : {}),
    ...overrides,
  };
  const base = claudeCode(modelId, settings);
  type Options = Parameters<typeof base.doStream>[0];
  const forCall = async (options: Options) => {
    const system = options.prompt.flatMap(message => message.role === "system" ? [message.content] : []).join("\n\n");
    const effort = (options.providerOptions?.openai as { reasoningEffort?: unknown } | undefined)?.reasoningEffort;
    let endSteering: (() => void) | undefined, finished = false;
    const model = claudeCode(modelId, { ...settings, ...(system ? { systemPrompt: system } : {}), ...(effort === "low" || effort === "medium" || effort === "high" ? { effort } : {}),
      ...(steering ? { streamingInput: "always" as const, onStreamStart: (injector: MessageInjector) => { if (finished) injector.close(); else endSteering = steerClaudeRun(injector, steering); } } : {}) });
    const end = () => { finished = true; endSteering?.(); };
    options.abortSignal?.addEventListener("abort", end, { once: true });
    return { model, end, options: { ...options, prompt: options.prompt.filter(message => message.role !== "system") } };
  };
  const steered = (stream: ReadableStream<unknown>, end: () => void) => {
    const reader = stream.getReader();
    return new ReadableStream({
      pull: async controller => { try { const next = await reader.read(); if (next.done) { end(); controller.close(); } else controller.enqueue(next.value); } catch (error) { end(); controller.error(error); } },
      cancel: reason => { end(); return reader.cancel(reason); },
    });
  };
  return Object.assign(Object.create(base) as typeof base, {
    doGenerate: async (options: Options) => { const call = await forCall(options); return call.model.doGenerate(call.options); },
    doStream: async (options: Options) => {
      const call = await forCall(options);
      try {
        const result = await call.model.doStream(call.options);
        return steering ? { ...result, stream: steered(result.stream, call.end) as typeof result.stream } : result;
      } catch (error) { call.end(); throw error; }
    },
  });
}

export const CHAT_MAX_STEPS = 60;

export const moneoToolName = (name: string) => name.replace(/^mcp__moneo__/, "");
