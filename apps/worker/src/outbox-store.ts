import type { OutboxEventRow, OutboxStore } from "./outbox.js";

type Queryable = {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
};

function row(value: Record<string, unknown>): OutboxEventRow {
  if (
    typeof value.id !== "string" ||
    typeof value.workspace_id !== "string" ||
    typeof value.aggregate_type !== "string" ||
    typeof value.aggregate_id !== "string" ||
    typeof value.event_type !== "string" ||
    typeof value.attempts !== "number" ||
    typeof value.payload !== "object" ||
    value.payload === null ||
    Array.isArray(value.payload)
  )
    throw new Error("Outbox query returned an invalid row.");
  return {
    id: value.id,
    workspaceId: value.workspace_id,
    aggregateType: value.aggregate_type,
    aggregateId: value.aggregate_id,
    eventType: value.event_type,
    payload: value.payload as Record<string, unknown>,
    attempts: value.attempts,
  };
}

/** PostgreSQL claim store with a bounded lease for crash recovery. */
export function createPgOutboxStore(pool: Queryable): OutboxStore {
  return {
    async claim(limit) {
      const result = await pool.query("SELECT * FROM claim_outbox_events($1)", [limit]);
      return result.rows.map((value) => row(value as Record<string, unknown>));
    },
    async markPublished(ids) {
      if (ids.length === 0) return;
      await pool.query("SELECT mark_outbox_events_published($1::uuid[])", [ids]);
    },
    async markDispatchError(id, message) {
      await pool.query("SELECT retry_outbox_event($1::uuid, $2::text)", [id, message]);
    },
  };
}
