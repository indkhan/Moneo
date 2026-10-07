import { afterEach, expect, it, vi } from "vitest";
import { POST } from "./route";
const fixture = vi.hoisted(() => ({ denied: false, error: null as null | { code: string; message: string }, calls: [] as { name: string; args: unknown }[] }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => {
  if (fixture.denied) throw new Error("Unauthorized");
  return { supabase: { rpc: async (name: string, args: unknown) => { fixture.calls.push({ name, args }); return { data: { resolutionId: "saved" }, error: fixture.error }; } } };
} }));
afterEach(() => { fixture.denied = false; fixture.error = null; fixture.calls = []; });
const pendingId = "11111111-1111-4111-a111-111111111111", requestId = "22222222-2222-4222-a222-222222222222";
const input = { action: "resolve", pendingId, pendingVersion: 0, expectedReleasedMinor: "0", releasedMinor: "2000", note: "Bank confirmed cancellation", requestId, postedId: null, postedVersion: null };
const request = (body: unknown) => new Request("http://localhost/api/pending-holds", { method: "POST", body: JSON.stringify(body) });
it("requires authentication before releasing or undoing a hold", async () => {
  fixture.denied = true;
  expect((await POST(request(input))).status).toBe(401);
  expect(fixture.calls).toEqual([]);
});
it.each(["0", "-1", "1.5", "9223372036854775808", 2000])("rejects invalid exact release %s without a database write", async releasedMinor => {
  expect((await POST(request({ ...input, releasedMinor }))).status).toBe(400);
  expect(fixture.calls).toEqual([]);
});
it("reports a stale lifecycle conflict without treating it as successful", async () => {
  fixture.error = { code: "PT409", message: "Pending evidence changed" };
  const response = await POST(request(input));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "Pending evidence changed" });
  expect(fixture.calls[0].args).toMatchObject({ p_pending_id: pendingId, p_expected_released_minor: "0", p_released_minor: "2000", p_posted_id: null });
});
it("undo sends only the owned receipt identity to the trusted RPC", async () => {
  expect((await POST(request({ action: "undo", resolutionId: requestId }))).status).toBe(200);
  expect(fixture.calls).toEqual([{ name: "undo_pending_hold_resolution", args: { p_resolution_id: requestId } }]);
});
