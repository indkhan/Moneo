import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { evidenceFingerprint, createEvidenceReceipt, evidenceFreshness, persistEvidenceReceipt, loadEvidenceReceipt } from "./evidence-receipts";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const input = { workspaceId, fetchedAt: "2026-10-01T00:00:00Z", calculationVersion: "cashflow-v1", sourceVersion: "v1", query: { type: "cashflow", from: "2026-09-01", to: "2026-09-30" }, scopes: ["transactions" as const],
  sources: [{ id: "00000000-0000-4000-8000-000000000003", type: "transaction" as const, version: "v1", record: { amount_minor: "-25", review_reasons: [] } }],
  metrics: [{ id: "spending", label: "Spending", valueMinor: "25", currency: "EUR", period: { from: "2026-09-01", to: "2026-09-30" }, qualifiers: [], sourceIds: ["00000000-0000-4000-8000-000000000003"], calculation: "sum reviewed posted spending less refunds" }],
};
describe("immutable financial query receipts", () => {
  it("derives stable owned IDs and actual source links, preserving all query inputs and versions", () => {
    const saved = createEvidenceReceipt(input);
    expect(saved.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(saved.sources[0].href).toBe(`/money/transactions?transaction=${input.sources[0].id}`);
    expect(saved.query).toEqual(input.query);
    expect(saved.sources[0].record).toEqual(input.sources[0].record);
    expect(createEvidenceReceipt({ ...input, fetchedAt: "2026-10-02T00:00:00Z" }).id).toBe(saved.id);
    expect(createEvidenceReceipt({ ...input, workspaceId: "00000000-0000-4000-8000-000000000004" }).id).not.toBe(saved.id);
    expect(createEvidenceReceipt({ ...input, sourceVersion: "v2" }).id).not.toBe(saved.id);
  });
  it("does not invent links or drop duplicate, nonexistent or unsafe metrics", () => {
    expect(() => createEvidenceReceipt({ ...input, sources: [{ ...input.sources[0], href: "/invented" }] })).toThrow();
    expect(() => createEvidenceReceipt({ ...input, metrics: [{ ...input.metrics[0], sourceIds: ["missing"] }] })).toThrow();
    expect(() => createEvidenceReceipt({ ...input, metrics: [input.metrics[0], input.metrics[0]] })).toThrow();
    expect(() => createEvidenceReceipt({ ...input, metrics: [{ ...input.metrics[0], valueMinor: 9007199254740992 }] })).toThrow();
  });
  it("marks calculation, sources, corrections, new rows and coverage changes stale without modifying history", () => {
    const saved = createEvidenceReceipt(input);
    expect(evidenceFreshness(saved, saved.sourceVersion, saved.calculationVersion).status).toBe("current");
    expect(evidenceFreshness(saved, "v2", saved.calculationVersion).status).toBe("stale");
    expect(evidenceFreshness(saved, saved.sourceVersion, "cashflow-v2").status).toBe("stale");
    expect(evidenceFreshness(saved, null, saved.calculationVersion).status).toBe("unknown");
    for (const source of [{ ...input.sources[0], version: "v2" }, { ...input.sources[0], record: { amount_minor: "-26", review_reasons: [] } }]) expect(evidenceFingerprint([source])).not.toBe(evidenceFingerprint(input.sources));
    expect(saved.sources[0].record).toEqual(input.sources[0].record);
  });
  it("inserts immutable receipts and verifies idempotent collision reads are owned", async () => {
    const saved = createEvidenceReceipt(input);
    const insert = vi.fn().mockResolvedValue({ error: { code: "23505" } });
    const filters: [string, string][] = [];
    const query = { select: () => query, eq: (key: string, value: string) => { filters.push([key, value]); return query; }, maybeSingle: async () => ({ data: { receipt: saved }, error: null }), insert };
    const db = { from: () => query } as unknown as SupabaseClient;
    await expect(persistEvidenceReceipt(db, saved)).resolves.toEqual(saved);
    expect(filters).toContainEqual(["workspace_id", workspaceId]);
    expect(insert).toHaveBeenCalledOnce();
    const foreignQuery = { select: () => foreignQuery, eq: () => foreignQuery, maybeSingle: async () => ({ data: { receipt: { ...saved, workspaceId: "00000000-0000-4000-8000-000000000004" } }, error: null }) };
    const foreignDb = { from: () => foreignQuery } as unknown as SupabaseClient;
    await expect(loadEvidenceReceipt(foreignDb, workspaceId, saved.id)).rejects.toThrow();
  });
});
