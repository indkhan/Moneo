import { firstSyncedOn, loadWealthEvents, scalableKnownIds, valuationHistory } from "@/app/money/wealth/net-worth";
import { serviceDb } from "@/lib/bank/server";
import { loadWealthItems } from "@/lib/finance/wealth";
import { calculateHistory, readHistoryInput } from "./history";
import type { ScalableExtras } from "./portfolio";
import { withScalable } from "./server";

/**
 * One try at a connection's calculated history. Separate from syncScalable, so it can't slow down or fail a sync.
 * A failed try saves nothing and leaves any earlier days in place; the reason stays on the connection, out of the owner's way.
 */
export async function rebuildScalableHistory(connection: { id: string; workspace_id: string; portfolio: unknown }, timeZone: string, today: string): Promise<"saved" | "failed" | "skipped"> {
  const db = serviceDb();
  const [events, items] = await Promise.all([loadWealthEvents(db, connection.workspace_id), loadWealthItems(db, connection.workspace_id, true)]);
  const before = firstSyncedOn(valuationHistory(events, items), scalableKnownIds([connection.portfolio as ScalableExtras | null]));
  // Nothing has synced yet, so there is no date to stop before. The next run tries again.
  if (!before) return "skipped";
  const failed = async (reason: string) => {
    const saved = await db.from("scalable_connections").update({ history_status: "failed", history_checked_on: today, history_error: reason.slice(0, 1000) }).eq("id", connection.id);
    if (saved.error) throw new Error(saved.error.message);
    return "failed" as const;
  };
  try {
    const result = calculateHistory(await withScalable(connection.id, connection.workspace_id, mcp => readHistoryInput(mcp, timeZone, before)));
    if (!result.ok) return await failed(result.reason);
    const saved = await db.rpc("replace_scalable_value_history", { p_connection_id: connection.id, p_checked_on: today,
      p_rows: result.days.map(day => ({ on_date: day.date, currency_code: "EUR", securities_minor: day.securitiesMinor.toString(), crypto_minor: day.cryptoMinor.toString(), cash_minor: day.cashMinor.toString(), total_minor: day.totalMinor.toString() })) });
    if (saved.error) throw new Error(saved.error.message);
    return "saved";
  } catch (error) {
    return failed(error instanceof Error ? error.message : "Scalable could not be read");
  }
}
