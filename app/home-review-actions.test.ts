import { beforeEach, expect, it, vi } from "vitest";
import { categorizeGroups } from "./home-review-actions";

const fixture = vi.hoisted(() => ({ rpc: vi.fn(), suggestions: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ supabase: { rpc: fixture.rpc }, workspace: { id: "owned" } }) }));
vi.mock("@/lib/import/organization-loader", () => ({ loadOrganizationSuggestions: fixture.suggestions }));
vi.mock("@/lib/finance/iou", () => ({ loadLoanPayoutIds: vi.fn() }));

const row = { id: "00000000-0000-4000-8000-000000000001", version: 1 };
const group = { rows: [row], categoryId: "00000000-0000-4000-8000-000000000002", key: "coffee shop" };

beforeEach(() => {
  fixture.rpc.mockReset().mockResolvedValue({ data: { id: "review" }, error: null });
  fixture.suggestions.mockReset().mockResolvedValue({ proposals: [{ transactionId: row.id, version: 1, descriptionKey: "coffee shop", evidence: [] }] });
});

it("saves no rule unless the person asks for future entries", async () => {
  expect(await categorizeGroups([group])).toEqual({ applied: { "coffee shop": 1 }, error: undefined });
  expect(fixture.rpc).toHaveBeenCalledWith("create_organization_review", expect.objectContaining({ p_rule_key: null }));
  expect(fixture.rpc).toHaveBeenCalledWith("apply_organization_review", { p_review_id: "review", p_save_rule: false });
});

it("saves the rule when asked", async () => {
  await categorizeGroups([group], true);
  expect(fixture.rpc).toHaveBeenCalledWith("create_organization_review", expect.objectContaining({ p_rule_key: "coffee shop" }));
  expect(fixture.rpc).toHaveBeenCalledWith("apply_organization_review", { p_review_id: "review", p_save_rule: true });
});
