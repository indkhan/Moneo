import { afterEach, expect, it, vi } from "vitest";
import { syncIfVisible } from "./sync-on-open";

afterEach(() => vi.unstubAllGlobals());
const setup = (visibilityState: string, fetcher: () => Promise<Response>) => {
  vi.stubGlobal("document", { visibilityState });
  const fetchMock = vi.fn(fetcher);
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, refresh: vi.fn() };
};

it("updates the page once fresher numbers landed", async () => {
  const { fetchMock, refresh } = setup("visible", async () => Response.json({ refresh: true }));
  await syncIfVisible(refresh);
  expect(fetchMock).toHaveBeenCalledWith("/api/sync/open", { method: "POST" });
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("reports a request that failed before reaching any bank, offline or refused", async () => {
  for (const fetcher of [async () => { throw new Error("offline"); }, async () => new Response("", { status: 503 })]) {
    const { refresh } = setup("visible", fetcher);
    const failed = vi.fn();
    await syncIfVisible(refresh, failed);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  }
  const fine = setup("visible", async () => Response.json({ refresh: false }));
  const failed = vi.fn();
  await syncIfVisible(fine.refresh, failed);
  expect(failed).not.toHaveBeenCalled();
});

it("leaves the page alone when nothing ran, when offline, and when the app is in the background", async () => {
  const idle = setup("visible", async () => Response.json({ refresh: false }));
  await syncIfVisible(idle.refresh);
  expect(idle.refresh).not.toHaveBeenCalled();

  const offline = setup("visible", async () => { throw new Error("offline"); });
  await syncIfVisible(offline.refresh);
  expect(offline.refresh).not.toHaveBeenCalled();

  const hidden = setup("hidden", async () => Response.json({ refresh: true }));
  await syncIfVisible(hidden.refresh);
  expect(hidden.fetchMock).not.toHaveBeenCalled();
});
