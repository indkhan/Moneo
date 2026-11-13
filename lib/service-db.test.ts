import { afterEach, expect, it, vi } from "vitest";
import { isTransientDbError, retryingFetch } from "./service-db";

afterEach(() => { vi.useRealTimers(); });

const gateway = () => new Response(JSON.stringify({ message: "rest is not reachable", error: "socket hang up" }), { status: 502 });
const refused = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:54321"), { code: "ECONNREFUSED" }) });
const hangUp = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });

// The desktop gateway answered 502 "rest is not reachable" to parallel agents and the run gave up.
it("reads that hit a dropped gateway are tried again until the database answers", async () => {
  vi.useFakeTimers();
  const base = vi.fn<typeof fetch>().mockResolvedValueOnce(gateway()).mockRejectedValueOnce(hangUp()).mockResolvedValueOnce(new Response("[]", { status: 200 }));
  const pending = retryingFetch([10, 20], base)("http://db/rest/v1/transactions", { method: "GET" });
  await vi.runAllTimersAsync();
  expect((await pending).status).toBe(200);
  expect(base).toHaveBeenCalledTimes(3);
});

it("repeats a write only when the connection was refused, never after a gateway error", async () => {
  vi.useFakeTimers();
  const write = { method: "POST", body: "{}" };
  const ambiguous = vi.fn<typeof fetch>().mockResolvedValue(gateway());
  expect((await retryingFetch([10], ambiguous)("http://db/rest/v1/rpc/reserve", write)).status).toBe(502);
  const dropped = vi.fn<typeof fetch>().mockRejectedValue(hangUp());
  await expect(retryingFetch([10], dropped)("http://db/rest/v1/agent_proposals", write)).rejects.toThrow("fetch failed");
  expect(ambiguous).toHaveBeenCalledTimes(1); expect(dropped).toHaveBeenCalledTimes(1);

  const neverReached = vi.fn<typeof fetch>().mockRejectedValueOnce(refused()).mockResolvedValueOnce(new Response("{}", { status: 201 }));
  const pending = retryingFetch([10], neverReached)("http://db/rest/v1/agent_proposals", write);
  await vi.runAllTimersAsync();
  expect((await pending).status).toBe(201);
});

it("gives up after the last pause and returns what the database said", async () => {
  vi.useFakeTimers();
  const base = vi.fn<typeof fetch>().mockImplementation(async () => gateway());
  const pending = retryingFetch([10, 20], base)("http://db/rest/v1/transactions");
  await vi.runAllTimersAsync();
  expect((await pending).status).toBe(502);
  expect(base).toHaveBeenCalledTimes(3);
});

it.each([
  [new Error("rest is not reachable"), true],
  [{ message: "TypeError: fetch failed", code: "" }, true],
  [hangUp(), true],
  [new Error("duplicate key value violates unique constraint"), false],
  [new Error("AI access to transactions is disabled in Settings"), false],
])("classifies %o as transient: %s", (error, expected) => {
  expect(isTransientDbError(error)).toBe(expected);
});
