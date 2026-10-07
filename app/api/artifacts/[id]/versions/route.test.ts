import { beforeEach, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

const fixture = vi.hoisted(() => ({ rpc: vi.fn(), before: vi.fn(), limit: vi.fn(), validation: vi.fn(), serviceRpc: vi.fn(), serviceClient: vi.fn() }));
const id = "00000000-0000-4000-8000-000000000001";
const base = "00000000-0000-4000-8000-000000000002";
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ user: { id: "verified-user" }, workspace: { id: "workspace" }, supabase: {
  rpc: fixture.rpc,
  from: (table: string) => {
    const query = { select: () => query, eq: () => query, order: () => query,
      lt: (column: string, value: number) => { fixture.before(column, value); return query; },
      limit: async (count: number) => { fixture.limit(count); return { data: Array.from({ length: 21 }, (_, i) => ({ id: String(i), version: 50 - i, source: "input => ({})" })), error: null }; },
      maybeSingle: async () => ({ data: table === "artifacts" ? { id, kind: "custom_comparison", permissions: [], active_version_id: base } : { state: {} }, error: null }),
    }; return query;
  },
} }) }));
vi.mock("@supabase/supabase-js", () => ({ createClient: fixture.serviceClient }));
vi.mock("@/lib/artifacts/validate", () => ({ validateGeneratedCandidate: fixture.validation }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-key");
  fixture.serviceClient.mockReturnValue({ rpc: fixture.serviceRpc });
  fixture.serviceRpc.mockResolvedValue({ data: { id: "new", version: 3 }, error: null });
  fixture.validation.mockResolvedValue({ ok: true, manifest: {}, warnings: [] });
  fixture.rpc.mockResolvedValue({ data: { id: "new", version: 3 }, error: null });
});
const params = { params: Promise.resolve({ id }) };
const save = (body: unknown) => POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(body) }), params);
it("requires the version the user actually edited", async () => {
  expect((await save({ source: "input => ({})", manifest: {} })).status).toBe(400);
  expect(fixture.rpc).not.toHaveBeenCalled();
});
it("passes the expected active version into the locked activation RPC", async () => {
  expect((await save({ source: "input => ({})", manifest: {}, expectedActiveVersionId: base })).status).toBe(200);
  expect(fixture.serviceRpc).toHaveBeenCalledWith("save_validated_generated_artifact_version", expect.objectContaining({ p_expected_active_version_id: base, p_actor_id: "verified-user" }));
  expect(fixture.rpc).not.toHaveBeenCalled();
});
it.each(["PT409", "40001"])("returns a recoverable %s conflict from the transaction, including the current revision", async (code) => {
  fixture.serviceRpc.mockResolvedValue({ data: null, error: { code, message: "Active version changed" } });
  const response = await save({ source: "input => ({})", manifest: {}, expectedActiveVersionId: base });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ activeVersionId: base });
});
it("pages history by immutable version number with one lookahead row", async () => {
  const response = await GET(new Request("http://localhost?before=51"), params);
  const data = await response.json();
  expect(fixture.before).toHaveBeenCalledWith("version", 51);
  expect(fixture.limit).toHaveBeenCalledWith(21);
  expect(data.versions).toHaveLength(20);
  expect(data.nextCursor).toBe(31);
  expect(data.versions[0].source).toBeTruthy();
});
it("rejects malformed history cursors", async () => {
  expect((await GET(new Request("http://localhost?before=garbage"), params)).status).toBe(400);
});
it("restores trusted history by identity without accepting client source or validation status", async () => {
  const response = await save({ restoreTrustedVersionId: id, expectedActiveVersionId: base });
  expect(response.status).toBe(200);
  expect(fixture.rpc).toHaveBeenCalledWith("restore_trusted_artifact_version", {
    p_artifact_id: id, p_version_id: id, p_expected_active_version_id: base,
  });
  expect(fixture.validation).not.toHaveBeenCalled();
  expect((await save({ restoreTrustedVersionId: id, expectedActiveVersionId: base, source: "arbitrary", status: "validated" })).status).toBe(400);
});

