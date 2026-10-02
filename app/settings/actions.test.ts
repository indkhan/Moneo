import { expect, it, vi } from "vitest";
import { saveSettings } from "./actions";
import { requireWorkspace } from "@/lib/auth";
import { listFreeModels } from "@/lib/ai/provider";

vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("@/lib/ai/provider", () => ({ listFreeModels: vi.fn() }));

function form() {
  const data = new FormData();
  for (const [key, value] of Object.entries({ timezone: "Europe/Berlin", locale: "en-GB", theme: "dark", display_currency: "EUR", summary_cadence: "none", summary_time: "09:00" })) data.set(key, value);
  data.append("ai_data_scopes", "accounts");
  return data;
}

it("rejects a paid/unavailable model before saving any preference", async () => {
  const data = form(); data.set("openrouter_model", "paid");
  vi.mocked(listFreeModels).mockResolvedValue([]);
  vi.mocked(requireWorkspace).mockResolvedValue({ workspace: { id: "owned" }, supabase: { from: vi.fn() } } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
  expect(await saveSettings({}, data)).toMatchObject({ error: expect.stringContaining("verified free") });
  expect(requireWorkspace).toHaveBeenCalled();
});

it("authenticates before checking or calling the provider", async () => {
  const data = form(); data.set("openrouter_model", "free");
  vi.mocked(requireWorkspace).mockRejectedValue(new Error("Authentication required"));
  vi.mocked(listFreeModels).mockClear();
  expect(await saveSettings({}, data)).toEqual({ error: "Authentication required" });
  expect(listFreeModels).not.toHaveBeenCalled();
});

it("persists exact scoped preferences for the authenticated workspace", async () => {
  const rpc = vi.fn(async () => ({ error: null }));
  vi.mocked(requireWorkspace).mockResolvedValue({ workspace: { id: "owned" }, supabase: { rpc } } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
  expect(await saveSettings({}, form())).toEqual({ saved: true });
  expect(rpc).toHaveBeenCalledWith("save_workspace_preferences", expect.objectContaining({ p_workspace_id: "owned", p_display_currency: "EUR", p_preferences: expect.objectContaining({ theme: "dark", ai_data_scopes: ["accounts"], openrouter_model: null }) }));
});

it("rejects an unsupported display currency before persisting it", async () => {
  const rpc = vi.fn();
  vi.mocked(requireWorkspace).mockResolvedValue({ workspace: { id: "owned" }, supabase: { rpc } } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
  const data = form(); data.set("display_currency", "ZZZ");
  expect(await saveSettings({}, data)).toMatchObject({ error: expect.stringContaining("Invalid currency") });
  expect(rpc).not.toHaveBeenCalled();
});
