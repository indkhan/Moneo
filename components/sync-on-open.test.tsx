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
