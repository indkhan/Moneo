import { expect, it, vi } from "vitest";
import { GET } from "./route";
const fixture = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: fixture.auth }));
vi.mock("@/lib/finance/evidence-view", () => ({ readEvidenceView: fixture.read }));
const id = "00000000-0000-4000-8000-000000000001";
it("requires an owned session, exposes only actual retained support and rejects nonexistent metrics", async () => {
  fixture.auth.mockRejectedValueOnce(new Error("Unauthorized"));
  expect((await GET(new Request(`http://localhost/api/evidence/${id}`), { params: Promise.resolve({ id }) })).status).toBe(401);
  fixture.auth.mockResolvedValue({ workspace: { id: "owned" } });
  fixture.read.mockResolvedValueOnce(null);
  expect((await GET(new Request(`http://localhost/api/evidence/${id}`), { params: Promise.resolve({ id }) })).status).toBe(404);
  const view = { metric: { valueMinor: "25" }, freshness: { status: "stale" }, supportingRecords: [{ id: "actual", record: { amount_minor: "-25" } }] };
  fixture.read.mockResolvedValueOnce(view);
  const response = await GET(new Request(`http://localhost/api/evidence/${id}?metric=spending`), { params: Promise.resolve({ id }) });
  expect(await response.json()).toEqual(view);
  fixture.read.mockRejectedValueOnce(new Error("Metric unavailable"));
  expect((await GET(new Request(`http://localhost/api/evidence/${id}?metric=missing`), { params: Promise.resolve({ id }) })).status).toBe(404);
});
