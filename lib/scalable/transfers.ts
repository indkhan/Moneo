import { z } from "zod";
import { serviceDb } from "@/lib/bank/server";
import { calendarDate } from "@/lib/finance/calendar";
import type { ScalableMcp } from "./client";
import { toMinor } from "./live";
import { withScalable } from "./server";

// Scalable's own record of money moving in or out of the broker. It lists these as cash rows of type DEPOSIT or WITHDRAWAL;
// a withdrawal that bounced comes back as a deposit with the ID RETURN-<withdrawal id> and the opposite amount.

const PAGE_SIZE = 100, MAX_PAGES = 1000;
const decimal = z.union([z.number().finite(), z.string().regex(/^-?\d+(\.\d+)?$/)]);
const listSchema = z.object({
  page: z.object({ nextCursor: z.string().nullish() }).optional(),
  transactions: z.array(z.object({ id: z.string().min(1), status: z.string().min(1), currency: z.string().nullish(), isCancellation: z.boolean().nullish(), lastEventAt: z.string(), description: z.string().nullish(),
    cash: z.object({ transactionType: z.string().nullish(), amount: decimal.nullish() }).nullish() })).default([]),
});

export type TransferRow = { provider_id: string; type: "DEPOSIT" | "WITHDRAWAL"; amount_minor: string; currency_code: string; occurred_at: string; on_date: string; status: string; is_cancellation: boolean; description: string | null; returns_provider_id: string | null };
const RETURN = "RETURN-";

/** The transfers in one reply of list_portfolio_transactions. Other cash rows, like interest and tax, are real changes and not transfers. */
export function transferRows(reply: unknown, timeZone: string): TransferRow[] {
  return listSchema.parse(reply).transactions.flatMap(row => {
    const type = row.cash?.transactionType;
    if ((type !== "DEPOSIT" && type !== "WITHDRAWAL") || row.cash?.amount == null) return [];
    const currency = row.currency ?? "EUR", amount = toMinor(row.cash.amount, currency);
    if (amount === "0") return [];
    return [{ provider_id: row.id, type, amount_minor: amount, currency_code: currency, occurred_at: row.lastEventAt, on_date: calendarDate(row.lastEventAt, timeZone), status: row.status,
      is_cancellation: row.isCancellation === true, description: row.description?.slice(0, 500) ?? null, returns_provider_id: row.id.startsWith(RETURN) ? row.id.slice(RETURN.length) : null }];
  });
}

/** Every transfer, from the list only: no price charts or per-trade detail calls, so it is cheap to run once after connecting. */
export async function readAllTransfers(mcp: Pick<ScalableMcp, "callTool">, timeZone: string) {
  const rows = new Map<string, TransferRow>();
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page === MAX_PAGES) throw new Error("Scalable transactions never finished paging");
    const reply = await mcp.callTool("list_portfolio_transactions", { pageSize: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
    for (const row of transferRows(reply, timeZone)) rows.set(row.provider_id, row);
    cursor = listSchema.parse(reply).page?.nextCursor || undefined;
    if (!cursor) return [...rows.values()];
  }
}

export async function saveTransfers(connectionId: string, rows: TransferRow[], complete: boolean) {
  const { error } = await serviceDb().rpc("save_scalable_transfers", { p_connection_id: connectionId, p_rows: rows, p_complete: complete });
  if (error) throw new Error(error.message);
}

/** The whole list once per connection, so a connection made before transfers were saved gets its past ones without rebuilding the chart. */
export async function backfillScalableTransfers(connection: { id: string; workspace_id: string }, timeZone: string) {
  const rows = await withScalable(connection.id, connection.workspace_id, mcp => readAllTransfers(mcp, timeZone));
  await saveTransfers(connection.id, rows, true);
  return rows.length;
}
