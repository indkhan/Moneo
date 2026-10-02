import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadWorkspaceSettings, requireAiScope, type WorkspaceSettings } from "@/lib/settings";
import { loadFinancialReviewEvidence } from "./review-loader";

export type ReviewFreshness = { status: "current" | "stale" | "unknown"; reason: string };

function fingerprint(value: unknown): string {
  function normalize(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item)
      .filter(([key]) => key !== "evaluatedAt" && key !== "evaluated_at")
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

export async function reviewFreshness(db: SupabaseClient, workspace: { id: string; display_currency: string; timezone: string }, saved: unknown, suppliedSettings?: WorkspaceSettings): Promise<ReviewFreshness> {
  try {
    const settings = suppliedSettings ?? await loadWorkspaceSettings(db, workspace.id);
    requireAiScope(settings, "accounts", "transactions");
    return compareReviewEvidence(saved, await loadFinancialReviewEvidence(db, workspace, settings));
  } catch {
    return { status: "unknown", reason: "Current evidence could not be compared. Check data access and financial inputs before relying on this historical review." };
  }
}
