import { beforeEach, expect, it, vi } from "vitest";
import { saveSettings } from "./actions";
import { requireWorkspace } from "@/lib/auth";
import { listFreeModels, modelForSettings } from "@/lib/ai/provider";
import { generateText } from "ai";
import { settingsSchema } from "@/lib/settings";

vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("@/lib/ai/provider", () => ({ listFreeModels: vi.fn(), modelForSettings: vi.fn() }));
vi.mock("ai", () => ({ generateText: vi.fn() }));

function form() {
  const data = new FormData();
  for (const [key, value] of Object.entries({ timezone: "Europe/Berlin", locale: "en-GB", theme: "dark", display_currency: "EUR", summary_cadence: "none", summary_time: "09:00" })) data.set(key, value);
  data.append("ai_data_scopes", "accounts");
  return data;
}

function workspaceWith(previousModel: string | null, rpc: ReturnType<typeof vi.fn>) {
  return {
    workspace: { id: "owned" },
    supabase: { rpc, from: vi.fn() },
    settings: settingsSchema.parse({ openrouter_model: previousModel }),
  } as unknown as Awaited<ReturnType<typeof requireWorkspace>>;
}

beforeEach(() => {
  vi.mocked(listFreeModels).mockReset();
  vi.mocked(modelForSettings).mockReset();
  vi.mocked(generateText).mockReset();
  vi.mocked(requireWorkspace).mockReset();
  vi.mocked(generateText).mockResolvedValue({ text: "OK" } as unknown as Awaited<ReturnType<typeof generateText>>);
});

it("rejects a paid/unavailable model before saving any preference", async () => {
  const data = form(); data.set("openrouter_model", "paid");
  const rpc = vi.fn();
  vi.mocked(listFreeModels).mockResolvedValue([]);
  vi.mocked(requireWorkspace).mockResolvedValue(workspaceWith(null, rpc));
  expect(await saveSettings({}, data)).toMatchObject({ error: expect.stringContaining("verified free") });
  expect(requireWorkspace).toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalled();
});

it("authenticates before checking or calling the provider", async () => {
  const data = form(); data.set("openrouter_model", "free");
  vi.mocked(requireWorkspace).mockRejectedValue(new Error("Authentication required"));
  vi.mocked(listFreeModels).mockClear();
  vi.mocked(generateText).mockClear();
  expect(await saveSettings({}, data)).toEqual({ error: "Authentication required" });
  expect(listFreeModels).not.toHaveBeenCalled();
  expect(generateText).not.toHaveBeenCalled();
});

it("persists exact scoped preferences for the authenticated workspace", async () => {
  const rpc = vi.fn(async () => ({ error: null }));
  vi.mocked(requireWorkspace).mockResolvedValue(workspaceWith(null, rpc));
  expect(await saveSettings({}, form())).toEqual({ saved: true });
  expect(rpc).toHaveBeenCalledWith("save_workspace_preferences", expect.objectContaining({ p_workspace_id: "owned", p_display_currency: "EUR", p_preferences: expect.objectContaining({ theme: "dark", ai_data_scopes: ["accounts"], openrouter_model: null }) }));
});

it("rejects an unsupported display currency before persisting it", async () => {
  const rpc = vi.fn();
  vi.mocked(requireWorkspace).mockResolvedValue(workspaceWith(null, rpc));
  const data = form(); data.set("display_currency", "ZZZ");
  expect(await saveSettings({}, data)).toMatchObject({ error: expect.stringContaining("Invalid currency") });
  expect(rpc).not.toHaveBeenCalled();
});

