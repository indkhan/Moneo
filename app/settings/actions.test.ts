import { beforeEach, expect, it, vi } from "vitest";
import { resetAllData, saveSettings } from "./actions";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { modelForSettings } from "@/lib/ai/provider";
import { generateText } from "ai";
import { settingsSchema } from "@/lib/settings";

vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("@/lib/ai/provider", () => ({ modelForSettings: vi.fn() }));
vi.mock("ai", () => ({ generateText: vi.fn() }));

function form() {
  const data = new FormData();
  for (const [key, value] of Object.entries({ timezone: "Europe/Berlin", locale: "en-GB", theme: "dark", display_currency: "EUR", summary_cadence: "none", summary_time: "09:00" })) data.set(key, value);
  data.append("ai_data_scopes", "accounts");
  return data;
}

function workspaceWith(previousChat: string | null, rpc: ReturnType<typeof vi.fn>) {
  return {
    workspace: { id: "owned" },
    supabase: { rpc, from: vi.fn() },
    settings: settingsSchema.parse({ ai_models: previousChat ? { chat: previousChat } : {} }),
  } as unknown as Awaited<ReturnType<typeof requireWorkspace>>;
}

beforeEach(() => {
  vi.mocked(modelForSettings).mockReset();
  vi.mocked(generateText).mockReset();
  vi.mocked(requireWorkspace).mockReset();
  vi.mocked(generateText).mockResolvedValue({ text: "OK" } as unknown as Awaited<ReturnType<typeof generateText>>);
});

it("authenticates before calling the provider", async () => {
  const data = form(); data.set("model:chat", "gpt-x");
  vi.mocked(requireWorkspace).mockRejectedValue(new Error("Authentication required"));
  expect(await saveSettings({}, data)).toEqual({ error: "Authentication required" });
  expect(generateText).not.toHaveBeenCalled();
});

it("persists exact scoped preferences with blank models left as defaults", async () => {
  const rpc = vi.fn(async () => ({ error: null }));
  vi.mocked(requireWorkspace).mockResolvedValue(workspaceWith(null, rpc));
  const data = form(); data.set("model:chat", "  ");
  expect(await saveSettings({}, data)).toEqual({ saved: true });
  expect(rpc).toHaveBeenCalledWith("save_workspace_preferences", expect.objectContaining({ p_workspace_id: "owned", p_display_currency: "EUR", p_preferences: expect.objectContaining({ theme: "dark", ai_data_scopes: ["accounts"], ai_models: {} }) }));
});

it("rejects an unsupported display currency before persisting it", async () => {
  const rpc = vi.fn();
  vi.mocked(requireWorkspace).mockResolvedValue(workspaceWith(null, rpc));
  const data = form(); data.set("display_currency", "ZZZ");
  expect(await saveSettings({}, data)).toMatchObject({ error: expect.stringContaining("Invalid currency") });
  expect(rpc).not.toHaveBeenCalled();
});

it("saves an unchanged model during a provider outage without a completion", async () => {
  const rpc = vi.fn(async () => ({ error: null }));
  vi.mocked(requireWorkspace).mockResolvedValue(workspaceWith("gpt-old", rpc));
  vi.mocked(generateText).mockRejectedValue(new Error("Synthetic provider outage"));
  const data = form(); data.set("model:chat", "gpt-old"); data.delete("ai_data_scopes");
  expect(await saveSettings({}, data)).toEqual({ saved: true });
  expect(generateText).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledWith("save_workspace_preferences", expect.objectContaining({
    p_preferences: expect.objectContaining({ ai_models: { chat: "gpt-old" }, ai_data_scopes: [] }),
  }));
});

