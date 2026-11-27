import { beforeEach, describe, expect, it, vi } from "vitest";
import { log, logDetails, type LogStore } from "./log";

const workspaceId = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54521";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
});

describe("log", () => {
  it("returns before the entry is stored, so the owner's action never waits on it", () => {
    let stored = false;
    const store: LogStore = () => new Promise(() => { stored = true; });
    log({ level: "info", area: "ai", event: "ai.chat", message: "chat answered", workspaceId }, store);
    expect(stored).toBe(false);
  });

  it("stores the entry with its links and a safe event name", async () => {
    const store = vi.fn<LogStore>(async () => undefined);
    log({ level: "warn", area: "sync", event: "Bank Sync failed!", message: "timeout", details: { attempt: 2 }, workspaceId, jobId: "00000000-0000-4000-8000-000000000009" }, store);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await vi.waitFor(() => expect(store).toHaveBeenCalledTimes(1));
    expect(store.mock.calls[0]?.[0]).toMatchObject({ workspace_id: workspaceId, level: "warn", area: "sync", event: "bank_sync_failed_", message: "timeout", details: { attempt: 2 }, job_id: "00000000-0000-4000-8000-000000000009" });
  });

  it("reports a failed store instead of rejecting", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    log({ level: "info", area: "jobs", event: "job.start", message: "started", workspaceId }, async () => { throw new Error("database down"); });
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining("could not be stored"), "database down"));
  });

  it("prints warnings and errors, and keeps info quiet", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined), info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const store = vi.fn<LogStore>(async () => undefined);
    log({ level: "warn", area: "server", event: "auth.claims", message: "claims unavailable", workspaceId }, store);
    log({ level: "info", area: "server", event: "page.open", message: "opened", workspaceId }, store);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
  });
});

describe("logDetails", () => {
  it("keeps an error's name, message, code and cause", () => {
    const error = Object.assign(new Error("outer", { cause: new Error("inner") }), { code: "ECONNRESET" });
    expect(logDetails({ error })).toMatchObject({ error: { name: "Error", message: "outer", code: "ECONNRESET", cause: { message: "inner" } } });
  });

  it("shortens very long text and never stores raw bytes", () => {
    const details = logDetails({ text: "x".repeat(25_000), audio: new Uint8Array(10) }) as { text: string; audio: string };
    expect(details.text.length).toBeLessThan(20_100);
    expect(details.text).toContain("5000 more characters");
    expect(details.audio).toBe("[10 bytes]");
  });
});