it("saves scope revocation with an unchanged explicit model during a catalogue outage without a completion", async () => {
  const rpc = vi.fn(async () => ({ error: null }));
  vi.mocked(requireWorkspace).mockResolvedValue(workspaceWith("explicit-free", rpc));
  vi.mocked(listFreeModels).mockRejectedValue(new Error("Synthetic provider outage"));
  vi.mocked(generateText).mockRejectedValue(new Error("Synthetic provider outage"));
  const data = form();
  data.set("openrouter_model", "explicit-free");
  data.delete("ai_data_scopes");
  data.set("summary_cadence", "none");
  data.set("display_currency", "EUR");
  expect(await saveSettings({}, data)).toEqual({ saved: true });
  expect(listFreeModels).not.toHaveBeenCalled();
  expect(generateText).not.toHaveBeenCalled();
  expect(modelForSettings).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledWith("save_workspace_preferences", expect.objectContaining({
    p_preferences: expect.objectContaining({ openrouter_model: "explicit-free", ai_data_scopes: [], summary_cadence: "none" }),
  }));
});

it("saves unrelated display changes with an unchanged explicit model without a completion", async () => {
  const rpc = vi.fn(async () => ({ error: null }));
  vi.mocked(requireWorkspace).mockResolvedValue(workspaceWith("explicit-free", rpc));
  const data = form();
  data.set("openrouter_model", "explicit-free");
  data.set("theme", "light");
  data.set("display_currency", "USD");
  expect(await saveSettings({}, data)).toEqual({ saved: true });
  expect(listFreeModels).not.toHaveBeenCalled();
  expect(generateText).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledWith("save_workspace_preferences", expect.objectContaining({ p_display_currency: "USD" }));
});

it("reports a targeted error and preserves the previous selection for an invalid newly selected model", async () => {
  const rpc = vi.fn();
  vi.mocked(requireWorkspace).mockResolvedValue(workspaceWith("old-free", rpc));
  vi.mocked(listFreeModels).mockResolvedValue([{ id: "old-free", name: "Old" }]);
  const data = form(); data.set("openrouter_model", "paid");
  expect(await saveSettings({}, data)).toMatchObject({ error: expect.stringContaining("verified free") });
  expect(generateText).not.toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalled();
});

it("preserves the previous selection when the catalogue is unavailable for a newly selected model", async () => {
  const rpc = vi.fn();
  vi.mocked(requireWorkspace).mockResolvedValue(workspaceWith("old-free", rpc));
  vi.mocked(listFreeModels).mockRejectedValue(new Error("Synthetic provider outage"));
  const data = form(); data.set("openrouter_model", "new-free");
  expect(await saveSettings({}, data)).toMatchObject({ error: expect.stringContaining("Synthetic provider outage") });
  expect(rpc).not.toHaveBeenCalled();
});

it("still live-checks a newly selected model and rejects an empty reply without saving", async () => {
  const rpc = vi.fn();
  vi.mocked(requireWorkspace).mockResolvedValue(workspaceWith(null, rpc));
  vi.mocked(listFreeModels).mockResolvedValue([{ id: "new-free", name: "New" }]);
  vi.mocked(modelForSettings).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof modelForSettings>>);
  vi.mocked(generateText).mockResolvedValue({ text: "  " } as unknown as Awaited<ReturnType<typeof generateText>>);
  const data = form(); data.set("openrouter_model", "new-free");
  expect(await saveSettings({}, data)).toMatchObject({ error: expect.stringContaining("no usable response") });
  expect(generateText).toHaveBeenCalledOnce();
  expect(rpc).not.toHaveBeenCalled();
});

it("leaves output headroom for a usable reasoning model before saving its selection", async () => {
  const rpc = vi.fn(async () => ({ error: null }));
  vi.mocked(requireWorkspace).mockResolvedValue(workspaceWith(null, rpc));
  vi.mocked(listFreeModels).mockResolvedValue([{ id: "new-free", name: "New" }]);
  vi.mocked(modelForSettings).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof modelForSettings>>);
  // The provider counts reasoning and visible output against the same limit.
  vi.mocked(generateText).mockImplementation(async options => ({ text: (options.maxOutputTokens ?? 0) > 100 ? "OK" : "" }) as Awaited<ReturnType<typeof generateText>>);
  const data = form(); data.set("openrouter_model", "new-free");
  expect(await saveSettings({}, data)).toEqual({ saved: true });
  expect(rpc).toHaveBeenCalledOnce();
});