it("validates exact source and stores the normalized manifest and server result", async () => {
  const source = 'input => ({summary:"Synthetic calculator"})';
  const submitted = { kind: "custom_comparison", runtime: "quickjs-calculator-v1", sdk: [] };
  const normalized = { ...submitted, params: {}, renderer: "trusted" };
  fixture.validation.mockResolvedValue({ ok: true, manifest: normalized, warnings: [] });
  expect((await save({ source, manifest: submitted, expectedActiveVersionId: base })).status).toBe(200);
  expect(fixture.validation).toHaveBeenCalledWith({ kind: "custom_comparison", source, manifest: submitted, permissions: [], state: {} });
  expect(fixture.serviceRpc).toHaveBeenCalledWith("save_validated_generated_artifact_version", {
    p_artifact_id: id, p_actor_id: "verified-user", p_source: source, p_manifest: normalized,
    p_status: "validated", p_error: "", p_expected_active_version_id: base,
  });
  expect(fixture.validation.mock.invocationCallOrder[0]).toBeLessThan(fixture.serviceRpc.mock.invocationCallOrder[0]);
  expect(fixture.serviceClient).toHaveBeenCalledWith("https://example.invalid", "synthetic-key", { auth: { persistSession: false, autoRefreshToken: false } });
});
it("stores failed validator diagnostics without claiming activation", async () => {
  const manifest = { kind: "custom_comparison", runtime: "quickjs-calculator-v1", sdk: [] };
  fixture.validation.mockResolvedValue({ ok: false, manifest, errors: ["Synthetic validation failure"] });
  const response = await save({ source: 'input => ({summary:"Synthetic"})', manifest, expectedActiveVersionId: base });
  expect(await response.json()).toMatchObject({ status: "failed", activeVersionPreserved: base });
  expect(fixture.serviceRpc).toHaveBeenCalledWith("save_validated_generated_artifact_version", expect.objectContaining({ p_status: "failed", p_error: "Synthetic validation failure", p_manifest: manifest }));
});
it.each(["actor", "actorId", "p_actor_id", "status", "p_status"])("rejects client %s assertions", async field => {
  expect((await save({ source: 'input => ({summary:"Synthetic"})', manifest: {}, expectedActiveVersionId: base, [field]: "client-assertion" })).status).toBe(400);
  expect(fixture.validation).not.toHaveBeenCalled();
  expect(fixture.serviceRpc).not.toHaveBeenCalled();
});
it.each(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"])("fails closed without %s", async key => {
  vi.stubEnv(key, "");
  expect((await save({ source: 'input => ({summary:"Synthetic"})', manifest: {}, expectedActiveVersionId: base })).status).toBe(503);
  expect(fixture.serviceClient).not.toHaveBeenCalled();
  expect(fixture.rpc).not.toHaveBeenCalled();
});
it("does not save when the server validator throws", async () => {
  fixture.validation.mockRejectedValue(new Error("Synthetic validator unavailable"));
  await expect(save({ source: 'input => ({summary:"Synthetic"})', manifest: {}, expectedActiveVersionId: base })).rejects.toThrow("Synthetic validator unavailable");
  expect(fixture.serviceRpc).not.toHaveBeenCalled();
});
it("builtin identity restore remains available without service configuration", async () => {
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
  expect((await save({ restoreTrustedVersionId: id, expectedActiveVersionId: base })).status).toBe(200);
  expect(fixture.serviceClient).not.toHaveBeenCalled();
});

it.each([null, [], "invalid", { sdk: ["balances"] }])("retains rejected raw manifest %j with real validator diagnostics", async manifest => {
  const { validateGeneratedCandidate } = await vi.importActual<typeof import("@/lib/artifacts/validate")>("@/lib/artifacts/validate");
  fixture.validation.mockImplementation(validateGeneratedCandidate);
  const response = await save({ source: 'input => ({summary:"Synthetic"})', manifest, expectedActiveVersionId: base });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: "failed", activeVersionPreserved: base, validation: { ok: false } });
  expect(fixture.serviceRpc).toHaveBeenCalledWith("save_validated_generated_artifact_version", expect.objectContaining({ p_manifest: manifest, p_status: "failed" }));
});
it.each(["x".repeat(32767), "€".repeat(11000)])("rejects oversized raw manifests before validation or persistence", async manifest => {
  expect((await save({ source: "input => ({})", manifest, expectedActiveVersionId: base })).status).toBe(400);
  expect(fixture.validation).not.toHaveBeenCalled();
  expect(fixture.serviceRpc).not.toHaveBeenCalled();
});
it("requires a manifest field even for failed attempts", async () => {
  expect((await save({ source: "input => ({})", expectedActiveVersionId: base })).status).toBe(400);
  expect(fixture.validation).not.toHaveBeenCalled();
});

it("revalidates a generated historical source through the same trusted save boundary", async () => {
  const { validateGeneratedCandidate } = await vi.importActual<typeof import("@/lib/artifacts/validate")>("@/lib/artifacts/validate");
  fixture.validation.mockImplementation(validateGeneratedCandidate);
  const candidate = { source: 'input => ({summary:"Synthetic calculator",rows:[]})', manifest: { kind: "custom_comparison", runtime: "quickjs-calculator-v1", sdk: [], params: {}, renderer: "trusted" }, expectedActiveVersionId: base };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await save(candidate);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "validated", validation: { ok: true } });
  }
  expect(fixture.validation).toHaveBeenCalledTimes(2);
  expect(fixture.serviceRpc).toHaveBeenCalledTimes(2);
  expect(fixture.serviceRpc).toHaveBeenLastCalledWith("save_validated_generated_artifact_version", expect.objectContaining({ p_source: candidate.source, p_manifest: candidate.manifest, p_actor_id: "verified-user", p_status: "validated" }));
});