it("live-checks only the changed agent and saves it", async () => {
  const rpc = vi.fn(async () => ({ error: null }));
  vi.mocked(requireWorkspace).mockResolvedValue(workspaceWith("gpt-old", rpc));
  const data = form(); data.set("model:chat", "gpt-old"); data.set("model:imports", "gpt-new");
  expect(await saveSettings({}, data)).toEqual({ saved: true });
  expect(modelForSettings).toHaveBeenCalledExactlyOnceWith(expect.anything(), "imports");
  expect(rpc).toHaveBeenCalledWith("save_workspace_preferences", expect.objectContaining({ p_preferences: expect.objectContaining({ ai_models: { chat: "gpt-old", imports: "gpt-new" } }) }));
});

it("refuses a changed model that fails or replies empty, preserving the previous settings", async () => {
  const rpc = vi.fn();
  vi.mocked(requireWorkspace).mockResolvedValue(workspaceWith("gpt-old", rpc));
  for (const reply of [Promise.reject(new Error("404 model not found")), Promise.resolve({ text: "  " })]) {
    reply.catch(() => {});
    vi.mocked(generateText).mockReturnValueOnce(reply as ReturnType<typeof generateText>);
    const data = form(); data.set("model:chat", "gpt-typo");
    expect(await saveSettings({}, data)).toMatchObject({ error: expect.stringContaining('"gpt-typo" did not respond') });
  }
  expect(rpc).not.toHaveBeenCalled();
});

function resetForm(confirmation: string) {
  const data = new FormData(); data.set("confirmation", confirmation); return data;
}

function resetWorkspaceWith(rpc: ReturnType<typeof vi.fn>, files: string[] = []) {
  const remaining = new Map([["imports", files.map(name => ({ name }))], ["artifacts", []]]);
  const remove = vi.fn(async (paths: string[]) => ({ data: paths, error: null }));
  const from = (bucket: string) => ({
    list: async () => ({ data: remaining.get(bucket) ?? [], error: null }),
    remove: async (paths: string[]) => { remaining.set(bucket, []); return remove(paths); },
  });
  return { remove, context: { workspace: { id: "owned" }, supabase: { rpc, storage: { from } } } as unknown as Awaited<ReturnType<typeof requireWorkspace>> };
}

it("requires a signed-in user before resetting anything", async () => {
  vi.mocked(requireWorkspace).mockRejectedValue(new Error("Unauthorized"));
  expect(await resetAllData({}, resetForm("RESET"))).toEqual({ error: expect.any(String) });
  expect(redirect).not.toHaveBeenCalled();
});

it("requires the exact RESET confirmation", async () => {
  const rpc = vi.fn();
  const { remove, context } = resetWorkspaceWith(rpc, ["a.csv"]);
  vi.mocked(requireWorkspace).mockResolvedValue(context);
  for (const typed of ["", "reset", "RESET "]) expect(await resetAllData({}, resetForm(typed))).toEqual({ error: "Type RESET to confirm" });
  expect(rpc).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
});

it("removes uploaded statements, calls the reset RPC and returns to Home", async () => {
  vi.mocked(redirect).mockClear();
  const rpc = vi.fn(async () => ({ error: null }));
  const { remove, context } = resetWorkspaceWith(rpc, ["a.csv", "b.xlsx"]);
  vi.mocked(requireWorkspace).mockResolvedValue(context);
  await resetAllData({}, resetForm("RESET"));
  expect(remove).toHaveBeenCalledWith(["owned/a.csv", "owned/b.xlsx"]);
  expect(rpc).toHaveBeenCalledWith("reset_workspace");
  expect(redirect).toHaveBeenCalledWith("/");
});

it("reports a failed reset instead of redirecting", async () => {
  vi.mocked(redirect).mockClear();
  const { context } = resetWorkspaceWith(vi.fn(async () => ({ error: { message: "boom" } })));
  vi.mocked(requireWorkspace).mockResolvedValue(context);
  expect(await resetAllData({}, resetForm("RESET"))).toEqual({ error: expect.stringContaining("could not be reset") });
  expect(redirect).not.toHaveBeenCalled();
});
