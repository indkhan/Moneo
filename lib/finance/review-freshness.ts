import { createHash } from "node:crypto";
import type { Db } from "@/lib/database";
import type { WorkspaceSettings } from "@/lib/workspace-settings";
import { loadFinancialReviewEvidence } from "./review-loader";
import {readEvidenceView} from "./evidence-view";
import type {GuardedFinanceContext, ScopeGuard} from "./finance-context";
import {z} from "zod";

const COMPARISON_SCOPES = ["accounts", "transactions"] as const;

export type ReviewFreshness = { status: "current" | "stale" | "unknown"; reason: string };
const NOT_COMPARABLE: ReviewFreshness = { status: "unknown", reason: "Current evidence could not be compared. Check data access and financial inputs before relying on this historical review." };

function fingerprint(value: unknown): string {
  function normalize(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item)
      .filter(([key]) => !["evaluatedAt", "evaluated_at", "capturedAt", "verification", "calculationEvidence"].includes(key))
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)]));
    return item;
  }
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

export function compareReviewEvidence(saved: unknown, current: unknown): ReviewFreshness {
  if (!saved || typeof saved !== "object") return { status: "unknown", reason: "This historical review has no comparable saved evidence." };
  return fingerprint(saved) === fingerprint(current)
    ? { status: "current", reason: "Saved evidence matches the current financial evidence and review period." }
    : { status: "stale", reason: "Financial evidence, permissions or the review period have changed. Run a new review for current findings." };
}

export async function reviewFreshness(db: Db, workspace: { id: string; display_currency: string; timezone: string }, saved: unknown, settings: WorkspaceSettings, requireScopes: ScopeGuard, now: Date): Promise<ReviewFreshness> {
  try {
    if (!COMPARISON_SCOPES.every(scope => settings.ai_data_scopes.includes(scope))) return NOT_COMPARABLE;
    if (saved && typeof saved === "object" && "reviewInvestigation" in saved) {
      const metadata = z.object({verification: z.object({receiptIds: z.array(z.uuid()).min(1).max(12)})}).parse(saved);
      const context: GuardedFinanceContext = {supabase: db, workspace, settings, requireScopes};
      const statuses: ReviewFreshness["status"][] = [];
      for (const id of new Set(metadata.verification.receiptIds)) {
        const view = await readEvidenceView(context, id);
        statuses.push(view?.freshness.status ?? "unknown");
      }
      if (statuses.includes("stale")) return {status: "stale", reason: "Sources or calculation rules changed for at least one retained query. The saved review remains historical."};
      if (statuses.includes("unknown")) return {status: "unknown", reason: "Some retained query evidence could not be checked with current access."};
      return {status: "current", reason: "Current source versions and calculation rules match each retained dated query."};
    }
    return compareReviewEvidence(saved, await loadFinancialReviewEvidence(db, workspace, {timezone: settings.timezone, scopes: settings.ai_data_scopes, now}));
  } catch {
    return NOT_COMPARABLE;
  }
}
