import type { Db } from "@/lib/database";
import type { AiDataScope, WorkspaceSettings } from "@/lib/settings";

export type FinanceContext = {
  supabase: Db;
  workspace: { id: string; display_currency: string; timezone: string };
  settings: Pick<WorkspaceSettings, "timezone" | "ai_data_scopes">;
};
export type ScopeGuard = (...scopes: AiDataScope[]) => void;
export type GuardedFinanceContext = FinanceContext & { requireScopes: ScopeGuard };
