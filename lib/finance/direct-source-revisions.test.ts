import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { requireWorkspace } from "@/lib/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import { settingsSchema } from "@/lib/settings";
import { listAccounts, listGoals } from "./tools";
import { loadInvestigationEntities } from "./investigation-reader";
import { captureToolEvidence } from "./capture-evidence";
import { readEvidenceView } from "./evidence-view";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-01T12:00:00Z")); });
afterEach(() => vi.useRealTimers());

it.each(["goals_list", "accounts_list", "finance_entities"])("retains actual source revisions through %s capture and replay", async name => {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  let version = 1;
  let retained: unknown;
  const db = { from: (table: string) => {
    let columns = "";
    const filters = new Map<string, unknown>();
    const result = () => {
      const records = table === "accounts" ? [{ id: "cash", name: "Cash", type: "checking", currency_code: "EUR", version }] :
        table === "goals" ? [{ id: "goal", name: "Goal", target_minor: "500", currency_code: "EUR", target_date: null, status: "active", version }] :
        table === "financial_evidence_receipts" ? [{ receipt: retained }] : [];
      return { data: records.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => columns.split(",").map(column => column.trim().split("::")[0]).includes(key)))), error: null };
    };
    const query = { select: (selected: string) => { columns = selected; return query; }, eq: (key: string, value: unknown) => { filters.set(key, value); return query; }, order: () => query,
      range: async (from: number, to: number) => ({ ...result(), data: result().data.slice(from, to + 1) }),
      maybeSingle: async () => ({ ...result(), data: result().data[0] ?? null }),
      insert: async (row: { receipt: unknown; workspace_id: string }) => { expect(row.workspace_id).toBe(workspaceId); retained = row.receipt; return { error: null }; },
      then: (resolve: (value: ReturnType<typeof result>) => unknown) => { expect(filters.get("workspace_id")).toBe(workspaceId); return Promise.resolve(result()).then(resolve); } };
    return query;
  } } as unknown as SupabaseClient;
  const context = { supabase: db, workspace: { id: workspaceId, timezone: "UTC" }, settings: settingsSchema.parse({ ai_data_scopes: ["accounts", "transactions", "planning"] }) } as Awaited<ReturnType<typeof requireWorkspace>>;
  const original = name === "goals_list" ? await listGoals(context) : name === "accounts_list" ? await listAccounts(context) : await loadInvestigationEntities(context);
  const [receipt] = await captureToolEvidence(name, {}, original, context, db);
  expect((await readEvidenceView(context, receipt.id))?.freshness.status).toBe("current");
  version = 2;
  const view = await readEvidenceView(context, receipt.id);
  expect(view?.freshness.status).toBe("stale");
  expect(view?.supportingRecords[0].record).toEqual(original);
  if (name === "goals_list") expect(view?.receipt.metrics[0].valueMinor).toBe("500");
});
