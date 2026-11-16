import { afterEach, describe, expect, it, vi } from "vitest";

const auth = { session: "s1", getUser: vi.fn() };
const savedSettings = vi.fn(async () => ({ error: null }));
vi.mock("@/lib/supabase-server", () => ({ createClient: async () => ({
  auth: { getClaims: async () => ({ data: { claims: { sub: "u1", session_id: auth.session } } }), getUser: auth.getUser },
  from: () => ({ upsert: savedSettings, select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: "w1", owner_id: "u1", display_currency: "EUR", workspace_settings: null }, error: null }) }) }) }),
}) }));
const { requireWorkspace } = await import("./auth");
const signedIn = { data: { user: { id: "u1" } }, error: null };

afterEach(() => { vi.useRealTimers(); auth.getUser.mockReset(); });

describe("requireWorkspace session confirmation", () => {
  it("confirms a session with Supabase Auth once a minute, per session", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    auth.session = "minute";
    auth.getUser.mockResolvedValue(signedIn);
    await requireWorkspace();
    await requireWorkspace();
    expect(auth.getUser).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_001);
    const loaded = await requireWorkspace();
    expect(loaded.workspace.id).toBe("w1");
    expect(loaded.workspace.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(savedSettings).toHaveBeenCalledWith({ workspace_id: "w1", timezone: loaded.workspace.timezone }, { onConflict: "workspace_id", ignoreDuplicates: true });
    expect(auth.getUser).toHaveBeenCalledTimes(2);
    auth.session = "another-device";
    await requireWorkspace();
    expect(auth.getUser).toHaveBeenCalledTimes(3);
  });

  it("never remembers a failed confirmation", async () => {
    auth.session = "revoked";
    auth.getUser.mockResolvedValue({ data: { user: null }, error: new Error("session not found") });
    await expect(requireWorkspace()).rejects.toThrow("Unauthorized");
    await expect(requireWorkspace()).rejects.toThrow("Unauthorized");
    expect(auth.getUser).toHaveBeenCalledTimes(2);
  });

  it("treats an auth outage as unavailable, not as a signed-out owner", async () => {
    auth.session = "outage";
    auth.getUser.mockResolvedValue({ data: { user: null }, error: Object.assign(new Error("database error"), { status: 500 }) });
    await expect(requireWorkspace()).rejects.toThrow("Workspace unavailable");
  });

  it("rejects a confirmed user that is not the token's subject", async () => {
    auth.session = "mismatch";
    auth.getUser.mockResolvedValue({ data: { user: { id: "someone-else" } }, error: null });
    await expect(requireWorkspace()).rejects.toThrow("Unauthorized");
  });
});
