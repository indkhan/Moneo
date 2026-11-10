import { beforeEach, expect, it, vi } from "vitest";
import { headers } from "next/headers";
import { requireWorkspace } from "@/lib/auth";
import { applicationState, changeStartup, checkApplicationRelease, saveApplicationPreferences, type ApplicationState } from "@/lib/application";
import { checkApplicationUpdate, installApplicationUpdate, saveApplication } from "./application-actions";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("@/lib/application", async original => ({
  ...await original<typeof import("@/lib/application")>(), applicationState: vi.fn(), changeStartup: vi.fn(), checkApplicationRelease: vi.fn(), saveApplicationPreferences: vi.fn(),
}));

const state: ApplicationState = { startup: false, supported: true, local: true, openBrowser: true, checkUpdates: false, version: "synthetic", managed: false, release: null, checkedAt: null };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireWorkspace).mockResolvedValue({} as Awaited<ReturnType<typeof requireWorkspace>>);
  vi.mocked(headers).mockResolvedValue(new Headers({ host: "localhost:3000" }) as Awaited<ReturnType<typeof headers>>);
  vi.mocked(applicationState).mockResolvedValue(state);
});

it("requires an owner session before any startup, release or installation operation", async () => {
  vi.mocked(requireWorkspace).mockRejectedValue(new Error("Unauthorized"));
  await expect(saveApplication(state, new FormData())).rejects.toThrow("Unauthorized");
  await expect(checkApplicationUpdate()).rejects.toThrow("Unauthorized");
  await expect(installApplicationUpdate({})).rejects.toThrow("Unauthorized");
  expect(changeStartup).not.toHaveBeenCalled();
  expect(checkApplicationRelease).not.toHaveBeenCalled();
  expect(saveApplicationPreferences).not.toHaveBeenCalled();
});

it("refuses startup and update operations from another device even with an owner session", async () => {
  vi.mocked(headers).mockResolvedValue(new Headers({ host: "localhost:3000", "x-forwarded-host": "synthetic.ts.net" }) as Awaited<ReturnType<typeof headers>>);
  await expect(saveApplication(state, new FormData())).rejects.toThrow("computer running");
  await expect(checkApplicationUpdate()).rejects.toThrow("computer running");
  await expect(installApplicationUpdate({})).rejects.toThrow("computer running");
  expect(changeStartup).not.toHaveBeenCalled();
  expect(checkApplicationRelease).not.toHaveBeenCalled();
  expect(saveApplicationPreferences).not.toHaveBeenCalled();
});
