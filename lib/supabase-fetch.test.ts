import { afterEach, expect, it, vi } from "vitest";
import { supabaseFetch } from "./supabase-fetch";

afterEach(() => vi.unstubAllGlobals());

it("limits recovery to one retry and leaves token writes alone", async () => {
  const fetch = vi.fn(async () => Response.json({}, { status: 503 }));
  vi.stubGlobal("fetch", fetch);
  expect((await supabaseFetch("http://127.0.0.1:54521/auth/v1/user")).status).toBe(503);
  expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockClear();
  expect((await supabaseFetch("http://127.0.0.1:54521/auth/v1/token", { method: "POST" })).status).toBe(503);
  expect(fetch).toHaveBeenCalledOnce();
});

it("preserves cancellation instead of retrying an aborted request", async () => {
  const controller = new AbortController();
  const failure = new TypeError("fetch failed");
  const fetch = vi.fn(async () => { controller.abort(); throw failure; });
  vi.stubGlobal("fetch", fetch);
  const options = { signal: controller.signal };
  await expect(supabaseFetch("http://127.0.0.1:54521/auth/v1/user", options)).rejects.toBe(failure);
  expect(fetch).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:54521/auth/v1/user", options);
});
