import { beforeEach, describe, expect, it, vi } from "vitest";

const HOUR = 60 * 60_000;
const github = (tag: string) => Response.json({ tag_name: tag, body: "Faster imports" });
const load = () => import("./app-update");

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv("MONEO_DESKTOP", "");
  vi.stubEnv("MONEO_VERSION", "0.5.0");
});

describe("isNewerVersion", () => {
  it("compares versions by number, not by text", async () => {
    const { isNewerVersion } = await load();
    expect(isNewerVersion("v0.10.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.5.0", "0.5.0")).toBe(false);
    expect(isNewerVersion("0.4.9", "0.5.0")).toBe(false);
    expect(isNewerVersion("nightly", "0.5.0")).toBe(false);
  });
});

describe("source installation", () => {
  it("offers a newer published release and asks GitHub at most four times a day", async () => {
    const fetch = vi.fn(async () => github("v0.6.0"));
    vi.stubGlobal("fetch", fetch);
    const { availableUpdate } = await load();
    expect(await availableUpdate()).toEqual({ kind: "source", current: "0.5.0", latest: "0.6.0", notes: "Faster imports", url: "https://github.com/indkhan/Moneo/releases/tag/v0.6.0" });
    vi.advanceTimersByTime(5 * HOUR);
    await availableUpdate();
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(HOUR);
    await availableUpdate();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("offers nothing when the running version is the published one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => github("v0.5.0")));
    const { availableUpdate } = await load();
    expect(await availableUpdate()).toBeNull();
  });

  it("offers nothing when GitHub cannot be reached, without asking again on every page", async () => {
    const fetch = vi.fn(async () => { throw new TypeError("offline"); });
    vi.stubGlobal("fetch", fetch);
    const { availableUpdate } = await load();
    expect(await availableUpdate()).toBeNull();
    expect(await availableUpdate()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("desktop app", () => {
  it("asks the desktop updater once, then reuses its answer", async () => {
    vi.stubEnv("MONEO_DESKTOP", "1");
    vi.stubEnv("MONEO_DESKTOP_BRIDGE", "http://127.0.0.1:5000/token");
    let state = "idle";
    let checks = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/update/check")) { checks += 1; state = "current"; }
      return Response.json({ current: "0.5.0", latest: state === "idle" ? undefined : "0.5.0", state, installs: true });
    }));
    const { availableUpdate } = await load();
    expect(await availableUpdate()).toBeNull();
    expect(await availableUpdate()).toBeNull();
    expect(checks).toBe(1);
  });
});
