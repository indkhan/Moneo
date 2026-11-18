import type { ReadonlyDb } from "@/lib/database";
import type { AiDataScope, WorkspaceSettings } from "@/lib/workspace-settings";

export type FinanceContext = {
  supabase: ReadonlyDb;
  workspace: { id: string; display_currency: string; timezone: string };
  settings: Pick<WorkspaceSettings, "timezone" | "ai_data_scopes">;
};
export type ScopeGuard = (...scopes: AiDataScope[]) => void;
export type GuardedFinanceContext = FinanceContext & { requireScopes: ScopeGuard };
