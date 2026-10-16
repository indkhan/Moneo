import { beforeEach, expect, it, vi } from "vitest";
import { applyProposal, decideProposals } from "./apply";
import { loadOrganizationSuggestions } from "@/lib/import-organization-loader";
import { saveCandidateVersion } from "@/lib/artifacts/save-version";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
vi.mock("@/lib/import-organization-loader", () => ({ loadOrganizationSuggestions: vi.fn() }));
vi.mock("@/lib/artifacts/save-version", () => ({ saveCandidateVersion: vi.fn(async () => ({ configured: true, status: "validated", error: null })) }));

type Call = { kind: "rpc" | "update" | "insert"; name: string; args: unknown; filters: unknown[][] };
function fakeContext(options: { rpc?: Record<string, { data?: unknown; error?: { message: string; code?: string } | null }>; claim?: unknown; insertError?: { message: string; code?: string } } = {}) {
  const calls: Call[] = [];
  const supabase = {
    rpc: async (name: string, args: unknown) => { calls.push({ kind: "rpc", name, args, filters: [] }); return options.rpc?.[name] ?? { data: null, error: null }; },
    from: (table: string) => {
      const filters: unknown[][] = [];
      let write: Call | undefined;
      const query = {
        select: () => query, eq: (...args: unknown[]) => { filters.push(["eq", ...args]); return query; }, in: (...args: unknown[]) => { filters.push(["in", ...args]); return query; },
        update: (args: unknown) => { write = { kind: "update", name: table, args, filters }; calls.push(write); return query; },
        insert: async (args: unknown) => { calls.push({ kind: "insert", name: table, args, filters }); return { error: options.insertError ?? null }; },
        maybeSingle: async () => ({ data: table === "categories" ? { id: id(60) } : write && (write.args as { status: string }).status === "applying" ? options.claim ?? null : { id: "x" }, error: null }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
      };
      return query;
    },
  };
  return { calls, context: { supabase, workspace: { id: id(1), timezone: "Europe/Berlin" }, user: { id: id(2) } } as never };
}
beforeEach(() => vi.clearAllMocks());

const categorize = { rows: [{ id: id(10), version: 3 }], patch: { category_id: id(60) }, merchantName: null, ruleKey: "cafe luna", evidence: [{ id: id(11), version: 1 }] };

it("accepts a categorization through the audited organization review and saves its rule", async () => {
  vi.mocked(loadOrganizationSuggestions).mockResolvedValue({ proposals: [{ evidence: [{ id: id(11), version: 2 }] }] } as never);
  const { calls, context } = fakeContext({ rpc: { create_organization_review: { data: { id: id(70) }, error: null } } });
  const result = await applyProposal(context, { id: id(5), kind: "categorize", payload: categorize });
  expect(calls.map(call => call.name)).toEqual(["create_organization_review", "apply_organization_review"]);
  // Fresh evidence versions, the proposal id as idempotency key, and the rule saved.
  expect(calls[0].args).toMatchObject({ p_rows: categorize.rows, p_patch: categorize.patch, p_rule_key: "cafe luna", p_evidence: [{ id: id(11), version: 2 }], p_request_id: id(5) });
  expect(calls[1].args).toEqual({ p_review_id: id(70), p_save_rule: true });
  expect(result.href).toBe(`/money/organization?review=${id(70)}`);
});

it("refuses a categorization when a person corrected the rows after the agent ran", async () => {
  vi.mocked(loadOrganizationSuggestions).mockResolvedValue({ proposals: [] } as never);
  const { calls, context } = fakeContext();
  await expect(applyProposal(context, { id: id(5), kind: "categorize", payload: categorize })).rejects.toThrow("corrected");
  expect(calls).toEqual([]);
});

it("confirms a recurring schedule with the versioned evidence the user reviewed", async () => {
  const { calls, context } = fakeContext();
  const payload = { accountId: id(20), label: "Gym", cadence: "monthly", currencyCode: "EUR", evidence: [1, 2, 3].map(n => ({ id: id(n + 30), version: 1 })), runAnchorId: id(31), evidenceLimited: false };
  await applyProposal(context, { id: id(5), kind: "recurring", payload });
  expect(calls[0]).toMatchObject({ name: "review_recurring_series_versions", args: { p_decision: "confirmed", p_evidence: payload.evidence, p_run_anchor_id: id(31) } });
});

it("creates a category limit in exact minor units and rejects invalid payloads", async () => {
  const { calls, context } = fakeContext();
  await applyProposal(context, { id: id(5), kind: "budget", payload: { categoryId: id(60), currencyCode: "EUR", limitMinor: "21000" } });
  expect(calls.find(call => call.kind === "insert")).toMatchObject({ name: "spending_plans", args: { category_id: id(60), currency_code: "EUR", limit_minor: "21000", enabled: true } });
  await expect(applyProposal(context, { id: id(5), kind: "budget", payload: { categoryId: id(60), currencyCode: "EUR", limitMinor: "12.50" } })).rejects.toThrow();
});

it("builds tools through the validated sandbox save with tailored defaults", async () => {
  const { context } = fakeContext({ rpc: { create_trusted_artifact: { data: { id: id(80), permissions: [], active_version_id: null }, error: null } } });
  const result = await applyProposal(context, { id: id(5), kind: "tool", payload: { template: "budget-tracker", name: "Agent budget", params: { monthlyBudgetMinor: 21000, unknown: 3 } } });
  const manifest = vi.mocked(saveCandidateVersion).mock.calls[0][0].manifest as { params: Record<string, { default: number }> };
  expect(manifest.params.monthlyBudgetMinor.default).toBe(21000);
  expect(manifest.params).not.toHaveProperty("unknown");
  expect(result.href).toBe(`/ai/library/${id(80)}`);
  vi.mocked(saveCandidateVersion).mockResolvedValueOnce({ configured: true, status: "failed", error: null } as never);
  await expect(applyProposal(context, { id: id(5), kind: "tool", payload: { template: "savings-rate", name: "Rate", params: {} } })).rejects.toThrow("sandbox");
});

it("claims before applying, records failures, and rejecting writes nothing canonical", async () => {
  const claimed = fakeContext({ claim: { id: id(5), kind: "budget", payload: { categoryId: id(60), currencyCode: "EUR", limitMinor: "21000" } }, insertError: { message: "dup", code: "23505" } });
  expect(await decideProposals(claimed.context, [id(5)], "accept")).toEqual([{ id: id(5), status: "failed", error: expect.stringContaining("already exists") }]);
  expect(claimed.calls.filter(call => call.kind === "update").map(call => (call.args as { status: string }).status)).toEqual(["applying", "failed"]);
  const unclaimed = fakeContext();
  expect(await decideProposals(unclaimed.context, [id(6)], "accept")).toEqual([{ id: id(6), status: "unchanged" }]);
  expect(unclaimed.calls.some(call => call.kind === "insert" || call.kind === "rpc")).toBe(false);
  const rejected = fakeContext();
  expect(await decideProposals(rejected.context, [id(7)], "reject")).toEqual([{ id: id(7), status: "rejected" }]);
  expect(rejected.calls.map(call => call.name)).toEqual(["agent_proposals"]);
});
