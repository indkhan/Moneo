import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

const minor = z.string().regex(/^\d{1,19}$/).refine(value => BigInt(value) <= 9223372036854775807n, "Amount exceeds supported integer range");
export const pendingSettlementSchema = z.object({
  pendingId: z.uuid(), pendingVersion: z.number().int().min(0).max(2147483647),
  expectedReleasedMinor: minor, releasedMinor: minor.refine(value => BigInt(value) > 0n, "Release must be positive"),
  note: z.string().trim().min(1).max(500), requestId: z.uuid(),
}).strict();

export type PendingResolution = { id: string; released_minor: string; operation: string; note: string; undone_at: string | null };
export function releasedPendingMinor(resolutions: PendingResolution[]): bigint {
  return resolutions.reduce((total, row) => total + (row.undone_at ? 0n : BigInt(row.released_minor)), 0n);
}

export async function loadPendingResolutions(db: SupabaseClient, workspaceId: string, pendingId: string): Promise<PendingResolution[]> {
  const rows: PendingResolution[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await db.from("pending_hold_resolutions").select("id, released_minor::text, operation, note, undone_at")
      .eq("workspace_id", workspaceId).eq("pending_transaction_id", pendingId).order("id").range(offset, offset + 499);
    if (page.error) throw page.error;
    rows.push(...page.data as PendingResolution[]);
    if (page.data.length < 500) return rows;
  }
}
