import { beforeEach, expect, it, vi } from "vitest";
import { useStateDraft } from "./use-state-draft";

// Exercise successive host renders without needing a DOM or a new test dependency.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], index: 0, refresh: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: (initial: unknown) => {
  const index = hooks.index++;
  if (!(index in hooks.slots)) hooks.slots[index] = initial;
  return [hooks.slots[index], (next: unknown) => { hooks.slots[index] = typeof next === "function" ? next(hooks.slots[index]) : next; }];
} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: hooks.refresh }) }));
beforeEach(() => { hooks.slots = []; hooks.index = 0; hooks.refresh.mockClear(); });
const save = vi.fn<(form: FormData) => Promise<{ conflict: true }>>().mockResolvedValue({ conflict: true });
it("shows transported validation feedback while preserving the rejected draft and revision", async () => {
  const rejected = vi.fn(async () => ({ error: "Unknown paying or receiving account" }));
  function RenderRejectedDraft(value = { accountId: "owned" }, version = 1) { hooks.index = 0; return useStateDraft(value, version, rejected); }
  RenderRejectedDraft().edit({ accountId: "missing" });
  await RenderRejectedDraft().action(new FormData());
  expect(RenderRejectedDraft()).toMatchObject({ value: { accountId: "missing" }, expectedVersion: 1, busy: false, conflict: false, message: "Unknown paying or receiving account" });
  expect(hooks.refresh).not.toHaveBeenCalled();
});
function RenderDraft(value = { costMinor: 100 }, version = 1) { hooks.index = 0; return useStateDraft(value, version, save); }
it("uses the acknowledged save revision for edits made before refreshed props arrive", async () => {
  const acknowledged = vi.fn(async () => ({ saved: true, version: 2, value: { costMinor: 300 } } as const));
  function SavedDraft(value = { costMinor: 100 }, version = 1) { hooks.index = 0; return useStateDraft(value, version, acknowledged); }
  SavedDraft().edit({ costMinor: 300 });
  await SavedDraft().action(new FormData());
  expect(SavedDraft()).toMatchObject({ value: { costMinor: 300 }, expectedVersion: 2, busy: false, conflict: false });
  SavedDraft().edit({ costMinor: 400 });
  expect(SavedDraft({ costMinor: 300 }, 2)).toMatchObject({ value: { costMinor: 400 }, expectedVersion: 2, conflict: false });
  expect(SavedDraft({ costMinor: 500 }, 3).conflict).toBe(true);
});
it("retains normalized acknowledged values until fresh props arrive, then follows newer clean state", async () => {
  const acknowledged = vi.fn(async () => ({ saved: true, version: 2, value: { costMinor: 330 } } as const));
  function SavedDraft(value = { costMinor: 100 }, version = 1) { hooks.index = 0; return useStateDraft(value, version, acknowledged); }
  SavedDraft().edit({ costMinor: 300 });
  await SavedDraft().action(new FormData());
  expect(SavedDraft()).toMatchObject({ value: { costMinor: 330 }, expectedVersion: 2, conflict: false });
  expect(SavedDraft({ costMinor: 400 }, 3)).toMatchObject({ value: { costMinor: 400 }, expectedVersion: 3, conflict: false });
});
it("pins dirty inputs to their original revision across a server refresh", async () => {
  RenderDraft().edit({ costMinor: 300 });
  const refreshed = RenderDraft({ costMinor: 200 }, 2);
  expect(refreshed.value).toEqual({ costMinor: 300 });
  expect(refreshed.expectedVersion).toBe(1);
  expect(refreshed.conflict).toBe(true);
  await refreshed.action(new FormData());
  expect(save.mock.lastCall?.[0].get("expectedVersion")).toBe("1");
  expect(RenderDraft({ costMinor: 200 }, 2).value).toEqual({ costMinor: 300 });
});
it("updates clean inputs and only changes a draft base after an explicit choice", () => {
  RenderDraft();
  expect(RenderDraft({ costMinor: 200 }, 2).value).toEqual({ costMinor: 200 });
  RenderDraft({ costMinor: 200 }, 2).edit({ costMinor: 300 });
  RenderDraft({ costMinor: 400 }, 3).rebase();
  expect(RenderDraft({ costMinor: 400 }, 3)).toMatchObject({ value: { costMinor: 300 }, expectedVersion: 3, conflict: false });
  RenderDraft({ costMinor: 400 }, 3).reload();
  expect(RenderDraft({ costMinor: 400 }, 3)).toMatchObject({ value: { costMinor: 400 }, expectedVersion: 3, conflict: false });
});
it("checks saved inputs without discarding a dirty draft", () => {
  RenderDraft().edit({ costMinor: 300 });
  RenderDraft().refresh();
  expect(hooks.refresh).toHaveBeenCalledOnce();
  expect(RenderDraft()).toMatchObject({ value: { costMinor: 300 }, expectedVersion: 1 });
});
